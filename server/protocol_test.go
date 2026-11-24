// wire-format tests: the client keeps the TS zod schemas, so decoding must
// accept exactly what they emit and encoding must produce exactly what they
// validate — field names, presence, and null-vs-absent included
package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// decode must succeed and yield the wanted type
func mustDecode[T any](t *testing.T, raw string) T {
	t.Helper()
	msg, err := decodeClientMessage([]byte(raw))
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	typed, ok := msg.(T)
	if !ok {
		t.Fatalf("decoded %T, want %T", msg, *new(T))
	}
	return typed
}

// decode must fail
func mustReject(t *testing.T, raw string) {
	t.Helper()
	if msg, err := decodeClientMessage([]byte(raw)); err == nil {
		t.Fatalf("decode accepted %s as %+v, want rejection", raw, msg)
	}
}

func TestDecodeJoin(t *testing.T) {
	m := mustDecode[joinMsg](t, `{"type":"join","token":"tok","workspace":"deep-space","micOn":true,"camOn":false}`)
	if m.Token != "tok" || m.Workspace != "deep-space" || !m.MicOn || m.CamOn {
		t.Errorf("join fields wrong: %+v", m)
	}
	mustReject(t, `{"type":"join","token":"","workspace":"a","micOn":true,"camOn":false}`)
	mustReject(t, `{"type":"join","token":"tok","workspace":"Bad Slug","micOn":true,"camOn":false}`)
	mustReject(t, `{"type":"join","token":"tok","workspace":"a","micOn":true}`) // camOn absent
	mustReject(t, `not json`)
	mustReject(t, `{"type":"warp"}`)
	mustReject(t, `{}`)
}

func TestDecodePos(t *testing.T) {
	m := mustDecode[posMsg](t, `{"type":"pos","x":1.5,"y":-2}`)
	if m.X != 1.5 || m.Y != -2 || m.A != nil {
		t.Errorf("pos fields wrong: %+v", m)
	}
	withA := mustDecode[posMsg](t, `{"type":"pos","x":1,"y":2,"a":-1.57}`)
	if withA.A == nil || *withA.A != -1.57 {
		t.Error("optional heading must decode")
	}
	mustReject(t, `{"type":"pos","x":1}`)
	mustReject(t, `{"type":"pos","x":"1","y":2}`)
}

func TestDecodeShipPadNullVsAbsent(t *testing.T) {
	// pad is required but nullable: null docks, absent is invalid
	board := mustDecode[shipMsg](t, `{"type":"ship","pad":2}`)
	if board.Pad == nil || *board.Pad != 2 {
		t.Errorf("boarding pad wrong: %+v", board)
	}
	dock := mustDecode[shipMsg](t, `{"type":"ship","pad":null}`)
	if dock.Pad != nil {
		t.Error("null pad must mean dock")
	}
	mustReject(t, `{"type":"ship"}`)
	mustReject(t, `{"type":"ship","pad":-1}`)
	mustReject(t, `{"type":"ship","pad":1.5}`)
}

func TestDecodeRaceMessages(t *testing.T) {
	// the bare lobby verbs decode to their empty structs
	mustDecode[raceJoinMsg](t, `{"type":"raceJoin"}`)
	mustDecode[raceLeaveMsg](t, `{"type":"raceLeave"}`)
	mustDecode[raceStartMsg](t, `{"type":"raceStart"}`)
	if m := mustDecode[raceReadyMsg](t, `{"type":"raceReady","on":true}`); !m.On {
		t.Error("raceReady on wrong")
	}
	mustReject(t, `{"type":"raceReady"}`)
	// gate is a positive integer count of gates passed
	if m := mustDecode[raceProgressMsg](t, `{"type":"raceProgress","gate":3}`); m.Gate != 3 {
		t.Error("raceProgress gate wrong")
	}
	mustReject(t, `{"type":"raceProgress"}`)
	mustReject(t, `{"type":"raceProgress","gate":0}`)
	mustReject(t, `{"type":"raceProgress","gate":-1}`)
	mustReject(t, `{"type":"raceProgress","gate":1.5}`)
}

func TestDecodeBlastMessages(t *testing.T) {
	// the bare lobby verbs decode to their empty structs
	mustDecode[blastJoinMsg](t, `{"type":"blastJoin"}`)
	mustDecode[blastLeaveMsg](t, `{"type":"blastLeave"}`)
	mustDecode[blastStartMsg](t, `{"type":"blastStart"}`)
	if m := mustDecode[blastReadyMsg](t, `{"type":"blastReady","on":true}`); !m.On {
		t.Error("blastReady on wrong")
	}
	mustReject(t, `{"type":"blastReady"}`)
	// a fire carries the bolt's origin and heading
	if m := mustDecode[blastFireMsg](t, `{"type":"blastFire","x":900,"y":-200,"a":1.2}`); m.X != 900 || m.Y != -200 || m.A != 1.2 {
		t.Errorf("blastFire wrong: %+v", m)
	}
	mustReject(t, `{"type":"blastFire","x":1,"y":2}`)
	mustReject(t, `{"type":"blastFire","x":1,"a":0}`)
	// a hit names its target
	if m := mustDecode[blastHitMsg](t, `{"type":"blastHit","target":"p2"}`); m.Target != "p2" {
		t.Errorf("blastHit wrong: %+v", m)
	}
	mustReject(t, `{"type":"blastHit"}`)
	mustReject(t, `{"type":"blastHit","target":""}`)
}

func TestDecodeBoardClose(t *testing.T) {
	// the scoreboard close names its game so only the matching hold releases
	if m := mustDecode[boardCloseMsg](t, `{"type":"boardClose","game":"race"}`); m.Game != "race" {
		t.Errorf("boardClose wrong: %+v", m)
	}
	if m := mustDecode[boardCloseMsg](t, `{"type":"boardClose","game":"blast"}`); m.Game != "blast" {
		t.Errorf("boardClose wrong: %+v", m)
	}
	mustReject(t, `{"type":"boardClose"}`)
	mustReject(t, `{"type":"boardClose","game":"chess"}`)
}

func TestDecodeTrimAndLengthLimits(t *testing.T) {
	// zod .trim() transforms before .min/.max — the server stores trimmed text
	m := mustDecode[chatClientMsg](t, `{"type":"chat","scope":"ship","text":"  hello  "}`)
	if m.Text != "hello" {
		t.Errorf("text must be trimmed, got %q", m.Text)
	}
	mustReject(t, `{"type":"chat","scope":"ship","text":"   "}`)
	mustReject(t, `{"type":"chat","scope":"dm","text":"hi"}`)
	// length limits count UTF-16 code units like JS string.length: 250 emoji
	// (2 units each) are exactly 500 — valid even though it's 1000 bytes
	emoji := strings.Repeat("\U0001F680", 250)
	if got := mustDecode[chatClientMsg](t, `{"type":"chat","scope":"ship","text":"`+emoji+`"}`); utf16Len(got.Text) != 500 {
		t.Error("500 UTF-16 units must pass")
	}
	mustReject(t, `{"type":"chat","scope":"ship","text":"`+emoji+`!"}`)

	rename := mustDecode[renameMsg](t, `{"type":"rename","name":" Kira "}`)
	if rename.Name != "Kira" {
		t.Error("rename must trim")
	}
	mustReject(t, `{"type":"rename","name":"`+strings.Repeat("x", 33)+`"}`)
}

func TestDecodeCharacterPalette(t *testing.T) {
	valid := `{"type":"character","character":{"skin":"#F2C89B","hair":"none","shirt":"#FF6B6B","pants":"#2B3A55","hat":"cap","helmet":true}}`
	m := mustDecode[characterMsg](t, valid)
	if m.Character.Hat != "cap" || !m.Character.Helmet {
		t.Errorf("character fields wrong: %+v", m.Character)
	}
	// out-of-palette junk is rejected
	mustReject(t, `{"type":"character","character":{"skin":"#000000","hair":"none","shirt":"#FF6B6B","pants":"#2B3A55","hat":"cap","helmet":true}}`)
	mustReject(t, `{"type":"character","character":null}`)
}

func TestDecodeEnums(t *testing.T) {
	if m := mustDecode[statusMsg](t, `{"type":"status","status":"busy"}`); m.Status != "busy" {
		t.Error("status decode wrong")
	}
	mustReject(t, `{"type":"status","status":"idle"}`)
	if m := mustDecode[emoteMsg](t, `{"type":"emote","emote":"thumbsUp"}`); m.Emote != "thumbsUp" {
		t.Error("emote decode wrong")
	}
	mustReject(t, `{"type":"emote","emote":"dab"}`)
}

func TestDecodeSignalOpaqueData(t *testing.T) {
	m := mustDecode[signalClientMsg](t, `{"type":"signal","to":"p2","data":{"sdp":"x","nested":[1,null]}}`)
	if m.To != "p2" || string(m.Data) != `{"sdp":"x","nested":[1,null]}` {
		t.Errorf("signal must carry data verbatim: %s", m.Data)
	}
	// JSON null is valid opaque data; an absent key is not
	if m := mustDecode[signalClientMsg](t, `{"type":"signal","to":"p2","data":null}`); string(m.Data) != "null" {
		t.Error("null data must survive")
	}
	mustReject(t, `{"type":"signal","to":"p2"}`)
}

func TestDecodeEditMap(t *testing.T) {
	raw := `{"type":"editMap","map":{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"spawn":{"x":50,"y":50}}}`
	m := mustDecode[editMapMsg](t, raw)
	if len(m.Map.Floors) != 1 || m.Map.Spawn.X != 50 {
		t.Errorf("map decode wrong: %+v", m.Map)
	}
	mustReject(t, `{"type":"editMap","map":{"zones":[],"decor":[],"spawn":{"x":0,"y":0}}}`) // floors missing
}

// marshal + unmarshal into a generic map for shape assertions
func encoded(t *testing.T, msg any) map[string]any {
	t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	return out
}

func TestDecodeInviteEmail(t *testing.T) {
	// invites are keyed by lowercased email (ADR 0003): the decoder trims and
	// lowercases, matching the TS inviteEmailSchema transforms
	m := mustDecode[inviteMsg](t, `{"type":"invite","token":"tok","slug":"deck-42","email":"  Kane@Nostromo.IO "}`)
	if m.Token != "tok" || m.Slug != "deck-42" || m.Email != "kane@nostromo.io" {
		t.Errorf("invite fields wrong: %+v", m)
	}
	c := mustDecode[cancelInviteMsg](t, `{"type":"cancelInvite","token":"tok","slug":"deck-42","email":"kane@nostromo.io"}`)
	if c.Email != "kane@nostromo.io" {
		t.Errorf("cancelInvite fields wrong: %+v", c)
	}
	// shapeless addresses are refused: empty, no @, dangling halves, spaces
	for _, email := range []string{`""`, `"kane"`, `"kane@"`, `"@nostromo.io"`, `"kane @nostromo.io"`} {
		mustReject(t, `{"type":"invite","token":"tok","slug":"deck-42","email":`+email+`}`)
	}
	mustReject(t, `{"type":"invite","token":"tok","slug":"deck-42"}`)
}

func TestDecodeInviteResolutions(t *testing.T) {
	a := mustDecode[acceptInviteMsg](t, `{"type":"acceptInvite","token":"tok","slug":"deck-42"}`)
	if a.Token != "tok" || a.Slug != "deck-42" {
		t.Errorf("acceptInvite fields wrong: %+v", a)
	}
	mustDecode[declineInviteMsg](t, `{"type":"declineInvite","token":"tok","slug":"deck-42"}`)
	mustDecode[listPendingMsg](t, `{"type":"listPending","token":"tok"}`)
	mustReject(t, `{"type":"acceptInvite","token":"tok","slug":"Bad Slug"}`)
	mustReject(t, `{"type":"listPending"}`)
}

func TestDecodeJoinRequestMessages(t *testing.T) {
	// requestJoin carries a workspace NAME (resolved via deriveSlug), bounded
	// and trimmed like createWorkspace's
	r := mustDecode[requestJoinMsg](t, `{"type":"requestJoin","token":"tok","name":"  Deep Space Crew  "}`)
	if r.Token != "tok" || r.Name != "Deep Space Crew" {
		t.Errorf("requestJoin fields wrong: %+v", r)
	}
	mustDecode[cancelRequestMsg](t, `{"type":"cancelRequest","token":"tok","slug":"deck-42"}`)
	ap := mustDecode[approveRequestMsg](t, `{"type":"approveRequest","token":"tok","slug":"deck-42","userId":"user_2"}`)
	if ap.UserID != "user_2" {
		t.Errorf("approveRequest fields wrong: %+v", ap)
	}
	dn := mustDecode[denyRequestMsg](t, `{"type":"denyRequest","token":"tok","slug":"deck-42","userId":"user_2"}`)
	if dn.UserID != "user_2" {
		t.Errorf("denyRequest fields wrong: %+v", dn)
	}
	mustReject(t, `{"type":"requestJoin","token":"tok","name":"   "}`)
	mustReject(t, `{"type":"requestJoin","token":"tok","name":"`+strings.Repeat("x", 41)+`"}`)
	mustReject(t, `{"type":"approveRequest","token":"tok","slug":"deck-42"}`)
}

func TestEncodeMemberListPendingArrays(t *testing.T) {
	// empty invites/requests must encode as JSON arrays, not null — the zod
	// memberList schema requires arrays (notes/015)
	msg := svrMemberList{Type: "memberList", Slug: "a", Members: []MemberEntry{}, Banned: []MemberEntry{}, Invites: []string{}, Requests: []MemberEntry{}}
	out := encoded(t, msg)
	for _, key := range []string{"members", "banned", "invites", "requests"} {
		if _, ok := out[key].([]any); !ok {
			t.Errorf("%s must encode as a JSON array, got %T", key, out[key])
		}
	}
	pending := svrPendingList{Type: "pendingList", Invites: []WorkspaceInfo{}, Requests: []WorkspaceInfo{}}
	out = encoded(t, pending)
	for _, key := range []string{"invites", "requests"} {
		if _, ok := out[key].([]any); !ok {
			t.Errorf("pendingList %s must encode as a JSON array, got %T", key, out[key])
		}
	}
}

func TestEncodePlayerNullAndOptionalFields(t *testing.T) {
	p := &Player{ID: "p1", UserID: "u1", Name: "kira", Status: "available", Character: defaultCharacter}
	out := encoded(t, p)
	// zoneId and shipPad are required-nullable: the keys must be present as null
	if v, ok := out["zoneId"]; !ok || v != nil {
		t.Error("zoneId must encode as explicit null")
	}
	if v, ok := out["shipPad"]; !ok || v != nil {
		t.Error("shipPad must encode as explicit null")
	}
	// shipA is optional: absent until set
	if _, ok := out["shipA"]; ok {
		t.Error("unset shipA must be omitted")
	}
	heading := 0.5
	zone := "bridge"
	pad := 1
	p.ShipA = &heading
	p.ZoneID = &zone
	p.ShipPad = &pad
	out = encoded(t, p)
	if out["shipA"] != 0.5 || out["zoneId"] != "bridge" || out["shipPad"] != float64(1) {
		t.Errorf("set fields must encode: %v", out)
	}
}

func TestEncodeIceServerOptionalFields(t *testing.T) {
	out := encoded(t, stunServer())
	if _, ok := out["username"]; ok {
		t.Error("STUN entry must omit username")
	}
	if _, ok := out["credential"]; ok {
		t.Error("STUN entry must omit credential")
	}
}

func TestEncodeWelcomeShape(t *testing.T) {
	room := newRoomState(testGrace)
	player, token := room.join(joinInput{userID: "u1", name: "kira", micOn: true, character: defaultCharacter}, testSpawn, "", sock("s"))
	msg := svrWelcome{
		Type:        "welcome",
		SelfID:      player.ID,
		Workspace:   WorkspaceInfo{Slug: "deep-space", Name: "Deep Space"},
		Owner:       true,
		Map:         zonedMap,
		Roster:      room.roster(),
		ResumeToken: token,
		IceServers:  mintIceServers(nil, 0),
		Pods:        []PodClaim{},
		Chat:        room.chatHistory(),
	}
	out := encoded(t, msg)
	if out["type"] != "welcome" || out["selfId"] != player.ID {
		t.Errorf("welcome envelope wrong: %v", out)
	}
	// empty collections must be JSON arrays, not null — zod requires arrays
	for _, key := range []string{"roster", "iceServers", "pods", "chat"} {
		if _, ok := out[key].([]any); !ok {
			t.Errorf("%s must encode as a JSON array, got %T", key, out[key])
		}
	}
	// the map's empty pads/zones arrays must stay arrays too
	mp := out["map"].(map[string]any)
	for _, key := range []string{"floors", "zones", "decor", "pads"} {
		if _, ok := mp[key].([]any); !ok {
			t.Errorf("map.%s must encode as a JSON array, got %T", key, mp[key])
		}
	}
}

func TestEncodeChatZoneNull(t *testing.T) {
	msg := svrChat{Type: "chat", Message: ChatMessage{ID: "c1", From: "p1", Name: "kira", Scope: "ship", Text: "hi", Ts: 5}}
	out := encoded(t, msg)["message"].(map[string]any)
	if v, ok := out["zoneId"]; !ok || v != nil {
		t.Error("ship chat zoneId must encode as explicit null")
	}
}

func TestDecodeItemMessages(t *testing.T) {
	// placing names a library kind and a deck point (notes/017)
	p := mustDecode[placeItemMsg](t, `{"type":"placeItem","kind":"plant","x":900,"y":-620.5,"scale":1.4}`)
	if p.Kind != "plant" || p.X != 900 || p.Y != -620.5 || p.Scale != 1.4 {
		t.Errorf("placeItem fields wrong: %+v", p)
	}
	// an absent scale means the authored size; an out-of-range one is clamped
	if d := mustDecode[placeItemMsg](t, `{"type":"placeItem","kind":"plant","x":1,"y":2}`); d.Scale != 1 {
		t.Errorf("placeItem without a scale got %v, want 1", d.Scale)
	}
	if d := mustDecode[placeItemMsg](t, `{"type":"placeItem","kind":"plant","x":1,"y":2,"scale":99}`); d.Scale != itemScaleMax {
		t.Errorf("oversized placeItem got %v, want %v", d.Scale, itemScaleMax)
	}
	sc := mustDecode[scaleItemMsg](t, `{"type":"scaleItem","id":"it_1","scale":0.2}`)
	if sc.ID != "it_1" || sc.Scale != itemScaleMin {
		t.Errorf("scaleItem fields wrong: %+v", sc)
	}
	// the stacking nudge is clamped the same way the size is
	rs := mustDecode[raiseItemMsg](t, `{"type":"raiseItem","id":"it_1","depth":-20}`)
	if rs.ID != "it_1" || rs.Depth != -20 {
		t.Errorf("raiseItem fields wrong: %+v", rs)
	}
	if d := mustDecode[raiseItemMsg](t, `{"type":"raiseItem","id":"it_1","depth":9000}`); d.Depth != itemDepthMax {
		t.Errorf("over-nudged raiseItem got %v, want %v", d.Depth, itemDepthMax)
	}
	// a color is folded to one canonical form, and anything unparseable — an
	// absent field, a name, a forged value — means the color the art was drawn
	// in, which is the nil the client renders as its authored palette
	for _, tc := range []struct{ in, want string }{
		{`{"type":"colorItem","id":"it_1","color":"#3D6B8E"}`, "#3d6b8e"},
		{`{"type":"colorItem","id":"it_1","color":" #f0a "}`, "#ff00aa"},
	} {
		got := mustDecode[colorItemMsg](t, tc.in)
		if got.Color == nil || *got.Color != tc.want {
			t.Errorf("colorItem %s got %v, want %s", tc.in, got.Color, tc.want)
		}
	}
	for _, in := range []string{
		`{"type":"colorItem","id":"it_1","color":null}`,
		`{"type":"colorItem","id":"it_1"}`,
		`{"type":"colorItem","id":"it_1","color":"red"}`,
		`{"type":"colorItem","id":"it_1","color":"#gggggg"}`,
	} {
		if got := mustDecode[colorItemMsg](t, in); got.Color != nil {
			t.Errorf("colorItem %s got %v, want the authored color", in, *got.Color)
		}
	}
	if pc := mustDecode[placeItemMsg](t, `{"type":"placeItem","kind":"plant","x":1,"y":2,"color":"#ABCDEF"}`); pc.Color == nil || *pc.Color != "#abcdef" {
		t.Errorf("placeItem color wrong: %+v", pc.Color)
	}
	if pc := mustDecode[placeItemMsg](t, `{"type":"placeItem","kind":"plant","x":1,"y":2}`); pc.Color != nil {
		t.Errorf("placeItem without a color got %v, want the authored color", *pc.Color)
	}
	mv := mustDecode[moveItemMsg](t, `{"type":"moveItem","id":"it_1","x":10,"y":20}`)
	if mv.ID != "it_1" || mv.X != 10 || mv.Y != 20 {
		t.Errorf("moveItem fields wrong: %+v", mv)
	}
	d := mustDecode[deleteItemMsg](t, `{"type":"deleteItem","id":"it_1"}`)
	if d.ID != "it_1" {
		t.Errorf("deleteItem fields wrong: %+v", d)
	}
	// a kind outside the library, or a missing coordinate/id, is refused
	mustReject(t, `{"type":"placeItem","kind":"sofa","x":1,"y":2}`)
	mustReject(t, `{"type":"placeItem","x":1,"y":2}`)
	mustReject(t, `{"type":"placeItem","kind":"plant","x":1}`)
	mustReject(t, `{"type":"moveItem","id":"","x":1,"y":2}`)
	mustReject(t, `{"type":"moveItem","id":"it_1","y":2}`)
	mustReject(t, `{"type":"scaleItem","id":"it_1"}`)
	mustReject(t, `{"type":"scaleItem","scale":1.5}`)
	mustReject(t, `{"type":"raiseItem","id":"it_1"}`)
	mustReject(t, `{"type":"raiseItem","depth":20}`)
	mustReject(t, `{"type":"colorItem","color":"#3d6b8e"}`)
	mustReject(t, `{"type":"deleteItem"}`)
}

func TestEncodeItemBroadcasts(t *testing.T) {
	// the client's zod schemas key on these exact field names
	raw, err := json.Marshal(svrItemPlaced{
		Type: "itemPlaced",
		Item: PlacedItem{ID: "it_1", Kind: "lamp", X: 4, Y: 5, Scale: 1.4, Depth: 20},
	})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	want := `{"type":"itemPlaced","item":{"id":"it_1","kind":"lamp","x":4,"y":5,"scale":1.4,"depth":20,"color":null}}`
	if string(raw) != want {
		t.Errorf("itemPlaced encoded %s, want %s", raw, want)
	}
	scaled, err := json.Marshal(svrItemScaled{Type: "itemScaled", ID: "it_1", Scale: 2.5})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if string(scaled) != `{"type":"itemScaled","id":"it_1","scale":2.5}` {
		t.Errorf("itemScaled encoded %s", scaled)
	}
	raised, err := json.Marshal(svrItemRaised{Type: "itemRaised", ID: "it_1", Depth: -20})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if string(raised) != `{"type":"itemRaised","id":"it_1","depth":-20}` {
		t.Errorf("itemRaised encoded %s", raised)
	}
	rejected, err := json.Marshal(svrItemRejected{Type: "itemRejected", Reason: "notYourPod"})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(rejected), `"reason":"notYourPod"`) {
		t.Errorf("itemRejected encoded %s", rejected)
	}
}

// --- space link (workspace linking) ---

func TestDecodeSpaceLinkMessages(t *testing.T) {
	mustDecode[spaceLinkMsg](t, `{"type":"spaceLink"}`)
	if m := mustDecode[linkRequestMsg](t, `{"type":"linkRequest","name":"Deep Space Crew"}`); m.Name != "Deep Space Crew" {
		t.Errorf("linkRequest name wrong: %+v", m)
	}
	if m := mustDecode[linkBlockMsg](t, `{"type":"linkBlock","name":" Deck 42 "}`); m.Name != "Deck 42" {
		t.Errorf("linkBlock name must be trimmed: %+v", m)
	}
	if m := mustDecode[linkCancelMsg](t, `{"type":"linkCancel","slug":"deck-42"}`); m.Slug != "deck-42" {
		t.Errorf("linkCancel slug wrong: %+v", m)
	}
	mustDecode[linkAcceptMsg](t, `{"type":"linkAccept","slug":"deck-42"}`)
	mustDecode[linkDenyMsg](t, `{"type":"linkDeny","slug":"deck-42"}`)
	mustDecode[linkRemoveMsg](t, `{"type":"linkRemove","slug":"deck-42"}`)
	mustDecode[linkUnblockMsg](t, `{"type":"linkUnblock","slug":"deck-42"}`)
	if m := mustDecode[visitMsg](t, `{"type":"visit","slug":"deck-42"}`); m.Slug != "deck-42" {
		t.Errorf("visit slug wrong: %+v", m)
	}
	// names bound like createWorkspace's, slugs like every other slug field
	mustReject(t, `{"type":"linkRequest","name":"   "}`)
	mustReject(t, `{"type":"linkAccept","slug":"Bad Slug"}`)
	mustReject(t, `{"type":"visit"}`)
}

func TestDecodeResumeVisited(t *testing.T) {
	// visited absent: an at-home resume
	m := mustDecode[resumeMsg](t, `{"type":"resume","token":"tok","workspace":"alpha","micOn":true,"camOn":false}`)
	if m.Visited != "" {
		t.Errorf("absent visited must decode empty: %+v", m)
	}
	// visited present: the drop happened mid-Visit (ADR 0004)
	m = mustDecode[resumeMsg](t, `{"type":"resume","token":"tok","workspace":"alpha","visited":"deck-42","micOn":true,"camOn":false}`)
	if m.Visited != "deck-42" {
		t.Errorf("visited wrong: %+v", m)
	}
	mustReject(t, `{"type":"resume","token":"tok","workspace":"alpha","visited":"Bad Slug","micOn":true,"camOn":false}`)
}

func TestEncodePlayerVisitingFrom(t *testing.T) {
	// required-nullable like zoneId: members carry an explicit null
	p := &Player{ID: "p1", UserID: "u1", Name: "kira", Status: "available", Character: defaultCharacter}
	out := encoded(t, p)
	if v, ok := out["visitingFrom"]; !ok || v != nil {
		t.Error("visitingFrom must encode as explicit null for members")
	}
	home := "Deep Space Crew"
	p.VisitingFrom = &home
	if out = encoded(t, p); out["visitingFrom"] != home {
		t.Errorf("a visitor's badge must encode: %v", out["visitingFrom"])
	}
}
