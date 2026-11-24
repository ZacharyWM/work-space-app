// shuttle blasters (holotable game): per-room lobby + match state and the
// arena generator. Like race.go, all access is serialized by main's global
// state mutex — this file assumes the caller holds it
package main

import "math"

const (
	// the spawn ring (and comms sanity) caps the lobby
	blastMaxMembers = 6
	// a fight takes at least two shuttles; solo matches are meaningless
	blastMinMembers = 2
	// countdown between the blastStarted broadcast and the fight; fires and
	// hits stamped before the match clock are refused (shared BLAST_COUNTDOWN_MS)
	blastCountdownMs = 3000
	// hard stop: a match older than this is ended by the sweep — everyone
	// still flying survives (an AFK pair must not wedge the lobby forever)
	blastMaxDurationMs = 5 * 60 * 1000
	// how far outside the floors' bounding box the arena circle reaches
	blastArenaMargin = 380.0
	// smallest arena radius, so a tiny map still gets a flyable arena
	blastArenaMinR = 700.0
	// spawn ring radius as a fraction of the arena radius
	blastSpawnFactor = 0.55
)

// one room's shuttle blasters: a lobby (playing false) that becomes a running
// match (playing true). nil on roomState means an empty idle lobby
type blastState struct {
	// lobby members in join order; during a match, the combatants
	order []string
	// ready flags keyed by member id
	ready   map[string]bool
	playing bool
	// the arena, fixed at start (map edits mid-match don't move it)
	arena BlastArena
	// match clock zero: the start broadcast plus the countdown
	startedAt int64
	// startedAt + blastMaxDurationMs, checked by the sweep
	deadline int64
	// players still flying, keyed by id
	alive map[string]bool
	// destroyed (or forfeited) players in elimination order
	eliminated []string
	// display names captured at start, so results survive departures
	names map[string]string
	// clerk user ids captured at start, so kill counts can be recorded even
	// for players whose session is gone by match end (leaderboard)
	userIDs map[string]string
	// shuttles blasted per player this match; forfeits credit nobody
	kills map[string]int
}

// the lobby (or combatant) list as the wire carries it; names come from the
// live sessions so renames show, falling back to the start-time capture
func (r *roomState) blastMembers() []RaceMember {
	out := []RaceMember{}
	if r.blast == nil {
		return out
	}
	for _, id := range r.blast.order {
		name := r.blast.names[id]
		if s := r.sessions[id]; s != nil {
			name = s.player.Name
		}
		if name == "" {
			continue
		}
		out = append(out, RaceMember{ID: id, Name: name, Ready: r.blast.ready[id]})
	}
	return out
}

// the welcome's blasters snapshot; the arena rides only while a match runs
func (r *roomState) blastSnapshot() BlastSnapshot {
	snap := BlastSnapshot{Playing: false, Members: r.blastMembers(), Arena: nil}
	if r.blast != nil && r.blast.playing {
		snap.Playing = true
		arena := r.blast.arena
		snap.Arena = &arena
	}
	return snap
}

// add a player to the lobby; returns a blastRejected reason or "" on success
// (an existing member re-joining is a no-op success)
func (r *roomState) blastJoin(id string) string {
	if r.blast != nil && r.blast.playing {
		return "matchInProgress"
	}
	if r.blast == nil {
		r.blast = &blastState{ready: map[string]bool{}, names: map[string]string{}, userIDs: map[string]string{}}
	}
	if raceHas(r.blast.order, id) {
		return ""
	}
	if len(r.blast.order) >= blastMaxMembers {
		return "lobbyFull"
	}
	r.blast.order = append(r.blast.order, id)
	r.blast.ready[id] = false
	return ""
}

// flip a member's ready flag; returns a blastRejected reason or ""
func (r *roomState) blastSetReady(id string, on bool) string {
	if r.blast == nil || r.blast.playing || !raceHas(r.blast.order, id) {
		return "notInLobby"
	}
	r.blast.ready[id] = on
	return ""
}

// why the match can't start yet, or "" when it can: the sender must be a
// member, the lobby needs at least two, and every member must be ready
func (r *roomState) blastStartDenial(id string) string {
	if r.blast == nil {
		return "notInLobby"
	}
	if r.blast.playing {
		return "matchInProgress"
	}
	if !raceHas(r.blast.order, id) {
		return "notInLobby"
	}
	if len(r.blast.order) < blastMinMembers {
		return "needTwo"
	}
	for _, m := range r.blast.order {
		if !r.blast.ready[m] {
			return "notAllReady"
		}
	}
	return ""
}

// remove a player from the lobby (pre-match); true when they were a member
func (r *roomState) blastLobbyDrop(id string) bool {
	if r.blast == nil || r.blast.playing || !raceHas(r.blast.order, id) {
		return false
	}
	r.blast.order = raceRemove(r.blast.order, id)
	delete(r.blast.ready, id)
	// an emptied lobby resets to idle
	if len(r.blast.order) == 0 {
		r.blast = nil
	}
	return true
}

// destroy (or forfeit) a still-flying combatant, recording the elimination
// order; false when they weren't alive in a running match
func (r *roomState) blastEliminate(id string) bool {
	blast := r.blast
	if blast == nil || !blast.playing || !blast.alive[id] {
		return false
	}
	delete(blast.alive, id)
	blast.eliminated = append(blast.eliminated, id)
	return true
}

// true when at most one shuttle is still flying — the fight is decided
func (r *roomState) blastAllDone() bool {
	return r.blast != nil && r.blast.playing && len(r.blast.alive) <= 1
}

// final standings, winner first: survivors in join order (exactly one unless
// the time cap hit), then the eliminated in reverse elimination order — the
// longer you lasted, the higher you place. Called before the match is cleared
func (r *roomState) blastResults() []BlastResult {
	blast := r.blast
	if blast == nil {
		return []BlastResult{}
	}
	out := []BlastResult{}
	for _, id := range blast.order {
		if blast.alive[id] {
			out = append(out, BlastResult{ID: id, Name: blast.names[id], Survived: true})
		}
	}
	for i := len(blast.eliminated) - 1; i >= 0; i-- {
		id := blast.eliminated[i]
		out = append(out, BlastResult{ID: id, Name: blast.names[id], Survived: false})
	}
	return out
}

// the leaderboard writes this match earned — every player's kill count, keyed
// to the clerk account captured at start; called before the match is cleared.
// Zero kills is not a score
func (r *roomState) blastScoreEntries() []scoreEntry {
	out := []scoreEntry{}
	if r.blast == nil {
		return out
	}
	for id, kills := range r.blast.kills {
		uid := r.blast.userIDs[id]
		if uid == "" || kills == 0 {
			continue
		}
		out = append(out, scoreEntry{userID: uid, score: float64(kills)})
	}
	return out
}

// the arena and spawn ring for n combatants over a layout: a circle around
// the floors' bounding box, players spread evenly on an inner ring starting
// at the top, noses toward the center
func buildBlastArena(m *MapData, n int) (arena BlastArena, starts []RaceStart) {
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, f := range m.Floors {
		minX = math.Min(minX, f.X)
		minY = math.Min(minY, f.Y)
		maxX = math.Max(maxX, f.X+f.W)
		maxY = math.Max(maxY, f.Y+f.H)
	}
	cx, cy := (minX+maxX)/2, (minY+maxY)/2
	// the circle must clear the hull's corners, not just its edges
	r := math.Max(math.Hypot(maxX-minX, maxY-minY)/2+blastArenaMargin, blastArenaMinR)
	arena = BlastArena{X: cx, Y: cy, R: r}
	ring := r * blastSpawnFactor
	starts = make([]RaceStart, n)
	for k := range starts {
		a := -math.Pi/2 + float64(k)*2*math.Pi/float64(n)
		x, y := cx+ring*math.Cos(a), cy+ring*math.Sin(a)
		starts[k] = RaceStart{X: x, Y: y, A: math.Atan2(cy-y, cx-x)}
	}
	return arena, starts
}
