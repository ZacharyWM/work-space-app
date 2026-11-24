// shuttle race (holotable game): per-room lobby + race state and the course
// generator. Like state.go, all access is serialized by main's global state
// mutex — this file assumes the caller holds it
package main

import (
	"math"
	"math/rand"
)

const (
	// the start grid (and comms sanity) caps the lobby
	raceMaxMembers = 6
	// gates in the loop around the ship
	raceGateCount = 8
	// countdown between the raceStarted broadcast and GO; the race clock
	// starts this far after the broadcast (shared RACE_COUNTDOWN_MS)
	raceCountdownMs = 3000
	// hard stop: a race older than this is ended by the sweep, DNFing
	// whoever is still out (an AFK racer must not wedge the lobby forever)
	raceMaxDurationMs = 5 * 60 * 1000
	// joining requires standing within this range of a game table
	tableJoinRadius = 90.0
	// how far outside the floors' bounding box the gate loop runs
	raceCourseMargin = 380.0
	// smallest loop radii, so a tiny map still gets a flyable course
	raceCourseMinRx = 700.0
	raceCourseMinRy = 500.0
	// minimum distance between two random gates, so their rings (client
	// GATE_RADIUS 70) never overlap or read as one gate
	raceGateMinSpacing = 250.0
	// minimum distance from the grid base to every gate: the gate spacing
	// plus the widest grid's half-spread, so no slot spawns inside a ring
	raceStartClearance = 450.0
	// start-grid spacing between racers, perpendicular to the racing line
	raceGridSpacing = 70.0
)

// a finisher's standing, assigned in arrival order
type raceFinish struct {
	place  int
	timeMs float64
}

// one room's shuttle race: a lobby (racing false) that becomes a running race
// (racing true). nil on roomState means an empty idle lobby
type raceState struct {
	// lobby members in join order; during a race, the racers
	order []string
	// ready flags keyed by member id
	ready  map[string]bool
	racing bool
	// the gate loop, fixed at start (map edits mid-race don't move it)
	gates []Point
	// race clock zero: the start broadcast plus the countdown
	startedAt int64
	// gates passed per still-running racer; leaving the map removes the entry
	progress map[string]int
	// finished racers by id
	finished map[string]raceFinish
	// display names captured at start, so results survive departures
	names map[string]string
	// clerk user ids captured at start, so a finisher's best time can be
	// recorded even if their session is gone by race end (leaderboard)
	userIDs map[string]string
	// startedAt + raceMaxDurationMs, checked by the sweep
	deadline int64
}

// the lobby (or racer) list as the wire carries it; names come from the live
// sessions so renames show, falling back to the start-time capture
func (r *roomState) raceMembers() []RaceMember {
	out := []RaceMember{}
	if r.race == nil {
		return out
	}
	for _, id := range r.race.order {
		name := r.race.names[id]
		if s := r.sessions[id]; s != nil {
			name = s.player.Name
		}
		if name == "" {
			continue
		}
		out = append(out, RaceMember{ID: id, Name: name, Ready: r.race.ready[id]})
	}
	return out
}

// the welcome's race snapshot; gates ride only while a race runs
func (r *roomState) raceSnapshot() RaceSnapshot {
	snap := RaceSnapshot{Racing: false, Members: r.raceMembers(), Gates: []Point{}}
	if r.race != nil && r.race.racing {
		snap.Racing = true
		snap.Gates = r.race.gates
	}
	return snap
}

// add a player to the lobby; returns a raceRejected reason or "" on success
// (an existing member re-joining is a no-op success)
func (r *roomState) raceJoin(id string) string {
	if r.race != nil && r.race.racing {
		return "raceInProgress"
	}
	if r.race == nil {
		r.race = &raceState{ready: map[string]bool{}, names: map[string]string{}, userIDs: map[string]string{}}
	}
	if raceHas(r.race.order, id) {
		return ""
	}
	if len(r.race.order) >= raceMaxMembers {
		return "lobbyFull"
	}
	r.race.order = append(r.race.order, id)
	r.race.ready[id] = false
	return ""
}

// flip a member's ready flag; returns a raceRejected reason or ""
func (r *roomState) raceSetReady(id string, on bool) string {
	if r.race == nil || r.race.racing || !raceHas(r.race.order, id) {
		return "notInLobby"
	}
	r.race.ready[id] = on
	return ""
}

// why the race can't start yet, or "" when it can: the sender must be a
// member and every member must be ready
func (r *roomState) raceStartDenial(id string) string {
	if r.race == nil {
		return "notInLobby"
	}
	if r.race.racing {
		return "raceInProgress"
	}
	if !raceHas(r.race.order, id) {
		return "notInLobby"
	}
	for _, m := range r.race.order {
		if !r.race.ready[m] {
			return "notAllReady"
		}
	}
	return ""
}

// remove a player from the lobby (pre-race); true when they were a member
func (r *roomState) raceLobbyDrop(id string) bool {
	if r.race == nil || r.race.racing || !raceHas(r.race.order, id) {
		return false
	}
	r.race.order = raceRemove(r.race.order, id)
	delete(r.race.ready, id)
	// an emptied lobby resets to idle
	if len(r.race.order) == 0 {
		r.race = nil
	}
	return true
}

// record a gate pass; validGate is false for out-of-order or unknown reports
// (dropped), finish is non-nil when this pass crossed the last gate. Reports
// stamped before the race clock are dropped like blastHit's — clients freeze
// through the countdown, so only a doctored client sends one, and a pass
// before the clock would persist a bogus leaderboard time
func (r *roomState) raceRecordProgress(id string, gate int, now int64) (validGate bool, finish *raceFinish) {
	race := r.race
	if race == nil || !race.racing || now < race.startedAt {
		return false, nil
	}
	current, running := race.progress[id]
	// gates are passed strictly one at a time, in order
	if !running || gate != current+1 || gate > len(race.gates) {
		return false, nil
	}
	race.progress[id] = gate
	if gate < len(race.gates) {
		return true, nil
	}
	// crossed the last gate: finished — place is arrival order
	delete(race.progress, id)
	f := raceFinish{place: len(race.finished) + 1, timeMs: float64(now - race.startedAt)}
	race.finished[id] = f
	return true, &f
}

// drop a racer mid-race (quit, disconnect, eviction); true when they were racing
func (r *roomState) raceRacerDrop(id string) bool {
	race := r.race
	if race == nil || !race.racing {
		return false
	}
	if _, running := race.progress[id]; !running {
		return false
	}
	delete(race.progress, id)
	return true
}

// true when nobody is still out on the course (all finished or dropped)
func (r *roomState) raceAllDone() bool {
	return r.race != nil && r.race.racing && len(r.race.progress) == 0
}

// final standings: finishers by place, then DNFs (still-running racers get a
// null time); called before the race is cleared
func (r *roomState) raceResults() []RaceResult {
	race := r.race
	if race == nil {
		return []RaceResult{}
	}
	out := []RaceResult{}
	// finishers in place order — scan order, pick each place in turn
	byPlace := make([]string, len(race.finished))
	for id, f := range race.finished {
		byPlace[f.place-1] = id
	}
	for _, id := range byPlace {
		t := race.finished[id].timeMs
		out = append(out, RaceResult{ID: id, Name: race.names[id], TimeMs: &t})
	}
	for _, id := range race.order {
		if _, ok := race.finished[id]; ok {
			continue
		}
		if _, running := race.progress[id]; !running {
			continue
		}
		out = append(out, RaceResult{ID: id, Name: race.names[id], TimeMs: nil})
	}
	return out
}

// one pending leaderboard write at game end: an account and its score
type scoreEntry struct {
	userID string
	score  float64
}

// the leaderboard writes this race earned — every finisher's time, keyed to
// the clerk account captured at start; called before the race is cleared.
// DNFs have no time and earn nothing
func (r *roomState) raceScoreEntries() []scoreEntry {
	out := []scoreEntry{}
	if r.race == nil {
		return out
	}
	for id, f := range r.race.finished {
		uid := r.race.userIDs[id]
		if uid == "" {
			continue
		}
		out = append(out, scoreEntry{userID: uid, score: f.timeMs})
	}
	return out
}

// small slice helpers (order lists are tiny)
func raceHas(list []string, id string) bool {
	for _, v := range list {
		if v == id {
			return true
		}
	}
	return false
}

func raceRemove(list []string, id string) []string {
	for i, v := range list {
		if v == id {
			return append(list[:i], list[i+1:]...)
		}
	}
	return list
}

// the gate course and start grid for n racers over a layout: raceGateCount
// gates scattered at random (fresh each race) inside the floors' bounding box
// grown by the course margin — over the hull included — and visited in
// placement order. The grid base is its own random point clear of every
// gate, spread perpendicular to the line to gate one, noses toward gate one
func buildRaceCourse(m *MapData, n int) (gates []Point, starts []RaceStart, heading float64) {
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, f := range m.Floors {
		minX = math.Min(minX, f.X)
		minY = math.Min(minY, f.Y)
		maxX = math.Max(maxX, f.X+f.W)
		maxY = math.Max(maxY, f.Y+f.H)
	}
	cx, cy := (minX+maxX)/2, (minY+maxY)/2
	// half-extents of the course box; the min radii keep a tiny map flyable
	hx := math.Max((maxX-minX)/2+raceCourseMargin, raceCourseMinRx)
	hy := math.Max((maxY-minY)/2+raceCourseMargin, raceCourseMinRy)
	gates = make([]Point, raceGateCount)
	for i := range gates {
		// rejection-sample until clear of every placed gate; the box dwarfs
		// eight spaced rings, so the attempt cap is a safety valve only
		for attempt := 0; ; attempt++ {
			p := Point{X: cx + (rand.Float64()*2-1)*hx, Y: cy + (rand.Float64()*2-1)*hy}
			if attempt < 100 && !clearOf(gates[:i], p, raceGateMinSpacing) {
				continue
			}
			gates[i] = p
			break
		}
	}
	// grid base: its own random point clear of every gate, so gate one's
	// bearing and distance differ each race (not welded behind gate one)
	var base Point
	placed := false
	for attempt := 0; attempt < 100 && !placed; attempt++ {
		p := Point{X: cx + (rand.Float64()*2-1)*hx, Y: cy + (rand.Float64()*2-1)*hy}
		if clearOf(gates, p, raceStartClearance) {
			base, placed = p, true
		}
	}
	if !placed {
		// cramped map: the gates' exclusion zones can cover the whole box, so
		// drop the base on a random edge just outside it — one axis alone
		// then guarantees the clearance from every gate
		t := rand.Float64()*2 - 1
		switch rand.Intn(4) {
		case 0:
			base = Point{X: cx - hx - raceStartClearance, Y: cy + t*hy}
		case 1:
			base = Point{X: cx + hx + raceStartClearance, Y: cy + t*hy}
		case 2:
			base = Point{X: cx + t*hx, Y: cy - hy - raceStartClearance}
		default:
			base = Point{X: cx + t*hx, Y: cy + hy + raceStartClearance}
		}
	}
	// noses face gate one for the countdown launch
	heading = math.Atan2(gates[0].Y-base.Y, gates[0].X-base.X)
	// spread racers along the perpendicular, centered on the base point
	px, py := math.Cos(heading+math.Pi/2), math.Sin(heading+math.Pi/2)
	starts = make([]RaceStart, n)
	for k := range starts {
		off := (float64(k) - float64(n-1)/2) * raceGridSpacing
		starts[k] = RaceStart{X: base.X + px*off, Y: base.Y + py*off, A: heading}
	}
	return gates, starts, heading
}

// true when p sits at least minDist from every placed gate
func clearOf(placed []Point, p Point, minDist float64) bool {
	for _, g := range placed {
		if math.Hypot(g.X-p.X, g.Y-p.Y) < minDist {
			return false
		}
	}
	return true
}
