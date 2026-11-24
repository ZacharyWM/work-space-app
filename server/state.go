// in-memory presence state (port of server/src/state.ts): roster of connected
// players keyed by id. All access is serialized by main's global state mutex —
// this file assumes the caller holds it
package main

import (
	"math"

	gonanoid "github.com/matoous/go-nanoid/v2"
)

// golden-angle increment (degrees) spreads consecutive avatar hues maximally apart
const goldenAngle = 137.508

// hard cap on concurrent Visitors aboard one workspace (space link feature,
// Q11): checked live at traversal only — a guardrail bounding the A/V mesh,
// never blocking members from their own workspace
const maxVisitorsPerWorkspace = 10

// ship-scoped chat kept for joiners; older messages roll off
const chatHistoryMax = 100

// the transport side of a session: main's *client implements it, tests fake it
type playerConn interface {
	// marshal + queue one message; a dead connection drops it silently
	send(msg any)
	// close with a websocket close frame (the polite kick)
	close()
	// drop the underlying connection immediately (heartbeat/takeover)
	terminate()
	// false once the connection is closed or closing — sessions must not be
	// created for a socket that died during the join's db calls
	isOpen() bool
}

// one connected player plus their transport
type session struct {
	player *Player
	sock   playerConn
	// secret issued in the welcome; proves ownership of this session on resume
	resumeToken string
	// clerk user id behind this session; keys the db profile writes
	userID string
	// the session's home workspace (space link feature): the one boarded via
	// URL/picker. Differs from the room's wid exactly while this person is a
	// Visitor; slug/name ride along for re-boards and the overlay
	homeID   string
	homeSlug string
	homeName string
}

// a dropped player held for the grace window, keyed by resume token
type parkedPlayer struct {
	player *Player
	// clerk user id, restored onto the session on resume
	userID string
	// home workspace, restored onto the session on resume — a Visit resumes
	// in place (space link feature, ADR 0004)
	homeID   string
	homeSlug string
	homeName string
	// past this timestamp (ms) the session is gone for good
	expiresAt int64
}

type roomState struct {
	// the workspace this room serves, stamped by the registry; "" only in
	// tests that build a room directly — leaderboard writes skip then
	wid string
	// every connected player, keyed by assigned id
	sessions map[string]*session
	// session ids in insertion order — JS Maps iterate in insertion order and
	// the roster/broadcast order rode on that, so it's kept explicit here
	order []string
	// dropped players awaiting resume, keyed by resume token
	parked map[string]*parkedPlayer
	// total joins ever (never decremented) — drives hue assignment
	joinCount int
	// recent ship-scoped chat, oldest first; welcome hands it to joiners.
	// in-memory like the roster: chat is session chatter, not a record
	chatLog []ChatMessage
	// this workspace's live map: loaded from the db by the first join and
	// replaced by owner edits; nil until then — handlers fall back to the
	// default ship
	roomMap *MapData
	// the shuttle race lobby / running race; nil = idle (shuttle race feature)
	race *raceState
	// the shuttle blasters lobby / running match; nil = idle (shuttle blasters feature)
	blast *blastState
	// how long a dropped player stays resumable
	graceMs int64
}

func newRoomState(graceMs int64) *roomState {
	return &roomState{
		sessions: map[string]*session{},
		parked:   map[string]*parkedPlayer{},
		graceMs:  graceMs,
	}
}

// what join needs to admit a player; name + character come from the user's db
// profile, userID from the verified clerk token. The home fields name the
// session's home workspace ("" in tests that build rooms directly); status and
// visitingFrom carry across a portal traversal (space link feature)
type joinInput struct {
	userID    string
	name      string
	micOn     bool
	camOn     bool
	character Character
	// self-set presence status; "" boards as "available"
	status string
	// the home Workspace's name while boarding as a Visitor; nil for members
	visitingFrom *string
	homeID       string
	homeSlug     string
	homeName     string
}

// admit a player: assign id + hue + resume token, place at spawn; zoneID is
// computed by the caller ("" = open space)
func (r *roomState) join(input joinInput, spawn Point, zoneID string, sock playerConn) (*Player, string) {
	// a fresh board is available; a portal traversal carries the status along
	status := input.status
	if status == "" {
		status = "available"
	}
	player := &Player{
		ID:     gonanoid.Must(),
		UserID: input.userID,
		Name:   input.name,
		X:      spawn.X,
		Y:      spawn.Y,
		ZoneID: optStr(zoneID),
		Hue:    math.Mod(float64(r.joinCount)*goldenAngle, 360),
		MicOn:  input.micOn,
		CamOn:  input.camOn,
		// nobody boards mid-share; the screenShare message flips this
		Speaking:  false,
		ScreenOn:  false,
		Status:    status,
		Character: input.character,
		// everyone boards on foot; a shuttle is taken via the ship message
		ShipPad: nil,
		// set while boarding as a Visitor (space link feature)
		VisitingFrom: input.visitingFrom,
	}
	r.joinCount++
	resumeToken := gonanoid.Must()
	r.sessions[player.ID] = &session{
		player: player, sock: sock, resumeToken: resumeToken, userID: input.userID,
		homeID: input.homeID, homeSlug: input.homeSlug, homeName: input.homeName,
	}
	r.order = append(r.order, player.ID)
	return player, resumeToken
}

// drop one id from the insertion-order list (park/evict)
func (r *roomState) dropOrder(id string) {
	for i, v := range r.order {
		if v == id {
			r.order = append(r.order[:i], r.order[i+1:]...)
			return
		}
	}
}

// "" ↔ nil bridging for the wire's nullable zone id
func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// nil ↔ "" bridging when comparing zone membership
func strOf(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// move a dropped player out of the roster into the grace map; nil if the id
// is unknown
func (r *roomState) park(id string, now int64) *Player {
	s, ok := r.sessions[id]
	if !ok {
		return nil
	}
	delete(r.sessions, id)
	r.dropOrder(id)
	r.parked[s.resumeToken] = &parkedPlayer{
		player: s.player, userID: s.userID,
		homeID: s.homeID, homeSlug: s.homeSlug, homeName: s.homeName,
		expiresAt: now + r.graceMs,
	}
	return s.player
}

// re-admit a parked player on a new socket; nil when the token is unknown or
// the grace window has passed — expired entries are dropped so a second
// attempt can't succeed either
func (r *roomState) resume(token string, sock playerConn, now int64) *Player {
	entry, ok := r.parked[token]
	if !ok {
		return nil
	}
	delete(r.parked, token)
	if now >= entry.expiresAt {
		return nil
	}
	r.sessions[entry.player.ID] = &session{
		player: entry.player, sock: sock, resumeToken: token, userID: entry.userID,
		homeID: entry.homeID, homeSlug: entry.homeSlug, homeName: entry.homeName,
	}
	r.order = append(r.order, entry.player.ID)
	return entry.player
}

// remove a session outright — no parking, so its resume token dies with it.
// Used when the account boards elsewhere (one active session per account)
func (r *roomState) evict(id string) *Player {
	s, ok := r.sessions[id]
	if !ok {
		return nil
	}
	delete(r.sessions, id)
	r.dropOrder(id)
	return s.player
}

// every live session this clerk user holds — the single-session rule scans
// these across rooms before a fresh join lands
func (r *roomState) sessionsOfUser(userID string) []*session {
	var out []*session
	for _, id := range r.order {
		if s := r.sessions[id]; s != nil && s.userID == userID {
			out = append(out, s)
		}
	}
	return out
}

// drop this user's parked entries so their tokens can't resume after the
// account boards elsewhere
func (r *roomState) dropParkedOfUser(userID string) {
	for token, entry := range r.parked {
		if entry.userID == userID {
			delete(r.parked, token)
		}
	}
}

// --- visitors (space link feature) ---

// how many Visitors are live aboard: sessions whose home isn't this room's
// workspace — the traversal cap counts these ("" home = tests, never a visitor)
func (r *roomState) visitorCount() int {
	n := 0
	for _, s := range r.sessions {
		if s.homeID != "" && s.homeID != r.wid {
			n++
		}
	}
	return n
}

// every live Visitor session admitted from the given home workspace — the
// removal of a Link kicks these, both directions
func (r *roomState) visitorSessionsOf(homeID string) []*session {
	var out []*session
	for _, id := range r.order {
		if s := r.sessions[id]; s != nil && s.homeID == homeID && s.homeID != r.wid {
			out = append(out, s)
		}
	}
	return out
}

// drop parked Visitors admitted from the given home workspace, so their
// tokens can't resume a Visit whose Link (or home) is gone
func (r *roomState) dropParkedOfHome(homeID string) {
	if homeID == r.wid {
		return
	}
	for token, entry := range r.parked {
		if entry.homeID == homeID {
			delete(r.parked, token)
		}
	}
}

// the clerk user + home workspace behind a parked (or stale live) token,
// peeked without consuming the entry — a Visitor's resume re-checks
// membership/link/ban in the db before the takeover, and those checks need
// the identity first ("" = unknown token)
func (r *roomState) parkedOwnerOf(token string) (userID, homeID string) {
	if entry, ok := r.parked[token]; ok {
		return entry.userID, entry.homeID
	}
	if s := r.sessionOfToken(token); s != nil {
		return s.userID, s.homeID
	}
	return "", ""
}

// every live session — workspace deletion kicks the whole room
func (r *roomState) allSessions() []*session {
	out := make([]*session, 0, len(r.sessions))
	for _, id := range r.order {
		if s := r.sessions[id]; s != nil {
			out = append(out, s)
		}
	}
	return out
}

// live session holding this token, if any — a resume arriving before the old
// socket's death was detected must take that session over
func (r *roomState) sessionOfToken(token string) *session {
	for _, s := range r.sessions {
		if s.resumeToken == token {
			return s
		}
	}
	return nil
}

// drop parked players whose grace window has passed (memory hygiene — resume
// already checks expiry itself)
func (r *roomState) sweepParked(now int64) {
	for token, entry := range r.parked {
		if now >= entry.expiresAt {
			delete(r.parked, token)
		}
	}
}

// outcome of a position/ship update: whether the zone changed and the zone it
// changed from (drives the pairing diff); "" = open space
type zoneChange struct {
	zoneChanged    bool
	previousZoneID string
}

// move a player and set the zone the caller computed for that position; nil
// if the id is unknown. a is the shuttle heading, carried in in-flight pos
// updates so late joiners see it
func (r *roomState) updatePos(id string, x, y float64, zoneID string, a *float64) *zoneChange {
	s, ok := r.sessions[id]
	if !ok {
		return nil
	}
	s.player.X = x
	s.player.Y = y
	if a != nil {
		s.player.ShipA = a
	}
	previous := strOf(s.player.ZoneID)
	s.player.ZoneID = optStr(zoneID)
	return &zoneChange{zoneChanged: previous != zoneID, previousZoneID: previous}
}

// board or dock a shuttle and set the zone the caller computed (flying is
// always zone-less; docking re-derives from position); nil if the id is unknown
func (r *roomState) updateShip(id string, pad *int, zoneID string) *zoneChange {
	s, ok := r.sessions[id]
	if !ok {
		return nil
	}
	s.player.ShipPad = pad
	previous := strOf(s.player.ZoneID)
	s.player.ZoneID = optStr(zoneID)
	return &zoneChange{zoneChanged: previous != zoneID, previousZoneID: previous}
}

// store a player's mic/cam toggles; false if the id is unknown
func (r *roomState) updateMedia(id string, micOn, camOn bool) bool {
	s, ok := r.sessions[id]
	if !ok {
		return false
	}
	s.player.MicOn = micOn
	s.player.CamOn = camOn
	return true
}

// store a player's speaking flag; false if the id is unknown
func (r *roomState) updateSpeaking(id string, on bool) bool {
	s, ok := r.sessions[id]
	if !ok {
		return false
	}
	s.player.Speaking = on
	return true
}

// store a player's screen-share flag; false if the id is unknown
func (r *roomState) updateScreen(id string, on bool) bool {
	s, ok := r.sessions[id]
	if !ok {
		return false
	}
	s.player.ScreenOn = on
	return true
}

// store a player's presence status; false if the id is unknown
func (r *roomState) updateStatus(id string, status string) bool {
	s, ok := r.sessions[id]
	if !ok {
		return false
	}
	s.player.Status = status
	return true
}

// store a player's appearance; false if the id is unknown
func (r *roomState) updateCharacter(id string, character Character) bool {
	s, ok := r.sessions[id]
	if !ok {
		return false
	}
	s.player.Character = character
	return true
}

// store a player's display name; false if the id is unknown
func (r *roomState) updateName(id, name string) bool {
	s, ok := r.sessions[id]
	if !ok {
		return false
	}
	s.player.Name = name
	return true
}

// append a ship-scoped message to the history, rolling the oldest off past
// the cap; zone-scoped chat is live-only and never lands here
func (r *roomState) addChat(message ChatMessage) {
	r.chatLog = append(r.chatLog, message)
	if len(r.chatLog) > chatHistoryMax {
		r.chatLog = r.chatLog[1:]
	}
}

// the retained ship-scoped chat, oldest first (the welcome payload); never nil
// so the welcome always carries a JSON array
func (r *roomState) chatHistory() []ChatMessage {
	if r.chatLog == nil {
		return []ChatMessage{}
	}
	return r.chatLog
}

// true when the room holds nothing worth keeping: no live sessions and no
// parked players awaiting resume — the registry reaps such rooms
func (r *roomState) isEmpty() bool {
	return len(r.sessions) == 0 && len(r.parked) == 0
}

// everyone currently aboard (the welcome roster); never nil for the wire
func (r *roomState) roster() []*Player {
	out := make([]*Player, 0, len(r.sessions))
	for _, id := range r.order {
		if s := r.sessions[id]; s != nil {
			out = append(out, s.player)
		}
	}
	return out
}

// every session except the given id (broadcast targets — no echo)
func (r *roomState) othersOf(id string) []*session {
	var out []*session
	for _, sid := range r.order {
		if s := r.sessions[sid]; s != nil && s.player.ID != id {
			out = append(out, s)
		}
	}
	return out
}

// one session by id (signal relay + pair directives)
func (r *roomState) sessionOf(id string) *session {
	return r.sessions[id]
}
