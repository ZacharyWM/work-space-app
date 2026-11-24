// unit tests for the presence state module (port of state.test.ts)
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"
)

var testSpawn = Point{X: 330, Y: 800}

// grace window for parked players; tests pass explicit now values against it
const testGrace = int64(30_000)

// fake transport standing in for real ws connections
type fakeConn struct {
	name       string
	msgs       []any
	closed     bool
	terminated bool
}

func (f *fakeConn) send(msg any)  { f.msgs = append(f.msgs, msg) }
func (f *fakeConn) close()        { f.closed = true }
func (f *fakeConn) terminate()    { f.terminated = true }
func (f *fakeConn) isOpen() bool  { return !f.closed && !f.terminated }
func sock(name string) *fakeConn { return &fakeConn{name: name} }

func joinNamed(r *roomState, name string) *Player {
	p, _ := r.join(joinInput{
		userID: "u-" + name, name: name, micOn: true, camOn: false, character: defaultCharacter,
	}, testSpawn, "", sock("sock-"+name))
	return p
}

func TestJoinReturnsFullPlayer(t *testing.T) {
	r := newRoomState(testGrace)
	p, token := r.join(joinInput{
		userID: "u1", name: "kira", micOn: true, camOn: false, character: defaultCharacter,
	}, testSpawn, "bridge", sock("sock-1"))
	if p.UserID != "u1" || p.Name != "kira" || p.X != testSpawn.X || p.Y != testSpawn.Y {
		t.Errorf("player basics wrong: %+v", p)
	}
	if strOf(p.ZoneID) != "bridge" || !p.MicOn || p.CamOn || p.Speaking || p.ScreenOn {
		t.Errorf("player state wrong: %+v", p)
	}
	if p.ID == "" || token == "" {
		t.Error("id and resume token must be non-empty")
	}
}

func TestJoinAssignsUniqueIDs(t *testing.T) {
	r := newRoomState(testGrace)
	seen := map[string]bool{}
	for _, n := range []string{"a", "b", "c", "d"} {
		id := joinNamed(r, n).ID
		if seen[id] {
			t.Fatalf("duplicate id %s", id)
		}
		seen[id] = true
	}
}

func TestJoinHuesGoldenAngle(t *testing.T) {
	r := newRoomState(testGrace)
	var hues []float64
	for _, n := range []string{"a", "b", "c", "d"} {
		hues = append(hues, joinNamed(r, n).Hue)
	}
	want := []float64{0, 137.508, 275.016, 52.524} // third increment wraps past 360
	for i, h := range hues {
		if math.Abs(h-want[i]) > 0.001 {
			t.Errorf("hue[%d] = %v, want %v", i, h, want[i])
		}
		if h < 0 || h >= 360 {
			t.Errorf("hue[%d] = %v outside [0, 360)", i, h)
		}
	}
}

func TestHuesAdvanceAfterDeparture(t *testing.T) {
	r := newRoomState(testGrace)
	first := joinNamed(r, "a")
	r.park(first.ID, 0)
	if h := joinNamed(r, "b").Hue; math.Abs(h-137.508) > 0.001 {
		t.Errorf("hue = %v, want 137.508 (join count never decrements)", h)
	}
}

func TestDistinctResumeTokens(t *testing.T) {
	r := newRoomState(testGrace)
	_, ta := r.join(joinInput{userID: "u1", name: "a", micOn: true, character: defaultCharacter}, testSpawn, "", sock("a"))
	_, tb := r.join(joinInput{userID: "u1", name: "b", micOn: true, character: defaultCharacter}, testSpawn, "", sock("b"))
	if ta == "" || tb == "" || ta == tb {
		t.Errorf("tokens must be distinct and non-empty: %q %q", ta, tb)
	}
}

func TestRosterJoinOrderAndOthersOf(t *testing.T) {
	r := newRoomState(testGrace)
	a := joinNamed(r, "a")
	b := joinNamed(r, "b")
	roster := r.roster()
	if len(roster) != 2 || roster[0].ID != a.ID || roster[1].ID != b.ID {
		t.Errorf("roster order wrong")
	}
	others := r.othersOf(a.ID)
	if len(others) != 1 || others[0].player.ID != b.ID {
		t.Fatalf("othersOf wrong: %v", others)
	}
	if others[0].sock.(*fakeConn).name != "sock-b" {
		t.Error("othersOf must carry the sockets")
	}
}

// a player mid-session: joined, walked into a zone, then muted
func boardedPlayer(r *roomState) (*Player, string) {
	p, token := r.join(joinInput{
		userID: "u1", name: "kira", micOn: true, camOn: true, character: defaultCharacter,
	}, testSpawn, "", sock("sock-1"))
	r.updatePos(p.ID, 700, 200, "bridge", nil)
	r.updateMedia(p.ID, false, true)
	return p, token
}

func TestParkRemovesFromRoster(t *testing.T) {
	r := newRoomState(testGrace)
	p, _ := boardedPlayer(r)
	if got := r.park(p.ID, 1000); got == nil || got.ID != p.ID {
		t.Fatal("park must return the player")
	}
	if len(r.roster()) != 0 || r.sessionOf(p.ID) != nil {
		t.Error("parked player must leave the roster")
	}
	if r.park("nobody", 1000) != nil {
		t.Error("park of unknown id must return nil")
	}
}

func TestResumeWithinWindow(t *testing.T) {
	r := newRoomState(testGrace)
	p, token := boardedPlayer(r)
	r.park(p.ID, 1000)
	resumed := r.resume(token, sock("sock-2"), 1000+testGrace-1)
	if resumed == nil || resumed.ID != p.ID || resumed.Name != "kira" ||
		resumed.X != 700 || resumed.Y != 200 || strOf(resumed.ZoneID) != "bridge" {
		t.Fatalf("resume must restore the player: %+v", resumed)
	}
	if r.sessionOf(p.ID).sock.(*fakeConn).name != "sock-2" {
		t.Error("resume must bind the new socket")
	}
}

func TestResumeAtExpiryFailsForGood(t *testing.T) {
	r := newRoomState(testGrace)
	p, token := boardedPlayer(r)
	r.park(p.ID, 1000)
	if r.resume(token, sock("sock-2"), 1000+testGrace) != nil {
		t.Error("resume at expiry must fail")
	}
	// the expired entry is gone — an earlier now can't revive it either
	if r.resume(token, sock("sock-2"), 1000) != nil {
		t.Error("expired entry must be dropped for good")
	}
	if r.resume("bogus", sock("sock-2"), 0) != nil {
		t.Error("unknown token must fail")
	}
}

func TestResumedSessionKeepsToken(t *testing.T) {
	r := newRoomState(testGrace)
	p, token := boardedPlayer(r)
	r.park(p.ID, 1000)
	r.resume(token, sock("sock-2"), 2000)
	// while live, the token resolves the session but is not resumable
	if s := r.sessionOfToken(token); s == nil || s.player.ID != p.ID {
		t.Error("live session must resolve by token")
	}
	if r.resume(token, sock("sock-3"), 2000) != nil {
		t.Error("live token must not resume")
	}
	// a second drop parks under the same token
	r.park(p.ID, 3000)
	if r.sessionOfToken(token) != nil {
		t.Error("parked token must not resolve a live session")
	}
	if got := r.resume(token, sock("sock-3"), 4000); got == nil || got.ID != p.ID {
		t.Error("second resume must work")
	}
}

func TestSweepParked(t *testing.T) {
	r := newRoomState(testGrace)
	earlyP, earlyToken := boardedPlayer(r)
	lateP, lateToken := r.join(joinInput{userID: "u1", name: "vex", micOn: true, character: defaultCharacter}, testSpawn, "", sock("sock-9"))
	r.park(earlyP.ID, 0)
	r.park(lateP.ID, 10_000)
	r.sweepParked(testGrace) // early expired exactly now; late has 10s left
	if r.resume(earlyToken, sock("sock-2"), testGrace) != nil {
		t.Error("expired entry must be swept")
	}
	if got := r.resume(lateToken, sock("sock-2"), testGrace); got == nil || got.ID != lateP.ID {
		t.Error("live entry must survive the sweep")
	}
}

func TestEvictKillsToken(t *testing.T) {
	r := newRoomState(testGrace)
	p, token := r.join(joinInput{userID: "u1", name: "kira", micOn: true, camOn: true, character: defaultCharacter}, testSpawn, "", sock("sock-1"))
	if got := r.evict(p.ID); got == nil || got.ID != p.ID {
		t.Fatal("evict must return the player")
	}
	if len(r.roster()) != 0 {
		t.Error("evicted player must leave the roster")
	}
	// unlike park, nothing was moved to the grace map — the token is dead
	if r.resume(token, sock("sock-2"), 0) != nil {
		t.Error("evicted token must never resume")
	}
	if r.evict("nobody") != nil {
		t.Error("evict of unknown id must return nil")
	}
}

func TestSessionsOfUser(t *testing.T) {
	r := newRoomState(testGrace)
	mk := func(userID, sockName string) *Player {
		p, _ := r.join(joinInput{userID: userID, name: userID, micOn: true, character: defaultCharacter}, testSpawn, "", sock(sockName))
		return p
	}
	a1 := mk("u1", "sock-1")
	a2 := mk("u1", "sock-2")
	mk("u2", "sock-3")
	got := r.sessionsOfUser("u1")
	if len(got) != 2 || got[0].player.ID != a1.ID || got[1].player.ID != a2.ID {
		t.Errorf("sessionsOfUser wrong: %v", got)
	}
	if len(r.sessionsOfUser("u3")) != 0 {
		t.Error("unknown user must have no sessions")
	}
}

func TestDropParkedOfUser(t *testing.T) {
	r := newRoomState(testGrace)
	mineP, mineToken := r.join(joinInput{userID: "u1", name: "kira", micOn: true, character: defaultCharacter}, testSpawn, "", sock("sock-1"))
	otherP, otherToken := r.join(joinInput{userID: "u2", name: "vex", micOn: true, character: defaultCharacter}, testSpawn, "", sock("sock-2"))
	r.park(mineP.ID, 1000)
	r.park(otherP.ID, 1000)
	r.dropParkedOfUser("u1")
	if r.resume(mineToken, sock("sock-3"), 2000) != nil {
		t.Error("dropped token must not resume")
	}
	if got := r.resume(otherToken, sock("sock-4"), 2000); got == nil || got.ID != otherP.ID {
		t.Error("other user's token must survive")
	}
}

func TestAllSessions(t *testing.T) {
	r := newRoomState(testGrace)
	a := joinNamed(r, "a")
	b := joinNamed(r, "b")
	all := r.allSessions()
	if len(all) != 2 || all[0].player.ID != a.ID || all[1].player.ID != b.ID {
		t.Errorf("allSessions wrong")
	}
}

func TestUpdatePos(t *testing.T) {
	r := newRoomState(testGrace)
	a := joinNamed(r, "a")
	result := r.updatePos(a.ID, 700, 200, "", nil)
	if result == nil || result.zoneChanged || result.previousZoneID != "" {
		t.Errorf("updatePos result wrong: %+v", result)
	}
	if p := r.roster()[0]; p.X != 700 || p.Y != 200 {
		t.Error("position not stored")
	}
	if r.updatePos("nobody", 1, 2, "", nil) != nil {
		t.Error("unknown id must return nil")
	}
}

func TestUpdatePosReportsPreviousZone(t *testing.T) {
	r := newRoomState(testGrace)
	p, _ := r.join(joinInput{userID: "u1", name: "a", micOn: true, character: defaultCharacter}, testSpawn, "bridge", sock("sock-a"))
	result := r.updatePos(p.ID, 700, 200, "lounge", nil)
	if !result.zoneChanged || result.previousZoneID != "bridge" {
		t.Errorf("result = %+v, want zoneChanged from bridge", result)
	}
}

func TestUpdatePosStoresShuttleHeading(t *testing.T) {
	r := newRoomState(testGrace)
	a := joinNamed(r, "a")
	heading := -1.57
	r.updatePos(a.ID, 700, 200, "", &heading)
	if p := r.roster()[0]; p.ShipA == nil || *p.ShipA != -1.57 {
		t.Error("heading not stored")
	}
	// a heading-less update (walking) keeps the last one
	r.updatePos(a.ID, 710, 210, "", nil)
	if p := r.roster()[0]; p.ShipA == nil || *p.ShipA != -1.57 {
		t.Error("heading must survive heading-less updates")
	}
}

func TestUpdateShip(t *testing.T) {
	r := newRoomState(testGrace)
	if joinNamed(r, "x").ShipPad != nil {
		t.Error("players join on foot")
	}

	p, _ := r.join(joinInput{userID: "u1", name: "a", micOn: true, character: defaultCharacter}, testSpawn, "flight", sock("sock-a"))
	pad := 2
	// flying is always zone-less; the caller passes the zone it computed
	result := r.updateShip(p.ID, &pad, "")
	if !result.zoneChanged || result.previousZoneID != "flight" {
		t.Errorf("boarding result wrong: %+v", result)
	}
	if got := r.sessionOf(p.ID).player; got.ShipPad == nil || *got.ShipPad != 2 || got.ZoneID != nil {
		t.Error("boarding must store the pad and clear the zone")
	}
	// docking clears the pad and reports re-entering the zone
	result = r.updateShip(p.ID, nil, "flight")
	if !result.zoneChanged || result.previousZoneID != "" {
		t.Errorf("docking result wrong: %+v", result)
	}
	if got := r.sessionOf(p.ID).player; got.ShipPad != nil || strOf(got.ZoneID) != "flight" {
		t.Error("docking must clear the pad and set the zone")
	}
	if r.updateShip("nobody", &pad, "") != nil {
		t.Error("unknown id must return nil")
	}
}

func TestFlightSurvivesParkResume(t *testing.T) {
	r := newRoomState(testGrace)
	p, token := r.join(joinInput{userID: "u1", name: "a", micOn: true, character: defaultCharacter}, testSpawn, "", sock("sock-a"))
	pad := 1
	heading := 0.5
	r.updateShip(p.ID, &pad, "")
	r.updatePos(p.ID, 2000, 1500, "", &heading)
	r.park(p.ID, 1000)
	back := r.resume(token, sock("sock-a2"), 2000)
	if back == nil || back.ShipPad == nil || *back.ShipPad != 1 ||
		back.ShipA == nil || *back.ShipA != 0.5 || back.X != 2000 || back.Y != 1500 {
		t.Errorf("flight must survive park+resume: %+v", back)
	}
}

func TestUpdateFlags(t *testing.T) {
	r := newRoomState(testGrace)
	a := joinNamed(r, "a") // joins micOn=true camOn=false speaking=false screenOn=false available
	if !r.updateMedia(a.ID, false, true) {
		t.Error("updateMedia must succeed")
	}
	if p := r.roster()[0]; p.MicOn || !p.CamOn {
		t.Error("media toggles not stored")
	}
	if !r.updateSpeaking(a.ID, true) || !r.roster()[0].Speaking {
		t.Error("speaking not stored")
	}
	if !r.updateScreen(a.ID, true) || !r.roster()[0].ScreenOn {
		t.Error("screenOn not stored")
	}
	if r.roster()[0].Status != "available" {
		t.Error("players join available")
	}
	if !r.updateStatus(a.ID, "busy") || r.roster()[0].Status != "busy" {
		t.Error("status not stored")
	}
	edited := defaultCharacter
	edited.Hat = "cap"
	edited.Helmet = true
	if !r.updateCharacter(a.ID, edited) || r.roster()[0].Character != edited {
		t.Error("character not stored")
	}
	if !r.updateName(a.ID, "renamed") || r.roster()[0].Name != "renamed" {
		t.Error("name not stored")
	}
	// unknown ids fail every update
	if r.updateMedia("nobody", true, true) || r.updateSpeaking("nobody", true) ||
		r.updateScreen("nobody", true) || r.updateStatus("nobody", "away") ||
		r.updateCharacter("nobody", defaultCharacter) || r.updateName("nobody", "x") {
		t.Error("unknown id must fail")
	}
}

func TestStatusAndCharacterSurviveParkResume(t *testing.T) {
	r := newRoomState(testGrace)
	p, token := r.join(joinInput{userID: "u1", name: "kira", micOn: true, camOn: true, character: defaultCharacter}, testSpawn, "", sock("sock-1"))
	edited := defaultCharacter
	edited.Hair = "none"
	r.updateStatus(p.ID, "busy")
	r.updateCharacter(p.ID, edited)
	r.park(p.ID, 0)
	resumed := r.resume(token, sock("sock-2"), testGrace-1)
	if resumed.Status != "busy" || resumed.Character != edited {
		t.Errorf("state must survive park+resume: %+v", resumed)
	}
}

// two disjoint zones on one big floor; open space everywhere else. Built like
// parseMapData builds maps: every slice non-nil so JSON stays arrays
var zonedMap = &MapData{
	Floors: []Floor{{Rect: Rect{X: 0, Y: 0, W: 1000, H: 1000}}},
	Zones: []Zone{
		{ID: "a", Name: "A", Rect: Rect{X: 0, Y: 0, W: 100, H: 100}},
		{ID: "b", Name: "B", Rect: Rect{X: 200, Y: 0, W: 100, H: 100}},
	},
	Decor: []json.RawMessage{},
	Pads:  []Point{},
	Spawn: Point{X: 500, Y: 500},
}

func TestZoneMembershipViaUpdatePos(t *testing.T) {
	// mirror the server's pos handler: zoneAt per position, emit on zoneChanged
	r := newRoomState(testGrace)
	p := joinNamed(r, "walker") // joins in open space
	var emissions []string
	for _, pt := range []Point{
		{X: 500, Y: 500}, // still open space — no emission
		{X: 50, Y: 50},   // enter a
		{X: 60, Y: 60},   // staying put inside a — no emission
		{X: 250, Y: 50},  // switch straight to b
		{X: 250, Y: 60},  // staying put inside b — no emission
		{X: 500, Y: 500}, // leave to open space
	} {
		zoneID := ""
		if z := zoneAt(zonedMap, pt.X, pt.Y); z != nil {
			zoneID = z.ID
		}
		if result := r.updatePos(p.ID, pt.X, pt.Y, zoneID, nil); result.zoneChanged {
			emissions = append(emissions, zoneID)
		}
	}
	want := []string{"a", "b", ""}
	if len(emissions) != len(want) {
		t.Fatalf("emissions = %v, want %v", emissions, want)
	}
	for i := range want {
		if emissions[i] != want[i] {
			t.Fatalf("emissions = %v, want %v", emissions, want)
		}
	}
	if r.roster()[0].ZoneID != nil {
		t.Error("player must end in open space")
	}
}

func TestChatHistory(t *testing.T) {
	chatN := func(n int) ChatMessage {
		return ChatMessage{ID: fmt.Sprintf("c%d", n), From: "p1", Name: "kira", Scope: "ship", Text: fmt.Sprintf("message %d", n), Ts: int64(n)}
	}
	r := newRoomState(testGrace)
	r.addChat(chatN(1))
	r.addChat(chatN(2))
	h := r.chatHistory()
	if len(h) != 2 || h[0].ID != "c1" || h[1].ID != "c2" {
		t.Error("history must retain messages oldest-first")
	}
	r = newRoomState(testGrace)
	for n := 0; n < chatHistoryMax+5; n++ {
		r.addChat(chatN(n))
	}
	h = r.chatHistory()
	if len(h) != chatHistoryMax || h[0].ID != "c5" {
		t.Errorf("history must roll the oldest off: len=%d first=%s", len(h), h[0].ID)
	}
}

// --- visitors (space link feature) ---

func TestVisitorCountAndSessions(t *testing.T) {
	room := newRoomState(testGrace)
	room.wid = "wsA"
	memberIn := joinInput{userID: "u1", name: "kira", character: defaultCharacter, homeID: "wsA", homeSlug: "a", homeName: "A"}
	visitorIn := joinInput{userID: "u2", name: "dax", character: defaultCharacter, homeID: "wsB", homeSlug: "b", homeName: "B"}
	room.join(memberIn, testSpawn, "", sock("s1"))
	visitor, token := room.join(visitorIn, testSpawn, "", sock("s2"))
	if room.visitorCount() != 1 {
		t.Errorf("one visitor aboard, counted %d", room.visitorCount())
	}
	if got := room.visitorSessionsOf("wsB"); len(got) != 1 || got[0].player.ID != visitor.ID {
		t.Errorf("visitorSessionsOf must find the visitor: %+v", got)
	}
	if got := room.visitorSessionsOf("wsA"); got != nil {
		t.Errorf("members must never count as visitors: %+v", got)
	}
	// a parked visitor's home survives the park and the resume (ADR 0004)
	room.park(visitor.ID, 0)
	if user, home := room.parkedOwnerOf(token); user != "u2" || home != "wsB" {
		t.Errorf("parkedOwnerOf wrong: %s %s", user, home)
	}
	if room.visitorCount() != 0 {
		t.Errorf("a parked visitor is not aboard, counted %d", room.visitorCount())
	}
	resumed := room.resume(token, sock("s3"), 1)
	if resumed == nil {
		t.Fatal("resume failed")
	}
	if sess := room.sessionOf(resumed.ID); sess.homeID != "wsB" || sess.homeSlug != "b" || sess.homeName != "B" {
		t.Errorf("home must survive park+resume: %+v", sess)
	}
	// dropParkedOfHome kills only the matching home's parked visits
	room.park(resumed.ID, 0)
	room.dropParkedOfHome("wsB")
	if p := room.resume(token, sock("s4"), 1); p != nil {
		t.Error("a dropped parked visit must not resume")
	}
}

func TestJoinCarriesStatusAndBadge(t *testing.T) {
	room := newRoomState(testGrace)
	home := "Deep Space Crew"
	p, _ := room.join(joinInput{
		userID: "u1", name: "kira", character: defaultCharacter,
		status: "busy", visitingFrom: &home,
	}, testSpawn, "", sock("s1"))
	if p.Status != "busy" {
		t.Errorf("a traversal must carry the status, got %q", p.Status)
	}
	if p.VisitingFrom == nil || *p.VisitingFrom != home {
		t.Errorf("the visitor badge must ride the join: %+v", p.VisitingFrom)
	}
	// a plain board still lands available and unbadged
	p2, _ := room.join(joinInput{userID: "u2", name: "dax", character: defaultCharacter}, testSpawn, "", sock("s2"))
	if p2.Status != "available" || p2.VisitingFrom != nil {
		t.Errorf("fresh board defaults wrong: %q %+v", p2.Status, p2.VisitingFrom)
	}
}
