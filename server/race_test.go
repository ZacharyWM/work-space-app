// unit tests for the shuttle race state machine + course generator
package main

import (
	"math"
	"testing"
)

// a one-plate layout for course generation
func raceTestMap() *MapData {
	return &MapData{
		Floors: []Floor{{Rect: Rect{X: 0, Y: 0, W: 400, H: 300}, R: 12}},
		Zones:  []Zone{},
		Spawn:  Point{X: 50, Y: 50},
	}
}

// join n players and seat them all in the lobby
func lobbyOf(t *testing.T, r *roomState, names ...string) []*Player {
	t.Helper()
	players := make([]*Player, len(names))
	for i, n := range names {
		players[i] = joinNamed(r, n)
		if reason := r.raceJoin(players[i].ID); reason != "" {
			t.Fatalf("join %s refused: %s", n, reason)
		}
	}
	return players
}

// ready everyone up and flip the lobby into a running race, like handleRaceStart
func startRace(t *testing.T, r *roomState, players []*Player) {
	t.Helper()
	for _, p := range players {
		if reason := r.raceSetReady(p.ID, true); reason != "" {
			t.Fatalf("ready refused: %s", reason)
		}
	}
	if reason := r.raceStartDenial(players[0].ID); reason != "" {
		t.Fatalf("start refused: %s", reason)
	}
	gates, _, _ := buildRaceCourse(raceTestMap(), len(players))
	r.race.racing = true
	r.race.gates = gates
	r.race.startedAt = 1_000
	r.race.deadline = 1_000 + raceMaxDurationMs
	r.race.progress = map[string]int{}
	r.race.finished = map[string]raceFinish{}
	for _, p := range players {
		r.race.names[p.ID] = p.Name
		r.race.progress[p.ID] = 0
		p.Racing = true
	}
}

func TestRaceLobbyJoinReadyLeave(t *testing.T) {
	r := newRoomState(testGrace)
	players := lobbyOf(t, r, "kira", "odo")
	members := r.raceMembers()
	if len(members) != 2 || members[0].Name != "kira" || members[0].Ready {
		t.Fatalf("lobby wrong: %+v", members)
	}
	// a re-join is a harmless no-op
	if reason := r.raceJoin(players[0].ID); reason != "" {
		t.Fatalf("rejoin refused: %s", reason)
	}
	if len(r.raceMembers()) != 2 {
		t.Fatal("rejoin duplicated the member")
	}
	// readiness shows on the member list
	if reason := r.raceSetReady(players[0].ID, true); reason != "" {
		t.Fatalf("ready refused: %s", reason)
	}
	if !r.raceMembers()[0].Ready {
		t.Fatal("ready flag not set")
	}
	// leaving empties the lobby back to idle
	if !r.raceLobbyDrop(players[0].ID) || !r.raceLobbyDrop(players[1].ID) {
		t.Fatal("lobby drops failed")
	}
	if r.race != nil {
		t.Fatal("emptied lobby must reset to idle")
	}
}

func TestRaceLobbyCapAndOutsiders(t *testing.T) {
	r := newRoomState(testGrace)
	names := []string{"a", "b", "c", "d", "e", "f"}
	players := lobbyOf(t, r, names...)
	extra := joinNamed(r, "late")
	if reason := r.raceJoin(extra.ID); reason != "lobbyFull" {
		t.Fatalf("expected lobbyFull, got %q", reason)
	}
	// non-members can't ready or start
	if reason := r.raceSetReady(extra.ID, true); reason != "notInLobby" {
		t.Fatalf("expected notInLobby, got %q", reason)
	}
	if reason := r.raceStartDenial(extra.ID); reason != "notInLobby" {
		t.Fatalf("expected notInLobby, got %q", reason)
	}
	// start needs every member ready
	if reason := r.raceStartDenial(players[0].ID); reason != "notAllReady" {
		t.Fatalf("expected notAllReady, got %q", reason)
	}
}

func TestRaceProgressOrderAndFinish(t *testing.T) {
	r := newRoomState(testGrace)
	players := lobbyOf(t, r, "kira", "odo")
	startRace(t, r, players)
	gateCount := len(r.race.gates)
	// joining mid-race is refused
	late := joinNamed(r, "late")
	if reason := r.raceJoin(late.ID); reason != "raceInProgress" {
		t.Fatalf("expected raceInProgress, got %q", reason)
	}
	// gates must be passed one at a time, in order
	if ok, _ := r.raceRecordProgress(players[0].ID, 2, 2_000); ok {
		t.Fatal("skipping gate 1 must be rejected")
	}
	if ok, _ := r.raceRecordProgress(late.ID, 1, 2_000); ok {
		t.Fatal("a non-racer's progress must be rejected")
	}
	// kira flies the whole course; the last gate finishes her in first place
	for g := 1; g < gateCount; g++ {
		ok, finish := r.raceRecordProgress(players[0].ID, g, 2_000)
		if !ok || finish != nil {
			t.Fatalf("gate %d: ok=%v finish=%v", g, ok, finish)
		}
	}
	ok, finish := r.raceRecordProgress(players[0].ID, gateCount, 91_000)
	if !ok || finish == nil || finish.place != 1 || finish.timeMs != 90_000 {
		t.Fatalf("finish wrong: ok=%v finish=%+v", ok, finish)
	}
	// a repeat report after finishing is rejected
	if ok, _ := r.raceRecordProgress(players[0].ID, gateCount, 92_000); ok {
		t.Fatal("post-finish progress must be rejected")
	}
	if r.raceAllDone() {
		t.Fatal("odo is still out")
	}
	// odo finishes second
	for g := 1; g <= gateCount; g++ {
		r.raceRecordProgress(players[1].ID, g, 120_000)
	}
	if !r.raceAllDone() {
		t.Fatal("everyone finished")
	}
	results := r.raceResults()
	if len(results) != 2 || results[0].Name != "kira" || results[1].Name != "odo" {
		t.Fatalf("results wrong: %+v", results)
	}
	if results[0].TimeMs == nil || *results[0].TimeMs != 90_000 {
		t.Fatalf("winner time wrong: %+v", results[0])
	}
}

func TestRaceDropAndDNFResults(t *testing.T) {
	r := newRoomState(testGrace)
	players := lobbyOf(t, r, "kira", "odo", "worf")
	startRace(t, r, players)
	gateCount := len(r.race.gates)
	// kira finishes, odo drops (disconnect/quit), worf stays out
	for g := 1; g <= gateCount; g++ {
		r.raceRecordProgress(players[0].ID, g, 60_000)
	}
	if !r.raceRacerDrop(players[1].ID) {
		t.Fatal("odo's drop failed")
	}
	if r.raceRacerDrop(players[1].ID) {
		t.Fatal("a second drop must be a no-op")
	}
	if r.raceAllDone() {
		t.Fatal("worf is still out")
	}
	results := r.raceResults()
	// the finisher, then the still-running DNF; the dropped racer is gone
	if len(results) != 2 || results[0].Name != "kira" || results[1].Name != "worf" {
		t.Fatalf("results wrong: %+v", results)
	}
	if results[1].TimeMs != nil {
		t.Fatalf("worf must be a DNF: %+v", results[1])
	}
	// worf dropping too ends the race
	r.raceRacerDrop(players[2].ID)
	if !r.raceAllDone() {
		t.Fatal("race must be done once everyone finished or dropped")
	}
}

func TestBuildRaceCourse(t *testing.T) {
	m := raceTestMap()
	gates, starts, heading := buildRaceCourse(m, 3)
	if len(gates) != raceGateCount {
		t.Fatalf("expected %d gates, got %d", raceGateCount, len(gates))
	}
	if len(starts) != 3 {
		t.Fatalf("expected 3 grid slots, got %d", len(starts))
	}
	// every gate lands inside the course box: floor bbox center (200,150) ±
	// half-extents (bbox half-size + margin, floored at the min radii)
	hx := math.Max(200+raceCourseMargin, raceCourseMinRx)
	hy := math.Max(150+raceCourseMargin, raceCourseMinRy)
	for i, g := range gates {
		if math.Abs(g.X-200) > hx || math.Abs(g.Y-150) > hy {
			t.Fatalf("gate %d outside the course box: %+v", i, g)
		}
	}
	// no two gates crowd each other
	for i := range gates {
		for j := i + 1; j < len(gates); j++ {
			if math.Hypot(gates[i].X-gates[j].X, gates[i].Y-gates[j].Y) < raceGateMinSpacing {
				t.Fatalf("gates %d and %d too close: %+v %+v", i, j, gates[i], gates[j])
			}
		}
	}
	// the grid base (center slot of three) lands within the course box grown
	// by the clearance (the cramped-map fallback sits just outside the box),
	// clear of every gate — the launch spot is random, not welded behind
	// gate one
	base := starts[1]
	if math.Abs(base.X-200) > hx+raceStartClearance || math.Abs(base.Y-150) > hy+raceStartClearance {
		t.Fatalf("start base outside the grown course box: %+v", base)
	}
	for i, g := range gates {
		if math.Hypot(g.X-base.X, g.Y-base.Y) < raceStartClearance {
			t.Fatalf("start base crowds gate %d: %+v %+v", i, base, g)
		}
	}
	// a second build scatters differently: the course is random per race
	again, _, _ := buildRaceCourse(m, 3)
	same := true
	for i := range gates {
		if gates[i] != again[i] {
			same = false
		}
	}
	if same {
		t.Fatal("two builds produced the identical course")
	}
	// grid slots share the heading and point roughly at gate one
	for _, st := range starts {
		if st.A != heading {
			t.Fatalf("grid heading mismatch: %+v", st)
		}
		want := math.Atan2(gates[0].Y-st.Y, gates[0].X-st.X)
		// wrap the difference into (-pi, pi] before comparing
		if d := math.Abs(math.Mod(want-st.A+3*math.Pi, 2*math.Pi) - math.Pi); d > 0.5 {
			t.Fatalf("grid slot not facing gate one (off by %.2f rad): %+v", d, st)
		}
	}
	// slots are spread apart, not stacked
	if math.Hypot(starts[0].X-starts[1].X, starts[0].Y-starts[1].Y) < raceGridSpacing-1 {
		t.Fatal("grid slots overlap")
	}
}

// the debrief lifecycle (post-game scoreboard comms): a finisher keeps race
// comms until they close the board; endRace moves the whole field into the
// debrief; endDebrief releases the hold and tells the room
func TestRaceDebriefLifecycle(t *testing.T) {
	s := &server{defaultMap: raceTestMap()}
	r := newRoomState(testGrace)
	players := lobbyOf(t, r, "kira", "odo")
	startRace(t, r, players)
	gateCount := len(r.race.gates)

	// kira crosses every gate and finishes; like handleRaceProgress, the
	// finish moves her into the debrief instead of out of race comms
	for g := 1; g <= gateCount; g++ {
		if ok, _ := r.raceRecordProgress(players[0].ID, g, 2_000); !ok {
			t.Fatalf("gate %d refused", g)
		}
	}
	s.transitionToDebrief(r, players[0], "race")
	if players[0].Racing {
		t.Fatal("a finisher is no longer racing")
	}
	if players[0].Debrief == nil || *players[0].Debrief != "race" {
		t.Fatalf("finisher debrief wrong: %v", players[0].Debrief)
	}
	if audioGroupOf(players[0]) != raceGroup {
		t.Fatal("a finisher in debrief must stay in race comms")
	}
	if audioGroupOf(players[0]) != audioGroupOf(players[1]) {
		t.Fatal("the finisher and the still-out racer must share the group")
	}

	// odo finishes too: the race is done, endRace debriefs the rest of the field
	for g := 1; g <= gateCount; g++ {
		if ok, _ := r.raceRecordProgress(players[1].ID, g, 3_000); !ok {
			t.Fatalf("gate %d refused", g)
		}
	}
	s.transitionToDebrief(r, players[1], "race")
	if !r.raceAllDone() {
		t.Fatal("race must be done after both finish")
	}
	s.endRace(r)
	if r.race != nil {
		t.Fatal("endRace must reset the lobby to idle")
	}
	if audioGroupOf(players[0]) != raceGroup || audioGroupOf(players[1]) != raceGroup {
		t.Fatal("the whole field keeps race comms after the race ends")
	}

	// kira closes her board: the hold releases, odo hears about it, and only
	// odo still holds the channel
	s.endDebrief(r, players[0])
	if players[0].Debrief != nil {
		t.Fatal("endDebrief must clear the hold")
	}
	if audioGroupOf(players[0]) == raceGroup {
		t.Fatal("a closed board leaves race comms")
	}
	if audioGroupOf(players[1]) != raceGroup {
		t.Fatal("odo's board is still up — he keeps race comms")
	}
	odoSock := r.sessionOf(players[1].ID).sock.(*fakeConn)
	saw := false
	for _, m := range odoSock.msgs {
		if ended, ok := m.(svrDebriefEnded); ok && ended.ID == players[0].ID {
			saw = true
		}
	}
	if !saw {
		t.Fatal("the room must hear debriefEnded when a board closes")
	}
}

func TestRaceScoreEntries(t *testing.T) {
	r := newRoomState(testGrace)
	players := lobbyOf(t, r, "kira", "odo")
	startRace(t, r, players)
	// handleRaceStart captures the clerk ids; the helper starts inline, so
	// stamp them here
	r.race.userIDs[players[0].ID] = "user-kira"
	r.race.userIDs[players[1].ID] = "user-odo"
	// kira finishes at 61s on a 1s clock zero; odo DNFs
	for g := 1; g <= len(r.race.gates); g++ {
		r.raceRecordProgress(players[0].ID, g, 61_000)
	}
	r.raceRacerDrop(players[1].ID)
	entries := r.raceScoreEntries()
	if len(entries) != 1 || entries[0].userID != "user-kira" || entries[0].score != 60_000 {
		t.Fatalf("entries wrong: %+v", entries)
	}
}
