// unit tests for the shuttle blasters state machine + arena generator
package main

import (
	"math"
	"testing"
)

// a one-plate layout for arena generation
func blastTestMap() *MapData {
	return &MapData{
		Floors: []Floor{{Rect: Rect{X: 0, Y: 0, W: 400, H: 300}, R: 12}},
		Zones:  []Zone{},
		Spawn:  Point{X: 50, Y: 50},
	}
}

// join n players and seat them all in the blasters lobby
func blastLobbyOf(t *testing.T, r *roomState, names ...string) []*Player {
	t.Helper()
	players := make([]*Player, len(names))
	for i, n := range names {
		players[i] = joinNamed(r, n)
		if reason := r.blastJoin(players[i].ID); reason != "" {
			t.Fatalf("join %s refused: %s", n, reason)
		}
	}
	return players
}

// ready everyone up and flip the lobby into a running match, like handleBlastStart
func startBlast(t *testing.T, r *roomState, players []*Player) {
	t.Helper()
	for _, p := range players {
		if reason := r.blastSetReady(p.ID, true); reason != "" {
			t.Fatalf("ready refused: %s", reason)
		}
	}
	if reason := r.blastStartDenial(players[0].ID); reason != "" {
		t.Fatalf("start refused: %s", reason)
	}
	arena, _ := buildBlastArena(blastTestMap(), len(players))
	r.blast.playing = true
	r.blast.arena = arena
	r.blast.startedAt = 1_000
	r.blast.deadline = 1_000 + blastMaxDurationMs
	r.blast.alive = map[string]bool{}
	r.blast.eliminated = []string{}
	for _, p := range players {
		r.blast.names[p.ID] = p.Name
		r.blast.alive[p.ID] = true
		p.Blasting = true
	}
}

func TestBlastLobbyJoinReadyLeave(t *testing.T) {
	r := newRoomState(testGrace)
	players := blastLobbyOf(t, r, "kira", "odo")
	members := r.blastMembers()
	if len(members) != 2 || members[0].Name != "kira" || members[0].Ready {
		t.Fatalf("lobby wrong: %+v", members)
	}
	// a re-join is a harmless no-op
	if reason := r.blastJoin(players[0].ID); reason != "" {
		t.Fatalf("rejoin refused: %s", reason)
	}
	if len(r.blastMembers()) != 2 {
		t.Fatal("rejoin duplicated the member")
	}
	// readiness shows on the member list
	if reason := r.blastSetReady(players[0].ID, true); reason != "" {
		t.Fatalf("ready refused: %s", reason)
	}
	if !r.blastMembers()[0].Ready {
		t.Fatal("ready flag not set")
	}
	// leaving empties the lobby back to idle
	if !r.blastLobbyDrop(players[0].ID) || !r.blastLobbyDrop(players[1].ID) {
		t.Fatal("lobby drops failed")
	}
	if r.blast != nil {
		t.Fatal("emptied lobby must reset to idle")
	}
}

func TestBlastLobbyCapOutsidersAndNeedTwo(t *testing.T) {
	r := newRoomState(testGrace)
	names := []string{"a", "b", "c", "d", "e", "f"}
	players := blastLobbyOf(t, r, names...)
	extra := joinNamed(r, "late")
	if reason := r.blastJoin(extra.ID); reason != "lobbyFull" {
		t.Fatalf("expected lobbyFull, got %q", reason)
	}
	// non-members can't ready or start
	if reason := r.blastSetReady(extra.ID, true); reason != "notInLobby" {
		t.Fatalf("expected notInLobby, got %q", reason)
	}
	if reason := r.blastStartDenial(extra.ID); reason != "notInLobby" {
		t.Fatalf("expected notInLobby, got %q", reason)
	}
	// start needs every member ready
	if reason := r.blastStartDenial(players[0].ID); reason != "notAllReady" {
		t.Fatalf("expected notAllReady, got %q", reason)
	}
	// a solo lobby can never start, ready or not
	solo := newRoomState(testGrace)
	one := blastLobbyOf(t, solo, "alone")
	solo.blastSetReady(one[0].ID, true)
	if reason := solo.blastStartDenial(one[0].ID); reason != "needTwo" {
		t.Fatalf("expected needTwo, got %q", reason)
	}
}

func TestBlastEliminationAndResults(t *testing.T) {
	r := newRoomState(testGrace)
	players := blastLobbyOf(t, r, "kira", "odo", "worf")
	startBlast(t, r, players)
	// joining mid-match is refused
	late := joinNamed(r, "late")
	if reason := r.blastJoin(late.ID); reason != "matchInProgress" {
		t.Fatalf("expected matchInProgress, got %q", reason)
	}
	// a non-combatant can't be eliminated, nor can anyone twice
	if r.blastEliminate(late.ID) {
		t.Fatal("eliminating a non-combatant must fail")
	}
	if !r.blastEliminate(players[1].ID) {
		t.Fatal("odo's elimination failed")
	}
	if r.blastEliminate(players[1].ID) {
		t.Fatal("a second elimination must be a no-op")
	}
	if r.blastAllDone() {
		t.Fatal("kira and worf are still flying")
	}
	// worf goes down next; one shuttle left decides the fight
	if !r.blastEliminate(players[2].ID) {
		t.Fatal("worf's elimination failed")
	}
	if !r.blastAllDone() {
		t.Fatal("one survivor means the match is decided")
	}
	// standings: the survivor first, then the eliminated in reverse order
	results := r.blastResults()
	if len(results) != 3 || results[0].Name != "kira" || results[1].Name != "worf" || results[2].Name != "odo" {
		t.Fatalf("results wrong: %+v", results)
	}
	if !results[0].Survived || results[1].Survived || results[2].Survived {
		t.Fatalf("survived flags wrong: %+v", results)
	}
}

func TestBlastTimeoutResultsTieSurvivors(t *testing.T) {
	r := newRoomState(testGrace)
	players := blastLobbyOf(t, r, "kira", "odo", "worf")
	startBlast(t, r, players)
	// only worf goes down before the cap; both survivors rank above him
	r.blastEliminate(players[2].ID)
	results := r.blastResults()
	if len(results) != 3 || !results[0].Survived || !results[1].Survived || results[2].Survived {
		t.Fatalf("results wrong: %+v", results)
	}
	if results[0].Name != "kira" || results[1].Name != "odo" || results[2].Name != "worf" {
		t.Fatalf("order wrong: %+v", results)
	}
}

func TestBuildBlastArena(t *testing.T) {
	m := blastTestMap()
	arena, starts := buildBlastArena(m, 4)
	if len(starts) != 4 {
		t.Fatalf("expected 4 spawn slots, got %d", len(starts))
	}
	// the arena is centered on the hull and clears its corners
	if arena.X != 200 || arena.Y != 150 {
		t.Fatalf("arena off-center: %+v", arena)
	}
	corner := math.Hypot(200, 150)
	if arena.R < corner {
		t.Fatalf("arena radius %f does not clear the hull corner %f", arena.R, corner)
	}
	for i, st := range starts {
		// every slot sits inside the arena, off its exact center
		d := math.Hypot(st.X-arena.X, st.Y-arena.Y)
		if d >= arena.R || d < 1 {
			t.Fatalf("slot %d misplaced (d=%f): %+v", i, d, st)
		}
		// noses point at the arena center
		want := math.Atan2(arena.Y-st.Y, arena.X-st.X)
		if diff := math.Abs(want - st.A); diff > 1e-6 {
			t.Fatalf("slot %d not facing center (off by %.3f rad): %+v", i, diff, st)
		}
	}
	// slots are spread around the ring, not stacked
	if math.Hypot(starts[0].X-starts[1].X, starts[0].Y-starts[1].Y) < 100 {
		t.Fatal("spawn slots overlap")
	}
	// the first slot is at the top of the ring, centered on the hull
	if math.Abs(starts[0].X-200) > 1e-6 || starts[0].Y >= 150 {
		t.Fatalf("first slot misplaced: %+v", starts[0])
	}
}

// endBlast moves the whole field — survivor and fallen alike — into the
// debrief, so the match channel keeps talking until each board closes
func TestBlastDebriefOnMatchEnd(t *testing.T) {
	s := &server{defaultMap: blastTestMap()}
	r := newRoomState(testGrace)
	players := blastLobbyOf(t, r, "kira", "odo")
	startBlast(t, r, players)

	// odo falls: like handleBlastHit, the elimination debriefs him in place
	if !r.blastEliminate(players[1].ID) {
		t.Fatal("eliminate refused")
	}
	s.transitionToDebrief(r, players[1], "blast")
	if players[1].Blasting || players[1].Debrief == nil || *players[1].Debrief != "blast" {
		t.Fatalf("fallen player state wrong: %+v", players[1])
	}
	if audioGroupOf(players[1]) != blastGroup {
		t.Fatal("the fallen must stay in match comms while their board is up")
	}

	// one shuttle left: the match ends and the survivor debriefs too
	if !r.blastAllDone() {
		t.Fatal("match must be decided")
	}
	s.endBlast(r)
	if r.blast != nil {
		t.Fatal("endBlast must reset the lobby to idle")
	}
	if audioGroupOf(players[0]) != blastGroup || audioGroupOf(players[1]) != blastGroup {
		t.Fatal("the whole field keeps match comms after the match ends")
	}

	// both close their boards: the channel dissolves
	s.endDebrief(r, players[0])
	s.endDebrief(r, players[1])
	if audioGroupOf(players[0]) == blastGroup || audioGroupOf(players[1]) == blastGroup {
		t.Fatal("closed boards leave match comms")
	}
}

func TestBlastScoreEntries(t *testing.T) {
	r := newRoomState(testGrace)
	players := blastLobbyOf(t, r, "kira", "odo", "worf")
	startBlast(t, r, players)
	// handleBlastStart captures the clerk ids and zeroes the kill counts; the
	// helper starts inline, so stamp them here
	r.blast.kills = map[string]int{}
	r.blast.userIDs[players[0].ID] = "user-kira"
	r.blast.userIDs[players[1].ID] = "user-odo"
	r.blast.userIDs[players[2].ID] = "user-worf"
	// kira downs both others; the fallen never scored
	r.blastEliminate(players[1].ID)
	r.blast.kills[players[0].ID]++
	r.blastEliminate(players[2].ID)
	r.blast.kills[players[0].ID]++
	entries := r.blastScoreEntries()
	if len(entries) != 1 || entries[0].userID != "user-kira" || entries[0].score != 2 {
		t.Fatalf("entries wrong: %+v", entries)
	}
}
