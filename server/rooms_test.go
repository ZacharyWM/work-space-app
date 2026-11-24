// room registry tests (port of rooms.test.ts): workspace isolation, resume
// scoping, and reaping of rooms left empty after the grace window
package main

import "testing"

func regJoin(room *roomState, name string) (*Player, string) {
	return room.join(joinInput{
		userID: "u-" + name, name: name, micOn: true, character: defaultCharacter,
	}, testSpawn, "", sock("sock-"+name))
}

func TestRoomForLazyCreateAndReuse(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	if rooms.size() != 0 {
		t.Fatal("registry must start empty")
	}
	alpha := rooms.roomFor("ws-alpha")
	if rooms.size() != 1 || rooms.roomFor("ws-alpha") != alpha {
		t.Error("roomFor must reuse the room")
	}
	if rooms.roomFor("ws-beta") == alpha || rooms.size() != 2 {
		t.Error("each workspace gets its own room")
	}
}

func TestRoomsIsolate(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	alpha := rooms.roomFor("ws-alpha")
	beta := rooms.roomFor("ws-beta")
	a, _ := regJoin(alpha, "a")
	b, _ := regJoin(beta, "b")
	if len(alpha.roster()) != 1 || alpha.roster()[0].ID != a.ID {
		t.Error("alpha roster must hold only a")
	}
	if len(beta.roster()) != 1 || beta.roster()[0].ID != b.ID {
		t.Error("beta roster must hold only b")
	}
	// a broadcastable event in alpha reaches nobody: a is alone there
	if len(alpha.othersOf(a.ID)) != 0 || len(beta.othersOf(b.ID)) != 0 {
		t.Error("broadcast targets must not cross rooms")
	}
	if alpha.sessionOf(b.ID) != nil || beta.sessionOf(a.ID) != nil {
		t.Error("per-room lookups must not cross rooms")
	}
}

func TestResumeTokenScopedToRoom(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	alpha := rooms.roomFor("ws-alpha")
	beta := rooms.roomFor("ws-beta")
	p, token := regJoin(alpha, "a")
	alpha.park(p.ID, 1000)
	if beta.resume(token, sock("sock-a2"), 2000) != nil {
		t.Error("the wrong room's parked map must not hold the token")
	}
	if got := alpha.resume(token, sock("sock-a2"), 2000); got == nil || got.ID != p.ID {
		t.Error("the right room must resume it")
	}
	if len(beta.roster()) != 0 {
		t.Error("beta must stay empty")
	}
}

func TestAllSpansEveryRoom(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	regJoin(rooms.roomFor("ws-alpha"), "a")
	// same user in two rooms (pre-eviction state)
	rooms.roomFor("ws-beta").join(joinInput{userID: "u-a", name: "a", micOn: true, character: defaultCharacter}, testSpawn, "", sock("sock-a2"))
	found := 0
	for _, room := range rooms.all() {
		found += len(room.sessionsOfUser("u-a"))
	}
	if found != 2 {
		t.Errorf("single-session scan found %d sessions, want 2", found)
	}
}

func TestRemove(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	alpha := rooms.roomFor("ws-alpha")
	p, _ := regJoin(alpha, "a")
	removed := rooms.remove("ws-alpha")
	if removed == nil || removed.sessionOf(p.ID) == nil {
		t.Error("remove must return the room for the kick pass")
	}
	if rooms.size() != 0 {
		t.Error("removed room must leave the registry")
	}
	// a workspace that never built a room removes to nil, creating nothing
	if rooms.remove("ws-never") != nil || rooms.size() != 0 {
		t.Error("remove must not lazy-create")
	}
	// a later roomFor builds a fresh, empty room
	if len(rooms.roomFor("ws-alpha").roster()) != 0 {
		t.Error("a fresh room must be empty")
	}
}

func TestSweepKeepsLiveRooms(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	regJoin(rooms.roomFor("ws-alpha"), "a")
	rooms.sweep(testGrace * 10)
	if rooms.size() != 1 {
		t.Error("rooms with live sessions must survive the sweep")
	}
}

func TestSweepParkedRoomLifecycle(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	alpha := rooms.roomFor("ws-alpha")
	p, token := regJoin(alpha, "a")
	alpha.park(p.ID, 1000)
	// inside the grace window: the parked player keeps the room alive
	rooms.sweep(1000 + testGrace - 1)
	if rooms.size() != 1 {
		t.Fatal("parked player must keep the room alive")
	}
	if got := rooms.roomFor("ws-alpha").resume(token, sock("sock-a2"), 1000+testGrace-1); got == nil || got.ID != p.ID {
		t.Fatal("resume must still work inside the window")
	}
	// drop again and let the window pass: the sweep expires the parked entry
	// and reaps the now-empty room in the same pass
	alpha.park(p.ID, 2000)
	rooms.sweep(2000 + testGrace)
	if rooms.size() != 0 {
		t.Error("expired room must be reaped")
	}
	// a later roomFor builds a fresh room — the token is gone with the old one
	if rooms.roomFor("ws-alpha").resume(token, sock("sock-a3"), 2000+testGrace) != nil {
		t.Error("token must die with the reaped room")
	}
}

func TestSweepReapsEmptiedRoomKeepsOccupied(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	alpha := rooms.roomFor("ws-alpha")
	beta := rooms.roomFor("ws-beta")
	p, _ := regJoin(alpha, "a")
	regJoin(beta, "b")
	// an exit parks, then the grace window passes with nobody aboard alpha
	alpha.park(p.ID, 0)
	rooms.sweep(testGrace)
	if rooms.size() != 1 || len(beta.roster()) != 1 {
		t.Error("only the emptied room must be reaped")
	}
}

func TestSweepReapsNeverUsedRoom(t *testing.T) {
	rooms := newRoomRegistry(testGrace)
	rooms.roomFor("ws-alpha")
	rooms.sweep(0)
	if rooms.size() != 0 {
		t.Error("a lazy-created empty room must be reaped")
	}
}
