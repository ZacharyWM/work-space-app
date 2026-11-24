// server entry (port of server/src/index.ts): websocket presence —
// join/welcome/pos/leave + heartbeat sweep, workspace rooms, pairing, chat,
// pods, and the map editor. Node serialized all state on its event loop; here
// one global mutex (server.mu) serializes room/session state instead, and
// db/clerk i/o runs outside it — the same interleaving the TS awaits allowed,
// with the same post-i/o re-checks
package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/clerk/clerk-sdk-go/v2"
	clerkuser "github.com/clerk/clerk-sdk-go/v2/user"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	gonanoid "github.com/matoous/go-nanoid/v2"
)

// dead sockets are pinged and swept on this cadence
const heartbeatInterval = 5 * time.Second

// incoming frames are tiny (editMap maps top out around tens of KB); anything
// bigger is junk and gets the connection dropped
const maxMessageBytes = 1 << 20

type server struct {
	// guards rooms and every session/player mutation + fan-out; never held
	// across db or clerk calls
	mu    sync.Mutex
	rooms *roomRegistry
	db    *db
	// the default ship layout; workspaces without an owner-edited map use it
	defaultMap *MapData
	// coturn shared secret + public hostname; nil in dev = STUN-only welcomes
	turn *turnConfig
	// how long a dropped player stays resumable (ms)
	graceMs int64
}

func main() {
	// dev secrets live in server/.env; prod injects the environment via
	// systemd (EnvironmentFile), where the file simply doesn't exist
	_ = godotenv.Load(".env")

	port := envInt("PORT", 3000)
	graceMs := envInt("GRACE_MS", 30_000)

	// clerk secret for token verification + first-join profile lookups;
	// required — there is no unauthenticated mode
	secretKey := os.Getenv("CLERK_SECRET_KEY")
	if secretKey == "" {
		log.Fatal("CLERK_SECRET_KEY is required (server/.env in dev, /etc/workspace.env in prod)")
	}
	clerk.SetKey(secretKey)

	// user profile storage; dev default matches the local homebrew postgres
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://localhost:5432/deep-space"
	}

	// both must be set for TURN; unset (dev) means welcomes carry STUN only
	var turn *turnConfig
	if s, h := os.Getenv("TURN_SECRET"), os.Getenv("TURN_HOST"); s != "" && h != "" {
		turn = &turnConfig{secret: s, host: h}
	}

	// the default ship layout lives at the repo root; the working directory is
	// server/ in both dev (npm run server:dev) and prod (systemd)
	mapPath := os.Getenv("MAP_PATH")
	if mapPath == "" {
		mapPath = "../map.json"
	}
	rawMap, err := os.ReadFile(mapPath)
	if err != nil {
		log.Fatalf("cannot read default map: %v", err)
	}
	defaultMap, err := parseMapData(rawMap)
	if err != nil {
		log.Fatalf("default map invalid: %v", err)
	}
	// fail fast before accepting clients: overlapping zones make membership ambiguous
	if err := validateZonesDisjoint(defaultMap); err != nil {
		log.Fatalf("default map invalid: %v", err)
	}

	// schema before sockets: a client can't join ahead of the users table
	ctx := context.Background()
	database, err := newDb(ctx, databaseURL)
	if err != nil {
		log.Fatalf("db connect failed: %v", err)
	}
	if err := database.ensureSchema(ctx); err != nil {
		log.Fatalf("db schema failed: %v", err)
	}
	// time-tracking rows the previous process left open (crash/deploy skips
	// the close cleanup) get closed at boot
	if n, err := database.closeDanglingSessions(ctx); err != nil {
		log.Fatalf("dangling session sweep failed: %v", err)
	} else if n > 0 {
		log.Printf("closed %d dangling workspace session(s)", n)
	}

	s := &server{
		rooms:      newRoomRegistry(int64(graceMs)),
		db:         database,
		defaultMap: defaultMap,
		turn:       turn,
		graceMs:    int64(graceMs),
	}

	// expired parked players just get dropped — everyone already saw their
	// playerLeft when they were parked; rooms left fully empty by the sweep
	// are reaped with them
	go func() {
		ticker := time.NewTicker(time.Duration(graceMs) * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			s.mu.Lock()
			// end races past their time cap: an AFK racer must not wedge the
			// lobby forever (still-out racers DNF)
			for _, room := range s.rooms.all() {
				if room.race != nil && room.race.racing && nowMs() >= room.race.deadline {
					s.endRace(room)
				}
				// blasters matches get the same cap; survivors tie
				if room.blast != nil && room.blast.playing && nowMs() >= room.blast.deadline {
					s.endBlast(room)
				}
			}
			before := s.rooms.size()
			s.rooms.sweep(nowMs())
			reaped := before - s.rooms.size()
			remain := s.rooms.size()
			s.mu.Unlock()
			if reaped > 0 {
				log.Printf("reaped %d empty room(s); %d remain", reaped, remain)
			}
		}
	}()

	// browsers enforce nothing useful in Origin for ws and the Node server
	// never checked it either; auth is the clerk token on every join
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("upgrade failed: %v", err)
			return
		}
		go s.handleConn(conn)
	})

	log.Printf("server listening on ws://localhost:%d", port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", port), nil))
}

// integer env var with a default (PORT, GRACE_MS)
func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// ms since epoch, the timestamp unit the TS server used throughout
func nowMs() int64 { return time.Now().UnixMilli() }

// per-connection read loop + close cleanup
func (s *server) handleConn(conn *websocket.Conn) {
	conn.SetReadLimit(maxMessageBytes)
	c := newClient(conn)
	go c.writeLoop()
	go c.heartbeat()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		s.handleMessage(c, raw)
	}
	c.terminate()

	// the stay ends with the socket — this covers leaves, kicks, evictions,
	// and resume takeovers, since every one of them closes the old socket.
	// Sync in this dying goroutine, before the lock, like the other db i/o
	if c.sessionRowID != "" {
		if err := s.db.endWorkspaceSession(context.Background(), c.sessionRowID); err != nil {
			log.Printf("workspace session end failed (%s): %v", c.sessionRowID, err)
		}
		c.sessionRowID = ""
	}

	// covers explicit close, heartbeat terminate, and transport drops; the
	// player is parked for the grace window, not removed
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.selfID == "" || c.room == nil {
		return
	}
	// a resume takeover replaced this socket — the session is no longer ours to park
	if sess := c.room.sessionOf(c.selfID); sess != nil && sess.sock != playerConn(c) {
		return
	}
	s.parkAndAnnounce(c.room, c.selfID)
	c.selfID = ""
	c.room = nil
	c.workspaceID = ""
	c.isOwner = false
	c.homeID = ""
	c.homeSlug = ""
	c.homeName = ""
}

// decode + dispatch; bad input is logged and dropped, never crashes
func (s *server) handleMessage(c *client, raw []byte) {
	msg, err := decodeClientMessage(raw)
	if err != nil {
		log.Printf("dropped bad message: %v", err)
		return
	}
	switch m := msg.(type) {
	case joinMsg:
		s.handleJoin(c, m)
	case resumeMsg:
		s.handleResume(c, m)
	case listWorkspacesMsg:
		s.handleListWorkspaces(c, m)
	case createWorkspaceMsg:
		s.handleCreateWorkspace(c, m)
	case deleteWorkspaceMsg:
		s.handleDeleteWorkspace(c, m)
	case listMembersMsg:
		s.handleListMembers(c, m)
	case removeMemberMsg:
		s.handleRemoveMember(c, m)
	case unbanMemberMsg:
		s.handleUnbanMember(c, m)
	case inviteMsg:
		s.handleInvite(c, m)
	case cancelInviteMsg:
		s.handleCancelInvite(c, m)
	case listPendingMsg:
		s.handleListPending(c, m)
	case acceptInviteMsg:
		s.handleAcceptInvite(c, m)
	case declineInviteMsg:
		s.handleDeclineInvite(c, m)
	case requestJoinMsg:
		s.handleRequestJoin(c, m)
	case cancelRequestMsg:
		s.handleCancelRequest(c, m)
	case approveRequestMsg:
		s.handleApproveRequest(c, m)
	case denyRequestMsg:
		s.handleDenyRequest(c, m)
	case posMsg:
		s.handlePos(c, m)
	case shipMsg:
		s.handleShip(c, m)
	case mediaStateMsg:
		s.handleMediaState(c, m)
	case speakingMsg:
		s.handleSpeaking(c, m)
	case screenShareMsg:
		s.handleScreenShare(c, m)
	case characterMsg:
		s.handleCharacter(c, m)
	case statusMsg:
		s.handleStatus(c, m)
	case renameMsg:
		s.handleRename(c, m)
	case waveMsg:
		s.handleWave(c, m)
	case chatClientMsg:
		s.handleChat(c, m)
	case emoteMsg:
		s.handleEmote(c, m)
	case claimPodMsg:
		s.handleClaimPod(c, m)
	case releasePodMsg:
		s.handleReleasePod(c)
	case placeItemMsg:
		s.handlePlaceItem(c, m)
	case moveItemMsg:
		s.handleMoveItem(c, m)
	case scaleItemMsg:
		s.handleScaleItem(c, m)
	case colorItemMsg:
		s.handleColorItem(c, m)
	case raiseItemMsg:
		s.handleRaiseItem(c, m)
	case deleteItemMsg:
		s.handleDeleteItem(c, m)
	case raceJoinMsg:
		s.handleRaceJoin(c)
	case raceLeaveMsg:
		s.handleRaceLeave(c)
	case raceReadyMsg:
		s.handleRaceReady(c, m)
	case raceStartMsg:
		s.handleRaceStart(c)
	case raceProgressMsg:
		s.handleRaceProgress(c, m)
	case blastJoinMsg:
		s.handleBlastJoin(c)
	case blastLeaveMsg:
		s.handleBlastLeave(c)
	case blastReadyMsg:
		s.handleBlastReady(c, m)
	case blastStartMsg:
		s.handleBlastStart(c)
	case blastFireMsg:
		s.handleBlastFire(c, m)
	case blastHitMsg:
		s.handleBlastHit(c, m)
	case boardCloseMsg:
		s.handleBoardClose(c, m)
	case spaceLinkMsg:
		s.handleSpaceLink(c)
	case linkRequestMsg:
		s.handleLinkRequest(c, m)
	case linkCancelMsg:
		s.handleLinkCancel(c, m)
	case linkAcceptMsg:
		s.handleLinkAccept(c, m)
	case linkDenyMsg:
		s.handleLinkDeny(c, m)
	case linkRemoveMsg:
		s.handleLinkRemove(c, m)
	case linkBlockMsg:
		s.handleLinkBlock(c, m)
	case linkUnblockMsg:
		s.handleLinkUnblock(c, m)
	case visitMsg:
		s.handleVisit(c, m)
	case editMapMsg:
		s.handleEditMap(c, m)
	case signalClientMsg:
		s.handleSignal(c, m)
	}
}

// --- helpers over room state (caller holds s.mu) ---

// send to every player in the room except the subject (no echo)
func broadcastFrom(room *roomState, id string, msg any) {
	for _, sess := range room.othersOf(id) {
		sess.sock.send(msg)
	}
}

// the players behind a session list (pairing diffs take players)
func playersOf(sessions []*session) []*Player {
	out := make([]*Player, len(sessions))
	for i, s := range sessions {
		out[i] = s.player
	}
	return out
}

// deliver a pairing diff to both members of each affected pair; initiator =
// lexicographically lower id, so both sides agree who offers
func sendPairingDiff(room *roomState, selfID string, sock playerConn, diff pairingDiff) {
	for _, peerID := range diff.disconnects {
		sock.send(svrPeerDisconnect{Type: "peerDisconnect", PeerID: peerID})
		if peer := room.sessionOf(peerID); peer != nil {
			peer.sock.send(svrPeerDisconnect{Type: "peerDisconnect", PeerID: selfID})
		}
	}
	for _, peerID := range diff.connects {
		sock.send(svrPeerConnect{Type: "peerConnect", PeerID: peerID, Initiator: isInitiator(selfID, peerID)})
		if peer := room.sessionOf(peerID); peer != nil {
			peer.sock.send(svrPeerConnect{Type: "peerConnect", PeerID: selfID, Initiator: isInitiator(peerID, selfID)})
		}
	}
}

// every co-zone pair in the roster as sorted "a|b" keys — a map edit can move
// many players' zones at once, so pairing is re-derived by diffing the full
// pair set before/after instead of per-mover diffPairs
func coZonePairs(players []*Player) map[string][2]string {
	pairs := map[string][2]string{}
	for i := 0; i < len(players); i++ {
		for j := i + 1; j < len(players); j++ {
			a, b := players[i], players[j]
			if a.ZoneID != nil && b.ZoneID != nil && *a.ZoneID == *b.ZoneID {
				if a.ID > b.ID {
					a, b = b, a
				}
				pairs[a.ID+"|"+b.ID] = [2]string{a.ID, b.ID}
			}
		}
	}
	return pairs
}

// tell a room one of its players is gone: a departure mid-zone breaks its
// pairs — only the remaining side is told (the subject's socket is gone or
// going) — and the avatar despawns; roster() already excludes the departed
func (s *server) announceDeparture(room *roomState, player *Player) {
	diff := diffPairs(audioGroupOf(player), "", room.roster())
	for _, peerID := range diff.disconnects {
		if peer := room.sessionOf(peerID); peer != nil {
			peer.sock.send(svrPeerDisconnect{Type: "peerDisconnect", PeerID: player.ID})
		}
	}
	broadcastFrom(room, player.ID, svrPlayerLeft{Type: "playerLeft", ID: player.ID})
}

// park a departed player for the grace window and tell the room they're gone;
// a resume re-announces them via the normal join broadcasts. Shared by the
// close cleanup and a resume takeover of a stale session
func (s *server) parkAndAnnounce(room *roomState, id string) {
	player := room.park(id, nowMs())
	if player == nil {
		return
	}
	s.announceDeparture(room, player)
	s.raceDeparted(room, player)
	s.blastDeparted(room, player)
	log.Printf("%s parked (%s)", player.Name, player.ID)
}

// a player left the room (park or evict): drop them from the race lobby, or
// from a running race. Called after announceDeparture, which broke their race
// comms pairs while the racing flag still held (shuttle race feature)
func (s *server) raceDeparted(room *roomState, player *Player) {
	// a departing debrief holder takes the hold with them: announceDeparture
	// already broke the pairs while the flag still named the group, and a
	// grace-window resume must not restore comms for a scoreboard the
	// refreshed client no longer shows
	if player.Debrief != nil && *player.Debrief == "race" {
		player.Debrief = nil
	}
	if room.raceLobbyDrop(player.ID) {
		s.broadcastRaceLobby(room)
		return
	}
	if !room.raceRacerDrop(player.ID) {
		return
	}
	// the race shuttle is gone with them: back on foot at the spawn so a
	// grace-window resume lands somewhere walkable
	player.Racing = false
	roomMap := s.mapOfRoom(room)
	player.X, player.Y = roomMap.Spawn.X, roomMap.Spawn.Y
	zoneID := ""
	if z := zoneAt(roomMap, player.X, player.Y); z != nil {
		zoneID = z.ID
	}
	player.ZoneID = optStr(zoneID)
	if room.raceAllDone() {
		s.endRace(room)
	}
}

// a player left the room (park or evict): drop them from the blasters lobby,
// or forfeit them out of a running match. Called after announceDeparture,
// which broke their match-comms pairs while the blasting flag still held
// (shuttle blasters feature)
func (s *server) blastDeparted(room *roomState, player *Player) {
	// a departing debrief holder takes the hold with them, like raceDeparted
	if player.Debrief != nil && *player.Debrief == "blast" {
		player.Debrief = nil
	}
	if room.blastLobbyDrop(player.ID) {
		s.broadcastBlastLobby(room)
		return
	}
	if !room.blastEliminate(player.ID) {
		return
	}
	// the match shuttle is gone with them: back on foot at the spawn so a
	// grace-window resume lands somewhere walkable
	player.Blasting = false
	roomMap := s.mapOfRoom(room)
	player.X, player.Y = roomMap.Spawn.X, roomMap.Spawn.Y
	zoneID := ""
	if z := zoneAt(roomMap, player.X, player.Y); z != nil {
		zoneID = z.ID
	}
	player.ZoneID = optStr(zoneID)
	if room.blastAllDone() {
		s.endBlast(room)
	}
}

// the full blasters lobby list to everyone aboard, so walk-ups see who's waiting
func (s *server) broadcastBlastLobby(room *roomState) {
	msg := svrBlastLobby{Type: "blastLobby", Members: room.blastMembers()}
	for _, sess := range room.allSessions() {
		sess.sock.send(msg)
	}
}

// move a player out of the match comms group: clear the flag, re-derive their
// zone from where they stand (open space mid-arena), re-pair. Caller holds s.mu
func (s *server) blastTransitionOut(r *roomState, p *Player) {
	prevGroup := audioGroupOf(p)
	p.Blasting = false
	zoneID := ""
	if z := zoneAt(s.mapOfRoom(r), p.X, p.Y); z != nil {
		zoneID = z.ID
	}
	previous := strOf(p.ZoneID)
	p.ZoneID = optStr(zoneID)
	if previous != zoneID {
		changed := svrZoneChanged{Type: "zoneChanged", ID: p.ID, ZoneID: p.ZoneID}
		for _, sess := range r.allSessions() {
			sess.sock.send(changed)
		}
	}
	sess := r.sessionOf(p.ID)
	if sess == nil {
		return
	}
	others := playersOf(r.othersOf(p.ID))
	sendPairingDiff(r, p.ID, sess.sock, diffPairs(prevGroup, audioGroupOf(p), others))
}

// the match is over: final standings to everyone, every still-flying player
// moved off the arena (their clients teleport home and report positions),
// lobby reset to idle. Caller holds s.mu
func (s *server) endBlast(r *roomState) {
	if r.blast == nil || !r.blast.playing {
		return
	}
	// standings first — the transitions below don't touch match bookkeeping,
	// but the order keeps this robust to future edits. Survivors land into
	// the debrief like the fallen: the whole field keeps match comms until
	// each closes their scoreboard
	results := r.blastResults()
	for _, sess := range r.allSessions() {
		if sess.player.Blasting {
			s.transitionToDebrief(r, sess.player, "blast")
		}
	}
	ended := svrBlastEnded{Type: "blastEnded", Results: results}
	for _, sess := range r.allSessions() {
		sess.sock.send(ended)
	}
	entries := r.blastScoreEntries()
	r.blast = nil
	s.persistScores(r, "blast", entries)
	log.Printf("blasters match ended (%d result(s))", len(results))
}

// the full lobby list to everyone aboard, so walk-ups see who's waiting
func (s *server) broadcastRaceLobby(room *roomState) {
	msg := svrRaceLobby{Type: "raceLobby", Members: room.raceMembers()}
	for _, sess := range room.allSessions() {
		sess.sock.send(msg)
	}
}

// move a player out of the race comms group: clear the flag, re-derive their
// zone from where they stand (open space mid-course), re-pair. Caller holds s.mu
func (s *server) raceTransitionOut(r *roomState, p *Player) {
	prevGroup := audioGroupOf(p)
	p.Racing = false
	zoneID := ""
	if z := zoneAt(s.mapOfRoom(r), p.X, p.Y); z != nil {
		zoneID = z.ID
	}
	previous := strOf(p.ZoneID)
	p.ZoneID = optStr(zoneID)
	if previous != zoneID {
		changed := svrZoneChanged{Type: "zoneChanged", ID: p.ID, ZoneID: p.ZoneID}
		for _, sess := range r.allSessions() {
			sess.sock.send(changed)
		}
	}
	sess := r.sessionOf(p.ID)
	if sess == nil {
		return
	}
	others := playersOf(r.othersOf(p.ID))
	sendPairingDiff(r, p.ID, sess.sock, diffPairs(prevGroup, audioGroupOf(p), others))
}

// the race is over: final standings to everyone, every still-out racer moved
// off the course (their clients teleport home and report positions), lobby
// reset to idle. Caller holds s.mu
func (s *server) endRace(r *roomState) {
	if r.race == nil || !r.race.racing {
		return
	}
	// standings first — the transitions below don't touch race bookkeeping,
	// but the order keeps this robust to future edits. Still-out racers land
	// into the debrief like finishers: the whole field keeps race comms until
	// each closes their scoreboard
	results := r.raceResults()
	for _, sess := range r.allSessions() {
		if sess.player.Racing {
			s.transitionToDebrief(r, sess.player, "race")
		}
	}
	ended := svrRaceEnded{Type: "raceEnded", Results: results}
	for _, sess := range r.allSessions() {
		sess.sock.send(ended)
	}
	entries := r.raceScoreEntries()
	r.race = nil
	s.persistScores(r, "race", entries)
	log.Printf("race ended (%d result(s))", len(results))
}

// record a finished game's scores and rebroadcast the fresh leaderboards to
// everyone aboard. Caller holds s.mu; the db work rides a goroutine like the
// other mid-flow writes, re-taking the lock only for the broadcast
func (s *server) persistScores(r *roomState, game string, entries []scoreEntry) {
	if r.wid == "" || len(entries) == 0 {
		return
	}
	wid := r.wid
	go func() {
		ctx := context.Background()
		for _, e := range entries {
			var err error
			if game == "race" {
				err = s.db.saveRaceTime(ctx, wid, e.userID, e.score)
			} else {
				err = s.db.saveBlastKills(ctx, wid, e.userID, int(e.score))
			}
			if err != nil {
				log.Printf("db write failed (%s score): %v", game, err)
				return
			}
		}
		boards, err := s.db.leaderboardsOf(ctx, wid)
		if err != nil {
			log.Printf("leaderboard read failed: %v", err)
			return
		}
		msg := svrLeaderboards{Type: "leaderboards", Race: boards.Race, Blast: boards.Blast}
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, sess := range r.allSessions() {
			sess.sock.send(msg)
		}
	}()
}

// a finished racer / fallen combatant enters the debrief: the game flag
// clears (rendering and gating behave as on foot again) but Debrief pins
// their audio group to the game's comms channel while their scoreboard is up,
// so they keep hearing the players still out. The group doesn't change, so
// there's no pairing diff; the zone re-derives from where they stand (open
// space mid-course) purely so the roster stays truthful. Caller holds s.mu
func (s *server) transitionToDebrief(r *roomState, p *Player, game string) {
	if game == "race" {
		p.Racing = false
	} else {
		p.Blasting = false
	}
	g := game
	p.Debrief = &g
	zoneID := ""
	if z := zoneAt(s.mapOfRoom(r), p.X, p.Y); z != nil {
		zoneID = z.ID
	}
	previous := strOf(p.ZoneID)
	p.ZoneID = optStr(zoneID)
	if previous != zoneID {
		changed := svrZoneChanged{Type: "zoneChanged", ID: p.ID, ZoneID: p.ZoneID}
		for _, sess := range r.allSessions() {
			sess.sock.send(changed)
		}
	}
}

// the debrief is over (board closed, or the next match reclaims the channel;
// departures clear the flag separately): leave the game's comms group and
// re-pair by whatever the player is otherwise doing — their zone, usually.
// Broadcast to everyone so rosters stay truthful. Caller holds s.mu
func (s *server) endDebrief(r *roomState, p *Player) {
	if p.Debrief == nil {
		return
	}
	prevGroup := audioGroupOf(p)
	p.Debrief = nil
	ended := svrDebriefEnded{Type: "debriefEnded", ID: p.ID}
	for _, sess := range r.allSessions() {
		sess.sock.send(ended)
	}
	sess := r.sessionOf(p.ID)
	if sess == nil {
		return
	}
	// a flying holder was already in the flight group (it overrides the
	// debrief), so the release may change nothing
	newGroup := audioGroupOf(p)
	if prevGroup != newGroup {
		others := playersOf(r.othersOf(p.ID))
		sendPairingDiff(r, p.ID, sess.sock, diffPairs(prevGroup, newGroup, others))
	}
}

// one active session per account: before a fresh join lands, every live or
// parked session this user holds in any room is removed for good — the old
// tab is told why (so it won't try to resume; its token dies here) and its
// socket closed
func (s *server) evictUserEverywhere(userID string) {
	for _, room := range s.rooms.all() {
		for _, sess := range room.sessionsOfUser(userID) {
			sess.sock.send(svrKicked{Type: "kicked", Reason: "boardedElsewhere"})
			room.evict(sess.player.ID)
			s.announceDeparture(room, sess.player)
			s.raceDeparted(room, sess.player)
			s.blastDeparted(room, sess.player)
			sess.sock.close()
			log.Printf("%s evicted (%s): account boarded elsewhere", sess.player.Name, sess.player.ID)
		}
		room.dropParkedOfUser(userID)
	}
}

// the room's live map, or the default ship before the first load lands
func (s *server) mapOfRoom(r *roomState) *MapData {
	if r.roomMap != nil {
		return r.roomMap
	}
	return s.defaultMap
}

// first-join identity from the clerk account: display name plus account email
// for the member panel. An api hiccup falls back to a generic name instead of
// failing the join — the user can rename aboard; the nil email stays NULL in
// the db so a later join retries the fetch
func fetchClerkIdentity(ctx context.Context, userID string) (string, *string) {
	u, err := clerkuser.Get(ctx, userID)
	if err != nil {
		log.Printf("clerk user fetch failed (%s): %v", userID, err)
		return "Crew Member", nil
	}
	email := primaryEmail(u)
	return defaultDisplayName(nameSourceOf(u)), &email
}

// fill the account email for a user row that predates the email column (or
// whose first-join fetch failed); off the join path — the panel just shows no
// email until it lands. At most one clerk fetch per join, none once a value
// (even ”) is stored
func (s *server) backfillEmail(userID string) {
	go func() {
		ctx := context.Background()
		unfetched, err := s.db.emailUnfetched(ctx, userID)
		if err != nil {
			log.Printf("email backfill check failed (%s): %v", userID, err)
			return
		}
		if !unfetched {
			return
		}
		_, email := fetchClerkIdentity(ctx, userID)
		if email == nil {
			return
		}
		if err := s.db.saveEmail(ctx, userID, *email); err != nil {
			log.Printf("email backfill write failed (%s): %v", userID, err)
		}
	}()
}

// the account's current lowercased email for invite matching (notes/015),
// creating or backfilling the users row on the way — an invited person may
// never have boarded anywhere, and requestJoin wants an identity for the
// creator's panel. Unlike the join path's async backfill this is synchronous:
// the caller is about to match invites against the value. "" = the account
// has no email (or the clerk fetch failed — the NULL stays retryable)
func (s *server) resolveEmail(ctx context.Context, userID string) (string, error) {
	email, exists, err := s.db.emailOf(ctx, userID)
	if err != nil {
		return "", err
	}
	if !exists {
		name, fetched := fetchClerkIdentity(ctx, userID)
		if _, err := s.db.createUser(ctx, userID, name, fetched); err != nil {
			return "", err
		}
		if fetched == nil {
			return "", nil
		}
		return strings.ToLower(*fetched), nil
	}
	if email == nil {
		// row predates the email column, or the first-join fetch failed
		_, fetched := fetchClerkIdentity(ctx, userID)
		if fetched == nil {
			return "", nil
		}
		if err := s.db.saveEmail(ctx, userID, *fetched); err != nil {
			return "", err
		}
		return strings.ToLower(*fetched), nil
	}
	return strings.ToLower(*email), nil
}

// profile writes ride the message flow but nothing waits on them; a db error
// is logged, the in-memory roster stays the session's truth
func persist(label string, write func() error) {
	go func() {
		if err := write(); err != nil {
			log.Printf("db write failed (%s): %v", label, err)
		}
	}()
}

// --- join / resume ---

// the workspace's live map: the room's cached layout when a join already
// loaded it, else the owner-edited layout from the db, else the default ship.
// The db read happens outside the lock; the caller stamps the result onto the
// room under the lock (a concurrent load of the same map is harmless)
func (s *server) loadRoomMap(ctx context.Context, workspaceID string) (*MapData, error) {
	s.mu.Lock()
	cached := s.rooms.roomFor(workspaceID).roomMap
	s.mu.Unlock()
	if cached != nil {
		return cached, nil
	}
	dbMap, err := s.db.mapOf(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if dbMap == nil {
		dbMap = s.defaultMap
	}
	return dbMap, nil
}

func (s *server) handleJoin(c *client, m joinMsg) {
	// the read loop is sequential, so a duplicate join can't race a pending
	// one — selfID alone gates it
	if c.selfID != "" {
		log.Printf("duplicate join from %s, ignored", c.selfID)
		return
	}
	ctx := context.Background()

	// a db/clerk failure mid-join must not crash the server; the client sees
	// a rejection and can try again
	fail := func(err error) {
		log.Printf("join failed: %v", err)
		c.send(svrJoinRejected{Type: "joinRejected", Reason: "unauthorized"})
		c.close()
	}

	// bad, expired, or foreign token: typed rejection, then close
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrJoinRejected{Type: "joinRejected", Reason: "unauthorized"})
		c.close()
		log.Printf("join rejected: invalid clerk token")
		return
	}
	// the slug must name a real workspace before anything else loads
	workspace, err := s.db.workspaceBySlug(ctx, m.Workspace)
	if err != nil {
		fail(err)
		return
	}
	if workspace == nil {
		c.send(svrJoinRejected{Type: "joinRejected", Reason: "workspaceNotFound"})
		c.close()
		log.Printf("join rejected: unknown workspace %s", m.Workspace)
		return
	}
	// profile from the db; a first join creates it, named from the clerk account
	profile, err := s.db.loadUser(ctx, userID)
	if err != nil {
		fail(err)
		return
	}
	if profile == nil {
		name, email := fetchClerkIdentity(ctx, userID)
		created, err := s.db.createUser(ctx, userID, name, email)
		if err != nil {
			fail(err)
			return
		}
		profile = &created
	} else {
		// existing rows may predate the email column; fill it off-path
		s.backfillEmail(userID)
	}
	// membership gates the board — a pure check now (notes/015): a removed
	// (banned) account is refused "removed", a non-member "notMember" (the
	// join screen offers request-to-join); nothing is inserted here, so
	// knowing the link no longer grants membership
	admit, err := s.db.admitMember(ctx, workspace.id, userID)
	if err != nil {
		fail(err)
		return
	}
	if admit != "ok" {
		c.send(svrJoinRejected{Type: "joinRejected", Reason: admit})
		c.close()
		log.Printf("join rejected: %s for %s in %s", admit, userID, m.Workspace)
		return
	}
	loadedMap, err := s.loadRoomMap(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}
	// a player who owns a pod boards inside it; everyone else at the map
	// spawn. pods ride the welcome anyway, so fetch once and reuse the list
	pods, err := s.db.podsOf(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}
	// every prop standing on the deck rides the welcome too (notes/017)
	items, err := s.db.itemsOf(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}
	// both game leaderboards ride the welcome (leaderboard feature)
	boards, err := s.db.leaderboardsOf(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}
	// time tracking: the stay starts once the board is authorized; a failed
	// insert is logged, never blocks boarding
	sessionRowID := gonanoid.Must()
	if err := s.db.createWorkspaceSession(ctx, sessionRowID, workspace.id, userID); err != nil {
		log.Printf("workspace session start failed: %v", err)
		sessionRowID = ""
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// the socket may have died during the db calls — a session created now
	// would outlive its heartbeat and never be reaped
	if !c.isOpen() {
		// the stay never began; close its row off-path
		if sessionRowID != "" {
			persist("workspace session end", func() error {
				return s.db.endWorkspaceSession(context.Background(), sessionRowID)
			})
		}
		return
	}
	// one active session per account: boarding here ends this account's
	// session (live or parked) in every room, this workspace included
	s.evictUserEverywhere(userID)
	room := s.rooms.roomFor(workspace.id)
	if room.roomMap == nil {
		room.roomMap = loadedMap
	}
	roomMap := room.roomMap
	// the pod's center is the board point; fall back to the map spawn when
	// the player owns no pod (or its zone is gone)
	spawnAt := roomMap.Spawn
	for _, pod := range pods {
		if pod.UserID != userID {
			continue
		}
		for i := range roomMap.Zones {
			z := &roomMap.Zones[i]
			if z.ID == pod.ZoneID && z.isPod() {
				spawnAt = Point{X: z.Rect.X + z.Rect.W/2, Y: z.Rect.Y + z.Rect.H/2}
			}
		}
	}
	// zoneID reflects whatever zone covers the board point
	zoneID := ""
	if z := zoneAt(roomMap, spawnAt.X, spawnAt.Y); z != nil {
		zoneID = z.ID
	}
	player, resumeToken := room.join(joinInput{
		userID:    userID,
		name:      profile.displayName,
		micOn:     m.MicOn,
		camOn:     m.CamOn,
		character: profile.character,
		// a fresh board makes this workspace the session's home (ADR 0004)
		homeID:   workspace.id,
		homeSlug: workspace.slug,
		homeName: workspace.name,
	}, spawnAt, zoneID, c)
	c.room = room
	c.selfID = player.ID
	c.workspaceID = workspace.id
	c.isOwner = workspace.createdBy == userID
	c.homeID = workspace.id
	c.homeSlug = workspace.slug
	c.homeName = workspace.name
	c.sessionRowID = sessionRowID
	c.send(svrWelcome{
		Type:        "welcome",
		SelfID:      player.ID,
		Workspace:   WorkspaceInfo{Slug: workspace.slug, Name: workspace.name},
		Home:        WorkspaceInfo{Slug: workspace.slug, Name: workspace.name},
		Owner:       c.isOwner,
		Map:         roomMap,
		Roster:      room.roster(),
		ResumeToken: resumeToken,
		// fresh short-lived TURN credentials per session
		IceServers: mintIceServers(s.turn, nowMs()),
		// this workspace's persisted pod claims
		Pods: pods,
		// and its placed decor props
		Items: items,
		// recent ship-scoped chat for context
		Chat: room.chatHistory(),
		// the race lobby / running race, so the table panel and gates render
		Race: room.raceSnapshot(),
		// the blasters lobby / running match likewise
		Blast: room.blastSnapshot(),
		// both games' persisted best scores, for the table panels
		Leaderboards: boards,
	})
	broadcastFrom(room, player.ID, svrPlayerJoined{Type: "playerJoined", Player: player})
	// spawning inside a zone pairs with its occupants (spawn is open space today)
	others := playersOf(room.othersOf(player.ID))
	sendPairingDiff(room, player.ID, c, diffPairs("", audioGroupOf(player), others))
	log.Printf("%s joined %s as %s", player.Name, workspace.slug, player.ID)
}

func (s *server) handleResume(c *client, m resumeMsg) {
	if c.selfID != "" {
		log.Printf("resume after join from %s, ignored", c.selfID)
		return
	}
	ctx := context.Background()

	// a db failure mid-resume must not crash the server; closing without a
	// rejection lets the client's retry loop try again
	fail := func(err error) {
		log.Printf("resume failed: %v", err)
		c.close()
	}

	// the slug names the HOME workspace — a refresh on /w/a must never resume
	// into workspace b. A drop mid-Visit names the visited room too: the
	// parked session lives there and resumes in place (space link, ADR 0004)
	home, err := s.db.workspaceBySlug(ctx, m.Workspace)
	if err != nil {
		fail(err)
		return
	}
	if home == nil {
		c.send(svrJoinRejected{Type: "joinRejected", Reason: "workspaceNotFound"})
		c.close()
		log.Printf("resume rejected: unknown workspace %s", m.Workspace)
		return
	}
	workspace := home
	if m.Visited != "" && m.Visited != m.Workspace {
		// the Visit resumes only while its lifelines hold (Q7/Q10): the
		// visited workspace, home membership, the Link, and no ban aboard.
		// Any dead lifeline reads resumeExpired — the client falls back to a
		// fresh join, which lands home
		expire := func(why string) {
			c.send(svrJoinRejected{Type: "joinRejected", Reason: "resumeExpired"})
			c.close()
			log.Printf("visit resume rejected: %s", why)
		}
		visited, err := s.db.workspaceBySlug(ctx, m.Visited)
		if err != nil {
			fail(err)
			return
		}
		if visited == nil {
			expire("visited workspace is gone")
			return
		}
		// the token's owner is peeked (not consumed) so the db checks can run
		// before the takeover; the parked home must match the claimed one
		s.mu.Lock()
		userID, parkedHome := s.rooms.roomFor(visited.id).parkedOwnerOf(m.Token)
		s.mu.Unlock()
		if userID == "" || parkedHome != home.id {
			expire("token unknown or home mismatch")
			return
		}
		if admit, err := s.db.admitMember(ctx, home.id, userID); err != nil {
			fail(err)
			return
		} else if admit != "ok" {
			// the right to Visit derived from the home membership (Q7)
			expire("home membership gone")
			return
		}
		if admit, err := s.db.admitMember(ctx, visited.id, userID); err != nil {
			fail(err)
			return
		} else if admit == "removed" {
			expire("banned aboard the visited workspace")
			return
		}
		linked, err := s.db.linkExists(ctx, home.id, visited.id)
		if err != nil {
			fail(err)
			return
		}
		if !linked {
			expire("link gone")
			return
		}
		workspace = visited
	}
	// the room may have been reaped and lazily recreated while this player
	// was parked elsewhere — same map load as join
	loadedMap, err := s.loadRoomMap(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}
	// pods may have changed while dropped — reread, like the roster
	pods, err := s.db.podsOf(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}
	// props may have been placed or cleared while dropped — reread them too
	items, err := s.db.itemsOf(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}
	// leaderboards likewise — a race/match may have ended while dropped
	boards, err := s.db.leaderboardsOf(ctx, workspace.id)
	if err != nil {
		fail(err)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// the socket may have died during the db calls (same rule as join)
	if !c.isOpen() {
		return
	}
	room := s.rooms.roomFor(workspace.id)
	if room.roomMap == nil {
		room.roomMap = loadedMap
	}
	roomMap := room.roomMap
	// the old socket may still look alive (heartbeat hasn't swept it yet) —
	// the token proves ownership, so park that stale session first and let
	// the resume proceed as if the drop had been detected; the scan spans
	// only this room, tokens never cross rooms
	if stale := room.sessionOfToken(m.Token); stale != nil {
		s.parkAndAnnounce(room, stale.player.ID)
		// its close cleanup no-ops: the session's socket is no longer that one
		stale.sock.terminate()
	}
	player := room.resume(m.Token, c, nowMs())
	if player == nil {
		c.send(svrJoinRejected{Type: "joinRejected", Reason: "resumeExpired"})
		c.close()
		log.Printf("resume rejected: token unknown or grace window passed")
		return
	}
	// media was re-acquired client-side; speaking restarts from silence and
	// a display capture never survives a reconnect
	player.MicOn = m.MicOn
	player.CamOn = m.CamOn
	player.Speaking = false
	player.ScreenOn = false
	c.room = room
	c.selfID = player.ID
	c.workspaceID = workspace.id
	// ownership rides the session's clerk user id
	sess := room.sessionOf(player.ID)
	c.isOwner = sess != nil && workspace.createdBy == sess.userID
	// home rides the parked session (a Visit resumes in place); the fetched
	// home record covers sessions parked before it carried one
	c.homeID, c.homeSlug, c.homeName = home.id, home.slug, home.name
	if sess != nil && sess.homeID != "" {
		c.homeID, c.homeSlug, c.homeName = sess.homeID, sess.homeSlug, sess.homeName
	}
	// time tracking: a resume is a fresh stay (the dropped one ended with its
	// socket). The id binds to this connection now; the insert rides a
	// goroutine like the other mid-flow db writes
	if sess != nil {
		c.sessionRowID = gonanoid.Must()
		rowID, userID := c.sessionRowID, sess.userID
		persist("workspace session start", func() error {
			return s.db.createWorkspaceSession(context.Background(), rowID, workspace.id, userID)
		})
	}
	c.send(svrWelcome{
		Type:        "welcome",
		SelfID:      player.ID,
		Workspace:   WorkspaceInfo{Slug: workspace.slug, Name: workspace.name},
		Home:        WorkspaceInfo{Slug: c.homeSlug, Name: c.homeName},
		Owner:       c.isOwner,
		Map:         roomMap,
		Roster:      room.roster(),
		ResumeToken: m.Token,
		// a resume re-mints too — the old credentials may be near expiry
		IceServers: mintIceServers(s.turn, nowMs()),
		Pods:       pods,
		Items:      items,
		// ship chat that landed while dropped comes back with the history
		Chat: room.chatHistory(),
		// the race / match may have started/ended while dropped
		Race:  room.raceSnapshot(),
		Blast: room.blastSnapshot(),
		// best scores likewise
		Leaderboards: boards,
	})
	broadcastFrom(room, player.ID, svrPlayerJoined{Type: "playerJoined", Player: player})
	// re-entering the zone re-pairs with its occupants — A/V comes back
	// through the normal pairing flow
	others := playersOf(room.othersOf(player.ID))
	sendPairingDiff(room, player.ID, c, diffPairs("", audioGroupOf(player), others))
	log.Printf("%s resumed in %s (%s)", player.Name, workspace.slug, player.ID)
}

// --- pre-join picker + member management (token per message, reply on this
// socket, leave it open — the client closes it) ---

func (s *server) handleListWorkspaces(c *client, m listWorkspacesMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrCreateRejected{Type: "createRejected", Reason: "unauthorized"})
		return
	}
	list, err := s.db.workspacesFor(ctx, userID)
	if err != nil {
		log.Printf("listWorkspaces failed: %v", err)
		return
	}
	// TODO - remove this temp code later
	// TEMPORARY HACK: an account with no memberships auto-joins the
	// pre-existing "default" workspace so new users land somewhere.
	// createMembership keeps bans + the member cap honest (admitMember is a
	// pure gate now, notes/015); if it refuses (or the workspace is missing)
	// the picker just stays empty
	if len(list) == 0 {
		def, err := s.db.workspaceBySlug(ctx, "default")
		if err != nil {
			log.Printf("listWorkspaces failed: %v", err)
			return
		}
		if def != nil {
			admit, err := s.db.createMembership(ctx, def.id, userID)
			if err != nil {
				log.Printf("listWorkspaces failed: %v", err)
				return
			}
			if admit == "ok" {
				if list, err = s.db.workspacesFor(ctx, userID); err != nil {
					log.Printf("listWorkspaces failed: %v", err)
					return
				}
			}
		}
	}
	entries := make([]WorkspaceListEntry, len(list))
	for i, l := range list {
		entries[i] = WorkspaceListEntry{Slug: l.slug, Name: l.name, Mine: l.mine}
	}
	c.send(svrWorkspaceList{Type: "workspaceList", Workspaces: entries})
}

func (s *server) handleCreateWorkspace(c *client, m createWorkspaceMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrCreateRejected{Type: "createRejected", Reason: "unauthorized"})
		return
	}
	// the creator's membership rides the same insert
	result, err := s.db.createWorkspace(ctx, m.Name, userID)
	if err != nil {
		log.Printf("createWorkspace failed: %v", err)
		return
	}
	if !result.ok {
		c.send(svrCreateRejected{Type: "createRejected", Reason: result.reason})
		return
	}
	c.send(svrWorkspaceCreated{Type: "workspaceCreated", Slug: result.workspace.slug, Name: result.workspace.name})
	log.Printf("workspace %s created by %s", result.workspace.slug, userID)
}

func (s *server) handleDeleteWorkspace(c *client, m deleteWorkspaceMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrDeleteRejected{Type: "deleteRejected", Reason: "unauthorized"})
		return
	}
	// creator-only; memberships cascade with the row
	result, err := s.db.deleteWorkspace(ctx, m.Slug, userID)
	if err != nil {
		log.Printf("deleteWorkspace failed: %v", err)
		return
	}
	if !result.ok {
		c.send(svrDeleteRejected{Type: "deleteRejected", Reason: result.reason})
		return
	}
	// anyone still aboard is kicked with the room; parked resume tokens die
	// with it — no announcements, the whole room is going. Visitors are told
	// visitEnded instead, so their clients re-board home (Q7)
	s.mu.Lock()
	if room := s.rooms.remove(result.id); room != nil {
		for _, sess := range room.allSessions() {
			reason := "workspaceDeleted"
			if sess.homeID != "" && sess.homeID != result.id {
				reason = "visitEnded"
			}
			sess.sock.send(svrKicked{Type: "kicked", Reason: reason})
			sess.sock.close()
		}
	}
	// members of the deleted workspace out Visiting lose their home mid-Visit:
	// the session dies and they land at the picker (Q7); their parked Visits
	// die too. The Links themselves cascade away with the workspace row
	for _, room := range s.rooms.all() {
		for _, sess := range room.visitorSessionsOf(result.id) {
			sess.sock.send(svrKicked{Type: "kicked", Reason: "workspaceDeleted"})
			room.evict(sess.player.ID)
			s.announceDeparture(room, sess.player)
			s.raceDeparted(room, sess.player)
			s.blastDeparted(room, sess.player)
			sess.sock.close()
			log.Printf("%s kicked mid-visit (%s): home workspace deleted", sess.player.Name, sess.player.ID)
		}
		room.dropParkedOfHome(result.id)
	}
	s.mu.Unlock()
	c.send(svrWorkspaceDeleted{Type: "workspaceDeleted", Slug: m.Slug})
	log.Printf("workspace %s deleted by %s", m.Slug, userID)
}

func (s *server) handleListMembers(c *client, m listMembersMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrMemberRejected{Type: "memberRejected", Reason: "unauthorized"})
		return
	}
	result, err := s.db.membersOf(ctx, m.Slug, userID)
	if err != nil {
		log.Printf("listMembers failed: %v", err)
		return
	}
	if !result.ok {
		c.send(svrMemberRejected{Type: "memberRejected", Reason: result.reason})
		return
	}
	c.send(svrMemberList{
		Type: "memberList", Slug: m.Slug,
		Members: result.members, Banned: result.banned,
		Invites: result.invites, Requests: result.requests,
	})
}

func (s *server) handleRemoveMember(c *client, m removeMemberMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrMemberRejected{Type: "memberRejected", Reason: "unauthorized"})
		return
	}
	// removal = ban: the ban row blocks the link-based rejoin
	result, err := s.db.banMember(ctx, m.Slug, userID, m.UserID)
	if err != nil {
		log.Printf("removeMember failed: %v", err)
		return
	}
	if !result.ok {
		c.send(svrMemberRejected{Type: "memberRejected", Reason: result.reason})
		return
	}
	// kick the removed account's live session in this room and kill its
	// parked tokens; roomFor may lazy-create an empty room — the sweep reaps
	// it (same precedent as resume probes)
	s.mu.Lock()
	target := s.rooms.roomFor(result.workspaceID)
	for _, sess := range target.sessionsOfUser(m.UserID) {
		// a banned Visitor's session ends as visitEnded — their client
		// re-boards home, and the ban blocks future Visits (Q7)
		if sess.homeID != "" && sess.homeID != result.workspaceID {
			s.endVisitorSession(target, sess)
			continue
		}
		sess.sock.send(svrKicked{Type: "kicked", Reason: "removed"})
		target.evict(sess.player.ID)
		s.announceDeparture(target, sess.player)
		s.raceDeparted(target, sess.player)
		s.blastDeparted(target, sess.player)
		sess.sock.close()
		log.Printf("%s kicked (%s): removed from workspace", sess.player.Name, sess.player.ID)
	}
	target.dropParkedOfUser(m.UserID)
	// the removed member may be out Visiting: the right to Visit derived from
	// the membership, so the Visit dies with it, landing them at the picker (Q7)
	for _, room := range s.rooms.all() {
		if room == target {
			continue
		}
		for _, sess := range room.sessionsOfUser(m.UserID) {
			if sess.homeID != result.workspaceID {
				continue
			}
			sess.sock.send(svrKicked{Type: "kicked", Reason: "removed"})
			room.evict(sess.player.ID)
			s.announceDeparture(room, sess.player)
			s.raceDeparted(room, sess.player)
			s.blastDeparted(room, sess.player)
			sess.sock.close()
			log.Printf("%s kicked mid-visit (%s): removed from home workspace", sess.player.Name, sess.player.ID)
		}
	}
	// the ban freed the target's pod claim; tell everyone aboard so the pod
	// label clears without a rejoin
	if result.freedPod != "" {
		for _, sess := range target.allSessions() {
			sess.sock.send(svrPodReleased{Type: "podReleased", ZoneID: result.freedPod})
		}
	}
	s.mu.Unlock()
	c.send(svrMemberRemoved{Type: "memberRemoved", Slug: m.Slug, UserID: m.UserID})
	log.Printf("%s removed from %s by %s", m.UserID, m.Slug, userID)
}

func (s *server) handleUnbanMember(c *client, m unbanMemberMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrMemberRejected{Type: "memberRejected", Reason: "unauthorized"})
		return
	}
	// membership is not restored — the unbanned user rejoins via the link and
	// takes a free slot like anyone else
	result, err := s.db.unbanMember(ctx, m.Slug, userID, m.UserID)
	if err != nil {
		log.Printf("unbanMember failed: %v", err)
		return
	}
	if !result.ok {
		c.send(svrMemberRejected{Type: "memberRejected", Reason: result.reason})
		return
	}
	c.send(svrMemberUnbanned{Type: "memberUnbanned", Slug: m.Slug, UserID: m.UserID})
	log.Printf("%s unbanned in %s by %s", m.UserID, m.Slug, userID)
}

// --- invites + join requests (notes/015): same picker socket pattern ---

// send an invite to one email address, creator-only; the decode already
// trimmed and lowercased the address
func (s *server) handleInvite(c *client, m inviteMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: "unauthorized"})
		return
	}
	result, err := s.db.createInvite(ctx, m.Slug, userID, m.Email)
	if err != nil {
		log.Printf("invite failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: result})
		return
	}
	c.send(svrInviteSent{Type: "inviteSent", Slug: m.Slug, Email: m.Email})
	log.Printf("%s invited to %s by %s", m.Email, m.Slug, userID)
}

// cancel a pending invite, creator-only; idempotent
func (s *server) handleCancelInvite(c *client, m cancelInviteMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: "unauthorized"})
		return
	}
	result, err := s.db.cancelInvite(ctx, m.Slug, userID, m.Email)
	if err != nil {
		log.Printf("cancelInvite failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: result})
		return
	}
	c.send(svrInviteCancelled{Type: "inviteCancelled", Slug: m.Slug, Email: m.Email})
	log.Printf("invite to %s in %s cancelled by %s", m.Email, m.Slug, userID)
}

// the picker's pending lists: invites matched against this account's current
// primary email (resolved synchronously — ADR 0003), plus its own requests
func (s *server) handleListPending(c *client, m listPendingMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: "unauthorized"})
		return
	}
	email, err := s.resolveEmail(ctx, userID)
	if err != nil {
		log.Printf("listPending failed: %v", err)
		return
	}
	invites, requests, err := s.db.pendingFor(ctx, userID, email)
	if err != nil {
		log.Printf("listPending failed: %v", err)
		return
	}
	c.send(svrPendingList{Type: "pendingList", Invites: invites, Requests: requests})
}

// accept an invite addressed to this account's email: the membership lands
// (bans + cap re-checked) and both pending artifacts resolve
func (s *server) handleAcceptInvite(c *client, m acceptInviteMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: "unauthorized"})
		return
	}
	email, err := s.resolveEmail(ctx, userID)
	if err != nil {
		log.Printf("acceptInvite failed: %v", err)
		return
	}
	result, err := s.db.acceptInvite(ctx, m.Slug, userID, email)
	if err != nil {
		log.Printf("acceptInvite failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: result})
		return
	}
	c.send(svrInviteAccepted{Type: "inviteAccepted", Slug: m.Slug})
	log.Printf("%s accepted an invite to %s", userID, m.Slug)
}

// decline an invite addressed to this account's email; idempotent
func (s *server) handleDeclineInvite(c *client, m declineInviteMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: "unauthorized"})
		return
	}
	email, err := s.resolveEmail(ctx, userID)
	if err != nil {
		log.Printf("declineInvite failed: %v", err)
		return
	}
	result, err := s.db.declineInvite(ctx, m.Slug, email)
	if err != nil {
		log.Printf("declineInvite failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrInviteRejected{Type: "inviteRejected", Reason: result})
		return
	}
	c.send(svrInviteDeclined{Type: "inviteDeclined", Slug: m.Slug})
	log.Printf("%s declined an invite to %s", userID, m.Slug)
}

// petition to join a workspace by name; resolveEmail ensures the users row so
// the creator's panel can show who is asking
func (s *server) handleRequestJoin(c *client, m requestJoinMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: "unauthorized"})
		return
	}
	if _, err := s.resolveEmail(ctx, userID); err != nil {
		log.Printf("requestJoin failed: %v", err)
		return
	}
	result, workspace, err := s.db.createJoinRequest(ctx, m.Name, userID)
	if err != nil {
		log.Printf("requestJoin failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: result})
		return
	}
	c.send(svrRequestSent{Type: "requestSent", Slug: workspace.slug, Name: workspace.name})
	log.Printf("%s requested to join %s", userID, workspace.slug)
}

// withdraw this account's own pending join request; idempotent
func (s *server) handleCancelRequest(c *client, m cancelRequestMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: "unauthorized"})
		return
	}
	result, err := s.db.cancelJoinRequest(ctx, m.Slug, userID)
	if err != nil {
		log.Printf("cancelRequest failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: result})
		return
	}
	c.send(svrRequestCancelled{Type: "requestCancelled", Slug: m.Slug})
	log.Printf("%s cancelled their join request for %s", userID, m.Slug)
}

// approve a join request, creator-only: the membership lands (bans + cap
// checked at this moment) and both pending artifacts resolve
func (s *server) handleApproveRequest(c *client, m approveRequestMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: "unauthorized"})
		return
	}
	result, err := s.db.approveJoinRequest(ctx, m.Slug, userID, m.UserID)
	if err != nil {
		log.Printf("approveRequest failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: result})
		return
	}
	c.send(svrRequestApproved{Type: "requestApproved", Slug: m.Slug, UserID: m.UserID})
	log.Printf("%s's join request for %s approved by %s", m.UserID, m.Slug, userID)
}

// deny a join request, creator-only; idempotent
func (s *server) handleDenyRequest(c *client, m denyRequestMsg) {
	ctx := context.Background()
	userID := verifyClerkToken(ctx, m.Token)
	if userID == "" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: "unauthorized"})
		return
	}
	result, err := s.db.denyJoinRequest(ctx, m.Slug, userID, m.UserID)
	if err != nil {
		log.Printf("denyRequest failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrRequestRejected{Type: "requestRejected", Reason: result})
		return
	}
	c.send(svrRequestDenied{Type: "requestDenied", Slug: m.Slug, UserID: m.UserID})
	log.Printf("%s's join request for %s denied by %s", m.UserID, m.Slug, userID)
}

// --- in-room messages ---

// the caller's bound room + session, or nil when it hasn't joined (caller
// holds s.mu); every in-room handler drops unbound messages the same way
func (c *client) boundSession() (*roomState, *session) {
	if c.selfID == "" || c.room == nil {
		return nil, nil
	}
	return c.room, c.room.sessionOf(c.selfID)
}

func (s *server) handlePos(c *client, m posMsg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("pos before join, dropped")
		return
	}
	// zone membership derives from every position update; a flying, racing, or
	// blasting player is always zone-less — a shuttle passing over the flight
	// deck must not connect its pilot's A/V
	zoneID := ""
	if sess.player.ShipPad == nil && !sess.player.Racing && !sess.player.Blasting {
		if z := zoneAt(s.mapOfRoom(r), m.X, m.Y); z != nil {
			zoneID = z.ID
		}
	}
	result := r.updatePos(c.selfID, m.X, m.Y, zoneID, m.A)
	broadcastFrom(r, c.selfID, svrPos{Type: "pos", ID: c.selfID, X: m.X, Y: m.Y, A: m.A})
	if result.zoneChanged {
		// mover included — the server's zone is authoritative for the HUD
		changed := svrZoneChanged{Type: "zoneChanged", ID: c.selfID, ZoneID: optStr(zoneID)}
		c.send(changed)
		broadcastFrom(r, c.selfID, changed)
		// pair with the new zone's occupants, unpair from the old zone's — but
		// a debrief holder's audio group is pinned to the game channel, so
		// their zone moves re-pair nothing (the group didn't change)
		if sess.player.Debrief == nil {
			others := playersOf(r.othersOf(c.selfID))
			sendPairingDiff(r, c.selfID, c, diffPairs(result.previousZoneID, zoneID, others))
		}
	}
}

func (s *server) handleShip(c *client, m shipMsg) {
	// board (pad set) or dock (pad nil) a shuttle. boarding leaves whatever
	// zone the pilot stood in; docking re-enters the zone covering their
	// position — both reuse the pos zone-change flow
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("ship before join, dropped")
		return
	}
	p := sess.player
	// a game shuttle is not a pad shuttle: no boarding or docking mid-game
	if p.Racing || p.Blasting {
		log.Printf("ship while racing/blasting from %s, dropped", c.selfID)
		return
	}
	// the audio group before any mutation (flight, a debrief hold, or the
	// zone) — drives the re-pair diff below
	prevGroup := audioGroupOf(p)
	roomMap := s.mapOfRoom(r)
	// pads are map data: refuse indices the current layout doesn't have so
	// the roster never carries junk
	if m.Pad != nil && *m.Pad >= len(roomMap.Pads) {
		log.Printf("ship pad %d out of range, dropped", *m.Pad)
		return
	}
	zoneID := ""
	if m.Pad == nil {
		if z := zoneAt(roomMap, p.X, p.Y); z != nil {
			zoneID = z.ID
		}
	}
	// boarding a shuttle walks away from the game table: any lobby seat is
	// given up (a pilot can't be waiting at a holotable)
	if m.Pad != nil && r.raceLobbyDrop(c.selfID) {
		s.broadcastRaceLobby(r)
	}
	if m.Pad != nil && r.blastLobbyDrop(c.selfID) {
		s.broadcastBlastLobby(r)
	}
	result := r.updateShip(c.selfID, m.Pad, zoneID)
	broadcastFrom(r, c.selfID, svrShip{Type: "ship", ID: c.selfID, Pad: m.Pad})
	// the zoneChanged echo drives the HUD room label; only a real zone move
	// fires it (boarding/docking through open space keeps the zone empty)
	if result.zoneChanged {
		changed := svrZoneChanged{Type: "zoneChanged", ID: c.selfID, ZoneID: optStr(zoneID)}
		c.send(changed)
		broadcastFrom(r, c.selfID, changed)
	}
	// re-pair on the audio group, not the zone: boarding joins the ship-wide
	// FLIGHT group (every pilot hears every pilot), docking rejoins the zone —
	// or the debrief channel, while a post-game scoreboard is still up. that
	// diverges from the zone move whenever open space is on either side, so
	// it can't ride result.zoneChanged
	newGroup := audioGroupOf(p)
	if prevGroup != newGroup {
		others := playersOf(r.othersOf(c.selfID))
		sendPairingDiff(r, c.selfID, c, diffPairs(prevGroup, newGroup, others))
	}
}

func (s *server) handleMediaState(c *client, m mediaStateMsg) {
	// store on the player (late joiners read it from the roster) and relay
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil || !r.updateMedia(c.selfID, m.MicOn, m.CamOn) {
		log.Printf("mediaState before join, dropped")
		return
	}
	broadcastFrom(r, c.selfID, svrMediaState{Type: "mediaState", ID: c.selfID, MicOn: m.MicOn, CamOn: m.CamOn})
}

func (s *server) handleSpeaking(c *client, m speakingMsg) {
	// store on the player and relay to others — no echo, the speaker
	// detected it locally
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil || !r.updateSpeaking(c.selfID, m.On) {
		log.Printf("speaking before join, dropped")
		return
	}
	broadcastFrom(r, c.selfID, svrSpeaking{Type: "speaking", ID: c.selfID, On: m.On})
}

func (s *server) handleScreenShare(c *client, m screenShareMsg) {
	// store on the player and relay to others — no echo, the sharer flipped
	// it locally
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil || !r.updateScreen(c.selfID, m.On) {
		log.Printf("screenShare before join, dropped")
		return
	}
	broadcastFrom(r, c.selfID, svrScreenShare{Type: "screenShare", ID: c.selfID, On: m.On})
}

func (s *server) handleCharacter(c *client, m characterMsg) {
	// store on the player and relay to others — no echo, the editor applied
	// it locally
	s.mu.Lock()
	r, sess := c.boundSession()
	if sess == nil || !r.updateCharacter(c.selfID, m.Character) {
		s.mu.Unlock()
		log.Printf("character before join, dropped")
		return
	}
	broadcastFrom(r, c.selfID, svrCharacter{Type: "character", ID: c.selfID, Character: m.Character})
	userID := sess.userID
	s.mu.Unlock()
	// the outfit survives the session — saved to the user record
	persist("character", func() error {
		return s.db.saveCharacter(context.Background(), userID, m.Character)
	})
}

func (s *server) handleStatus(c *client, m statusMsg) {
	// store on the player and relay to others — no echo, the sender picked
	// it locally
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil || !r.updateStatus(c.selfID, m.Status) {
		log.Printf("status before join, dropped")
		return
	}
	broadcastFrom(r, c.selfID, svrStatus{Type: "status", ID: c.selfID, Status: m.Status})
}

func (s *server) handleRename(c *client, m renameMsg) {
	// store on the player and relay to others — no echo, the locker applied
	// it locally
	s.mu.Lock()
	r, sess := c.boundSession()
	if sess == nil || !r.updateName(c.selfID, m.Name) {
		s.mu.Unlock()
		log.Printf("rename before join, dropped")
		return
	}
	broadcastFrom(r, c.selfID, svrRename{Type: "rename", ID: c.selfID, Name: m.Name})
	userID := sess.userID
	s.mu.Unlock()
	// the display name is profile state — saved to the user record
	persist("displayName", func() error {
		return s.db.saveDisplayName(context.Background(), userID, m.Name)
	})
}

func (s *server) handleWave(c *client, m waveMsg) {
	// relay to the target alone — a wave is an event, not state, so nothing
	// is stored; self-waves are dropped; the target lookup spans only this
	// room, so a wave can never cross workspaces
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("wave before join, dropped")
		return
	}
	if m.To == c.selfID {
		return
	}
	target := r.sessionOf(m.To)
	if target == nil {
		log.Printf("wave to unknown player %s, dropped", m.To)
		return
	}
	target.sock.send(svrWave{Type: "wave", From: c.selfID})
}

func (s *server) handleEmote(c *client, m emoteMsg) {
	// relay to the room — an event like a wave, nothing stored; the sender
	// already showed it locally, so no echo
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("emote before join, dropped")
		return
	}
	broadcastFrom(r, c.selfID, svrEmote{Type: "emote", ID: c.selfID, Emote: m.Emote})
}

func (s *server) handleChat(c *client, m chatClientMsg) {
	// stamp id/sender/time and deliver per scope: ship reaches everyone (and
	// is retained for joiners), zone reaches the sender's current zone
	// occupants only — from open space, zone chat is refused by silently
	// dropping (the client disables the option)
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("chat before join, dropped")
		return
	}
	if m.Scope == "zone" && sess.player.ZoneID == nil {
		log.Printf("zone chat from open space (%s), dropped", c.selfID)
		return
	}
	var zoneID *string
	if m.Scope == "zone" {
		zoneID = sess.player.ZoneID
	}
	chat := svrChat{Type: "chat", Message: ChatMessage{
		ID:     gonanoid.Must(),
		From:   c.selfID,
		Name:   sess.player.Name,
		Scope:  m.Scope,
		ZoneID: zoneID,
		Text:   m.Text,
		Ts:     nowMs(),
	}}
	if m.Scope == "zone" {
		// zone scope: sender + everyone standing in the same zone
		c.send(chat)
		for _, other := range r.othersOf(c.selfID) {
			if other.player.ZoneID != nil && sess.player.ZoneID != nil &&
				*other.player.ZoneID == *sess.player.ZoneID {
				other.sock.send(chat)
			}
		}
		return
	}
	// ship + announce both reach everyone and land in the history; announce
	// additionally banners client-side
	r.addChat(chat.Message)
	c.send(chat)
	broadcastFrom(r, c.selfID, chat)
}

func (s *server) handleClaimPod(c *client, m claimPodMsg) {
	// claim the pod the player stands in: the zone must be a pod and the
	// claimant must be inside it — presence is the claim UX
	s.mu.Lock()
	r, sess := c.boundSession()
	if sess == nil || c.workspaceID == "" {
		s.mu.Unlock()
		log.Printf("claimPod before join, dropped")
		return
	}
	// a Visitor leaves no persistent footprint: no pod claims (Q6)
	if sess.homeID != "" && sess.homeID != c.workspaceID {
		s.mu.Unlock()
		c.send(svrDecorRejected{Type: "decorRejected", Reason: "visitor"})
		return
	}
	var zone *Zone
	roomMap := s.mapOfRoom(r)
	for i := range roomMap.Zones {
		if roomMap.Zones[i].ID == m.ZoneID {
			zone = &roomMap.Zones[i]
			break
		}
	}
	if zone == nil || !zone.isPod() {
		s.mu.Unlock()
		c.send(svrDecorRejected{Type: "decorRejected", Reason: "notAPod"})
		return
	}
	if sess.player.ZoneID == nil || *sess.player.ZoneID != m.ZoneID {
		s.mu.Unlock()
		c.send(svrDecorRejected{Type: "decorRejected", Reason: "notInPod"})
		return
	}
	selfID, wid, userID, name := c.selfID, c.workspaceID, sess.userID, sess.player.Name
	s.mu.Unlock()

	// the db constraints arbitrate races: one owner per pod, one pod per user
	result, err := s.db.claimPod(context.Background(), wid, m.ZoneID, userID)
	if err != nil {
		log.Printf("claimPod failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrDecorRejected{Type: "decorRejected", Reason: result})
		return
	}
	// everyone (claimer included) renders pods from this one message
	claimed := svrPodClaimed{Type: "podClaimed", Pod: PodClaim{ZoneID: m.ZoneID, UserID: userID, Name: name}}
	s.mu.Lock()
	c.send(claimed)
	broadcastFrom(r, selfID, claimed)
	s.mu.Unlock()
	log.Printf("%s claimed pod %s", name, m.ZoneID)
}

func (s *server) handleReleasePod(c *client) {
	// release this account's pod claim; keyed by user, so no zone id needed
	s.mu.Lock()
	r, sess := c.boundSession()
	if sess == nil || c.workspaceID == "" {
		s.mu.Unlock()
		log.Printf("releasePod before join, dropped")
		return
	}
	selfID, wid, name := c.selfID, c.workspaceID, sess.player.Name
	userID := sess.userID
	s.mu.Unlock()

	zoneID, err := s.db.releasePod(context.Background(), wid, userID)
	if err != nil {
		log.Printf("releasePod failed: %v", err)
		return
	}
	if zoneID == "" {
		c.send(svrDecorRejected{Type: "decorRejected", Reason: "noClaim"})
		return
	}
	released := svrPodReleased{Type: "podReleased", ZoneID: zoneID}
	s.mu.Lock()
	c.send(released)
	broadcastFrom(r, selfID, released)
	s.mu.Unlock()
	log.Printf("%s released pod %s", name, zoneID)
}

// --- placed decor props (notes/017) ---

// the room facts every item handler needs, read under the lock once
type itemContext struct {
	room    *roomState
	roomMap *MapData
	selfID  string
	wid     string
	userID  string
	name    string
}

// binds the caller's session and snapshots what the rules need; ok=false when
// the message arrived before a join (the caller has already been told nothing)
func (s *server) itemContextOf(c *client, verb string) (itemContext, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil || c.workspaceID == "" {
		log.Printf("%s before join, dropped", verb)
		return itemContext{}, false
	}
	// a Visitor leaves no persistent footprint: no decor edits either (Q6)
	if sess.homeID != "" && sess.homeID != c.workspaceID {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "visitor"})
		return itemContext{}, false
	}
	return itemContext{
		room:    r,
		roomMap: s.mapOfRoom(r),
		selfID:  c.selfID,
		wid:     c.workspaceID,
		userID:  sess.userID,
		name:    sess.player.Name,
	}, true
}

// sends one message to everyone in the room, the actor included — clients
// render props from the broadcast, never from their own optimistic state
func (s *server) broadcastItem(ic itemContext, c *client, msg any) {
	s.mu.Lock()
	c.send(msg)
	broadcastFrom(ic.room, ic.selfID, msg)
	s.mu.Unlock()
}

// the pod claims a placement rule is judged against
func (s *server) podOwners(ctx context.Context, wid string) (map[string]string, error) {
	pods, err := s.db.podsOf(ctx, wid)
	if err != nil {
		return nil, err
	}
	return podOwnersOf(pods), nil
}

func (s *server) handlePlaceItem(c *client, m placeItemMsg) {
	// drop a prop from the library on the deck: anyone aboard, anywhere on a
	// floor plate that isn't inside someone else's claimed pod
	ic, ok := s.itemContextOf(c, "placeItem")
	if !ok {
		return
	}
	ctx := context.Background()
	owners, err := s.podOwners(ctx, ic.wid)
	if err != nil {
		log.Printf("placeItem failed: %v", err)
		return
	}
	if denial := placementDenialAt(ic.roomMap, m.X, m.Y, owners, ic.userID); denial != "" {
		c.send(svrItemRejected{Type: "itemRejected", Reason: denial})
		return
	}
	item, placed, err := s.db.placeItem(ctx, ic.wid, m.Kind, m.X, m.Y, m.Scale, m.Color, ic.userID)
	if err != nil {
		log.Printf("placeItem failed: %v", err)
		return
	}
	if !placed {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "full"})
		return
	}
	s.broadcastItem(ic, c, svrItemPlaced{Type: "itemPlaced", Item: item})
	log.Printf("%s placed %s", ic.name, item.Kind)
}

func (s *server) handleMoveItem(c *client, m moveItemMsg) {
	// drag a prop that is already down: judged twice — the spot it leaves must
	// be one the mover may clear, the spot it lands on one they may place in
	ic, ok := s.itemContextOf(c, "moveItem")
	if !ok {
		return
	}
	ctx := context.Background()
	item, found, err := s.db.itemByID(ctx, ic.wid, m.ID)
	if err != nil {
		log.Printf("moveItem failed: %v", err)
		return
	}
	if !found {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	owners, err := s.podOwners(ctx, ic.wid)
	if err != nil {
		log.Printf("moveItem failed: %v", err)
		return
	}
	if denial := removalDenialAt(ic.roomMap, item.X, item.Y, owners, ic.userID); denial != "" {
		c.send(svrItemRejected{Type: "itemRejected", Reason: denial})
		return
	}
	if denial := placementDenialAt(ic.roomMap, m.X, m.Y, owners, ic.userID); denial != "" {
		c.send(svrItemRejected{Type: "itemRejected", Reason: denial})
		return
	}
	moved, err := s.db.moveItem(ctx, ic.wid, m.ID, m.X, m.Y)
	if err != nil {
		log.Printf("moveItem failed: %v", err)
		return
	}
	if !moved {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	s.broadcastItem(ic, c, svrItemMoved{Type: "itemMoved", ID: m.ID, X: m.X, Y: m.Y})
}

func (s *server) handleScaleItem(c *client, m scaleItemMsg) {
	// resize a prop with the size slider: same permission as moving it — only
	// someone else's claimed pod protects one. The size itself was clamped in
	// the decoder, so nothing here can store an absurd prop
	ic, ok := s.itemContextOf(c, "scaleItem")
	if !ok {
		return
	}
	ctx := context.Background()
	item, found, err := s.db.itemByID(ctx, ic.wid, m.ID)
	if err != nil {
		log.Printf("scaleItem failed: %v", err)
		return
	}
	if !found {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	owners, err := s.podOwners(ctx, ic.wid)
	if err != nil {
		log.Printf("scaleItem failed: %v", err)
		return
	}
	if denial := removalDenialAt(ic.roomMap, item.X, item.Y, owners, ic.userID); denial != "" {
		c.send(svrItemRejected{Type: "itemRejected", Reason: denial})
		return
	}
	scaled, err := s.db.scaleItem(ctx, ic.wid, m.ID, m.Scale)
	if err != nil {
		log.Printf("scaleItem failed: %v", err)
		return
	}
	if !scaled {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	s.broadcastItem(ic, c, svrItemScaled{Type: "itemScaled", ID: m.ID, Scale: m.Scale})
}

func (s *server) handleColorItem(c *client, m colorItemMsg) {
	// recolor a prop with the color picker: same permission as moving it — only
	// someone else's claimed pod protects one. The color was normalized in the
	// decoder, so nothing here can store anything but a hex or a null
	ic, ok := s.itemContextOf(c, "colorItem")
	if !ok {
		return
	}
	ctx := context.Background()
	item, found, err := s.db.itemByID(ctx, ic.wid, m.ID)
	if err != nil {
		log.Printf("colorItem failed: %v", err)
		return
	}
	if !found {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	owners, err := s.podOwners(ctx, ic.wid)
	if err != nil {
		log.Printf("colorItem failed: %v", err)
		return
	}
	if denial := removalDenialAt(ic.roomMap, item.X, item.Y, owners, ic.userID); denial != "" {
		c.send(svrItemRejected{Type: "itemRejected", Reason: denial})
		return
	}
	colored, err := s.db.colorItem(ctx, ic.wid, m.ID, m.Color)
	if err != nil {
		log.Printf("colorItem failed: %v", err)
		return
	}
	if !colored {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	s.broadcastItem(ic, c, svrItemColored{Type: "itemColored", ID: m.ID, Color: m.Color})
}

func (s *server) handleRaiseItem(c *client, m raiseItemMsg) {
	// nudge a prop's draw order with the FRONT/BACK buttons: same permission as
	// moving it, since it never leaves the deck point it stands on. The nudge
	// was clamped in the decoder, so nothing here can bury a whole room
	ic, ok := s.itemContextOf(c, "raiseItem")
	if !ok {
		return
	}
	ctx := context.Background()
	item, found, err := s.db.itemByID(ctx, ic.wid, m.ID)
	if err != nil {
		log.Printf("raiseItem failed: %v", err)
		return
	}
	if !found {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	owners, err := s.podOwners(ctx, ic.wid)
	if err != nil {
		log.Printf("raiseItem failed: %v", err)
		return
	}
	if denial := removalDenialAt(ic.roomMap, item.X, item.Y, owners, ic.userID); denial != "" {
		c.send(svrItemRejected{Type: "itemRejected", Reason: denial})
		return
	}
	raised, err := s.db.raiseItem(ctx, ic.wid, m.ID, m.Depth)
	if err != nil {
		log.Printf("raiseItem failed: %v", err)
		return
	}
	if !raised {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	s.broadcastItem(ic, c, svrItemRaised{Type: "itemRaised", ID: m.ID, Depth: m.Depth})
}

func (s *server) handleDeleteItem(c *client, m deleteItemMsg) {
	// clear a prop away; only someone else's claimed pod protects one
	ic, ok := s.itemContextOf(c, "deleteItem")
	if !ok {
		return
	}
	ctx := context.Background()
	item, found, err := s.db.itemByID(ctx, ic.wid, m.ID)
	if err != nil {
		log.Printf("deleteItem failed: %v", err)
		return
	}
	if !found {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	owners, err := s.podOwners(ctx, ic.wid)
	if err != nil {
		log.Printf("deleteItem failed: %v", err)
		return
	}
	if denial := removalDenialAt(ic.roomMap, item.X, item.Y, owners, ic.userID); denial != "" {
		c.send(svrItemRejected{Type: "itemRejected", Reason: denial})
		return
	}
	deleted, err := s.db.deleteItem(ctx, ic.wid, m.ID)
	if err != nil {
		log.Printf("deleteItem failed: %v", err)
		return
	}
	if !deleted {
		c.send(svrItemRejected{Type: "itemRejected", Reason: "gone"})
		return
	}
	s.broadcastItem(ic, c, svrItemDeleted{Type: "itemDeleted", ID: m.ID})
	log.Printf("%s cleared %s", ic.name, item.Kind)
}

// --- shuttle race (holotable game) ---

func (s *server) handleRaceJoin(c *client) {
	// join the lobby: on foot, standing at a game table, no race running
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("raceJoin before join, dropped")
		return
	}
	p := sess.player
	if r.race != nil && r.race.racing {
		c.send(svrRaceRejected{Type: "raceRejected", Reason: "raceInProgress"})
		return
	}
	if p.ShipPad != nil || p.Blasting {
		c.send(svrRaceRejected{Type: "raceRejected", Reason: "flying"})
		return
	}
	nearTable := false
	for _, t := range s.mapOfRoom(r).GameTables {
		if t.Game == tableGameRace && math.Hypot(t.X-p.X, t.Y-p.Y) <= tableJoinRadius {
			nearTable = true
			break
		}
	}
	if !nearTable {
		c.send(svrRaceRejected{Type: "raceRejected", Reason: "notNearTable"})
		return
	}
	if reason := r.raceJoin(c.selfID); reason != "" {
		c.send(svrRaceRejected{Type: "raceRejected", Reason: reason})
		return
	}
	// one lobby seat at a time: taking a race seat gives up a blasters seat
	if r.blastLobbyDrop(c.selfID) {
		s.broadcastBlastLobby(r)
	}
	s.broadcastRaceLobby(r)
}

func (s *server) handleRaceLeave(c *client) {
	// leave the lobby, or drop out of a running race; not being in either is
	// a harmless no-op (a stale click)
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("raceLeave before join, dropped")
		return
	}
	if r.raceLobbyDrop(c.selfID) {
		s.broadcastRaceLobby(r)
		return
	}
	if !r.raceRacerDrop(c.selfID) {
		return
	}
	// quitter back on foot: the client teleports home and sends its pos; the
	// room learns the shuttle is gone from this broadcast
	left := svrRaceLeft{Type: "raceLeft", ID: c.selfID}
	for _, other := range r.allSessions() {
		other.sock.send(left)
	}
	s.raceTransitionOut(r, sess.player)
	if r.raceAllDone() {
		s.endRace(r)
	}
}

func (s *server) handleRaceReady(c *client, m raceReadyMsg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("raceReady before join, dropped")
		return
	}
	if reason := r.raceSetReady(c.selfID, m.On); reason != "" {
		c.send(svrRaceRejected{Type: "raceRejected", Reason: reason})
		return
	}
	s.broadcastRaceLobby(r)
}

func (s *server) handleRaceStart(c *client) {
	// any member may start once everyone is ready: build the course over the
	// current layout, put every member in a shuttle on the grid, and count down
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("raceStart before join, dropped")
		return
	}
	if reason := r.raceStartDenial(c.selfID); reason != "" {
		c.send(svrRaceRejected{Type: "raceRejected", Reason: reason})
		return
	}
	race := r.race
	members := append([]string{}, race.order...)
	// a new race reclaims the comms channel: anyone still holding it from the
	// last race's debrief (scoreboard never closed) is released, so outsiders
	// don't ride along in the fresh field's comms
	for _, other := range r.allSessions() {
		p := other.player
		if p.Debrief != nil && *p.Debrief == "race" && !raceHas(members, p.ID) {
			s.endDebrief(r, p)
		}
	}
	gates, starts, _ := buildRaceCourse(s.mapOfRoom(r), len(members))
	race.racing = true
	race.gates = gates
	race.startedAt = nowMs() + raceCountdownMs
	race.deadline = race.startedAt + raceMaxDurationMs
	race.progress = map[string]int{}
	race.finished = map[string]raceFinish{}
	racers := []RaceStart{}
	for i, id := range members {
		msess := r.sessionOf(id)
		if msess == nil {
			// departures drop members from the lobby, so this shouldn't hit;
			// skipping keeps a race consistent if it ever does
			race.order = raceRemove(race.order, id)
			continue
		}
		p := msess.player
		race.names[id] = p.Name
		race.userIDs[id] = msess.userID
		race.progress[id] = 0
		st := starts[i]
		st.ID = id
		// teleport into the grid slot, leave any zone, join race comms; the
		// transitions run one player at a time, so each diff sees the racers
		// before them already grouped
		prevGroup := audioGroupOf(p)
		p.X, p.Y = st.X, st.Y
		heading := st.A
		p.ShipA = &heading
		p.Racing = true
		// racing supersedes any lingering debrief (prevGroup already named it,
		// so the diff below moves them out of the old channel correctly)
		p.Debrief = nil
		previous := strOf(p.ZoneID)
		p.ZoneID = nil
		if previous != "" {
			changed := svrZoneChanged{Type: "zoneChanged", ID: id, ZoneID: nil}
			for _, other := range r.allSessions() {
				other.sock.send(changed)
			}
		}
		others := playersOf(r.othersOf(id))
		sendPairingDiff(r, id, msess.sock, diffPairs(prevGroup, raceGroup, others))
		racers = append(racers, st)
	}
	started := svrRaceStarted{Type: "raceStarted", Gates: gates, Racers: racers}
	for _, other := range r.allSessions() {
		other.sock.send(started)
	}
	log.Printf("race started with %d racer(s)", len(racers))
}

func (s *server) handleRaceProgress(c *client, m raceProgressMsg) {
	// a gate pass, detected client-side; the server enforces one-at-a-time
	// order and assigns finish places/times
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("raceProgress before join, dropped")
		return
	}
	valid, finish := r.raceRecordProgress(c.selfID, m.Gate, nowMs())
	if !valid {
		log.Printf("raceProgress gate %d from %s out of order, dropped", m.Gate, c.selfID)
		return
	}
	if finish == nil {
		// mid-course: the sender tracks its own progress locally
		broadcastFrom(r, c.selfID, svrRaceProgress{Type: "raceProgress", ID: c.selfID, Gate: m.Gate})
		return
	}
	// crossed the last gate: standings to everyone (finisher included — this
	// is how they learn their place), then into the debrief — the finisher
	// keeps race comms while their scoreboard is up
	finished := svrRaceFinished{Type: "raceFinished", ID: c.selfID, Place: finish.place, TimeMs: finish.timeMs}
	for _, other := range r.allSessions() {
		other.sock.send(finished)
	}
	s.transitionToDebrief(r, sess.player, "race")
	if r.raceAllDone() {
		s.endRace(r)
	}
}

func (s *server) handleBoardClose(c *client, m boardCloseMsg) {
	// the post-game scoreboard was closed: release the matching debrief comms
	// hold. Closing a board without one (a spectator's results card, a stale
	// click after the next match reclaimed the channel) is a harmless no-op
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("boardClose before join, dropped")
		return
	}
	if sess.player.Debrief == nil || *sess.player.Debrief != m.Game {
		return
	}
	s.endDebrief(r, sess.player)
}

// --- shuttle blasters (holotable game) ---

func (s *server) handleBlastJoin(c *client) {
	// join the lobby: on foot, standing at a blasters game table, no match running
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("blastJoin before join, dropped")
		return
	}
	p := sess.player
	if r.blast != nil && r.blast.playing {
		c.send(svrBlastRejected{Type: "blastRejected", Reason: "matchInProgress"})
		return
	}
	if p.ShipPad != nil || p.Racing {
		c.send(svrBlastRejected{Type: "blastRejected", Reason: "flying"})
		return
	}
	nearTable := false
	for _, t := range s.mapOfRoom(r).GameTables {
		if t.Game == tableGameBlast && math.Hypot(t.X-p.X, t.Y-p.Y) <= tableJoinRadius {
			nearTable = true
			break
		}
	}
	if !nearTable {
		c.send(svrBlastRejected{Type: "blastRejected", Reason: "notNearTable"})
		return
	}
	if reason := r.blastJoin(c.selfID); reason != "" {
		c.send(svrBlastRejected{Type: "blastRejected", Reason: reason})
		return
	}
	// one lobby seat at a time: taking a blasters seat gives up a race seat
	if r.raceLobbyDrop(c.selfID) {
		s.broadcastRaceLobby(r)
	}
	s.broadcastBlastLobby(r)
}

func (s *server) handleBlastLeave(c *client) {
	// leave the lobby, or forfeit a running match; not being in either is a
	// harmless no-op (a stale click)
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("blastLeave before join, dropped")
		return
	}
	if r.blastLobbyDrop(c.selfID) {
		s.broadcastBlastLobby(r)
		return
	}
	if !r.blastEliminate(c.selfID) {
		return
	}
	// quitter back on foot: the client teleports home and sends its pos; the
	// room learns the shuttle is gone from this broadcast
	left := svrBlastLeft{Type: "blastLeft", ID: c.selfID}
	for _, other := range r.allSessions() {
		other.sock.send(left)
	}
	s.blastTransitionOut(r, sess.player)
	if r.blastAllDone() {
		s.endBlast(r)
	}
}

func (s *server) handleBlastReady(c *client, m blastReadyMsg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("blastReady before join, dropped")
		return
	}
	if reason := r.blastSetReady(c.selfID, m.On); reason != "" {
		c.send(svrBlastRejected{Type: "blastRejected", Reason: reason})
		return
	}
	s.broadcastBlastLobby(r)
}

func (s *server) handleBlastStart(c *client) {
	// any member may start once everyone (at least two) is ready: build the
	// arena over the current layout, put every member in a shuttle on the
	// spawn ring, and count down
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("blastStart before join, dropped")
		return
	}
	if reason := r.blastStartDenial(c.selfID); reason != "" {
		c.send(svrBlastRejected{Type: "blastRejected", Reason: reason})
		return
	}
	blast := r.blast
	members := append([]string{}, blast.order...)
	// a new match reclaims the comms channel: anyone still holding it from the
	// last match's debrief (scoreboard never closed) is released, so outsiders
	// don't ride along in the fresh field's comms
	for _, other := range r.allSessions() {
		p := other.player
		if p.Debrief != nil && *p.Debrief == "blast" && !raceHas(members, p.ID) {
			s.endDebrief(r, p)
		}
	}
	arena, starts := buildBlastArena(s.mapOfRoom(r), len(members))
	blast.playing = true
	blast.arena = arena
	blast.startedAt = nowMs() + blastCountdownMs
	blast.deadline = blast.startedAt + blastMaxDurationMs
	blast.alive = map[string]bool{}
	blast.eliminated = []string{}
	blast.kills = map[string]int{}
	players := []RaceStart{}
	for i, id := range members {
		msess := r.sessionOf(id)
		if msess == nil {
			// departures drop members from the lobby, so this shouldn't hit;
			// skipping keeps a match consistent if it ever does
			blast.order = raceRemove(blast.order, id)
			continue
		}
		p := msess.player
		blast.names[id] = p.Name
		blast.userIDs[id] = msess.userID
		blast.alive[id] = true
		st := starts[i]
		st.ID = id
		// teleport onto the spawn ring, leave any zone, join match comms; the
		// transitions run one player at a time, so each diff sees the players
		// before them already grouped
		prevGroup := audioGroupOf(p)
		p.X, p.Y = st.X, st.Y
		heading := st.A
		p.ShipA = &heading
		p.Blasting = true
		// fighting supersedes any lingering debrief (prevGroup already named
		// it, so the diff below moves them out of the old channel correctly)
		p.Debrief = nil
		previous := strOf(p.ZoneID)
		p.ZoneID = nil
		if previous != "" {
			changed := svrZoneChanged{Type: "zoneChanged", ID: id, ZoneID: nil}
			for _, other := range r.allSessions() {
				other.sock.send(changed)
			}
		}
		others := playersOf(r.othersOf(id))
		sendPairingDiff(r, id, msess.sock, diffPairs(prevGroup, blastGroup, others))
		players = append(players, st)
	}
	started := svrBlastStarted{Type: "blastStarted", Arena: arena, Players: players}
	for _, other := range r.allSessions() {
		other.sock.send(started)
	}
	log.Printf("blasters match started with %d player(s)", len(players))
}

func (s *server) handleBlastFire(c *client, m blastFireMsg) {
	// a laser bolt, announced by its shooter; relayed so every canvas draws
	// it. Fires from the dead or during the countdown are dropped
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("blastFire before join, dropped")
		return
	}
	blast := r.blast
	if blast == nil || !blast.playing || !blast.alive[c.selfID] || nowMs() < blast.startedAt {
		return
	}
	broadcastFrom(r, c.selfID, svrBlastFire{Type: "blastFire", ID: c.selfID, X: m.X, Y: m.Y, A: m.A})
}

func (s *server) handleBlastHit(c *client, m blastHitMsg) {
	// the shooter's bolt touched a target's shuttle, detected client-side; the
	// server checks both are alive (and the countdown is over) and settles the
	// elimination — one blast destroys
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("blastHit before join, dropped")
		return
	}
	blast := r.blast
	if blast == nil || !blast.playing || nowMs() < blast.startedAt {
		return
	}
	if m.Target == c.selfID || !blast.alive[c.selfID] || !blast.alive[m.Target] {
		return
	}
	target := r.sessionOf(m.Target)
	if target == nil || !r.blastEliminate(m.Target) {
		return
	}
	// a settled hit credits the shooter (leaderboard); forfeits never get here
	blast.kills[c.selfID]++
	eliminated := svrBlastEliminated{Type: "blastEliminated", ID: m.Target, By: c.selfID}
	for _, other := range r.allSessions() {
		other.sock.send(eliminated)
	}
	// the fallen keep match comms while their scoreboard is up (the debrief)
	s.transitionToDebrief(r, target.player, "blast")
	if r.blastAllDone() {
		s.endBlast(r)
	}
}

// --- space link (workspace linking) ---

// how close to the portal a traversal must stand; a little more slack than
// the client's hint radius, like the game tables
const spaceLinkJoinRadius = 90.0

// the overlay's state for this session's HOME workspace (Q5): its Links for
// everyone aboard, the management lists only for home's creator. Fetched
// fresh per request — the overlay opens with a spaceLink message and every
// management action answers with a fresh state
func (s *server) handleSpaceLink(c *client) {
	s.mu.Lock()
	_, sess := c.boundSession()
	if sess == nil {
		s.mu.Unlock()
		log.Printf("spaceLink before join, dropped")
		return
	}
	homeID, userID := c.homeID, sess.userID
	s.mu.Unlock()
	s.sendLinkState(c, homeID, userID)
}

// fetch + send one fresh spaceLinkState; a vanished home just logs (the
// deletion kick is already on its way to this socket)
func (s *server) sendLinkState(c *client, homeID, userID string) {
	ctx := context.Background()
	home, err := s.db.workspaceByID(ctx, homeID)
	if err != nil {
		log.Printf("spaceLink failed: %v", err)
		return
	}
	if home == nil {
		log.Printf("spaceLink for deleted home %s, dropped", homeID)
		return
	}
	creator := home.createdBy == userID
	st, err := s.db.linkStateOf(ctx, homeID, creator)
	if err != nil {
		log.Printf("spaceLink failed: %v", err)
		return
	}
	c.send(svrSpaceLinkState{
		Type:     "spaceLinkState",
		Home:     WorkspaceInfo{Slug: home.slug, Name: home.name},
		Creator:  creator,
		Links:    st.links,
		Inbound:  st.inbound,
		Outbound: st.outbound,
		Blocks:   st.blocks,
	})
}

// binds a link management message: the caller must be aboard, at home, and
// home's creator (Q3/Q5 — management is creator-only and shows only at home).
// ok=false means the refusal (or drop) was already handled
func (s *server) linkManagementContext(c *client, verb string) (homeID, userID string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, sess := c.boundSession()
	if sess == nil {
		log.Printf("%s before join, dropped", verb)
		return "", "", false
	}
	if c.workspaceID != c.homeID || !c.isOwner {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: "notCreator"})
		return "", "", false
	}
	return c.homeID, sess.userID, true
}

// petition another workspace by typed name (Q9); the overlay refreshes on ok
func (s *server) handleLinkRequest(c *client, m linkRequestMsg) {
	homeID, userID, ok := s.linkManagementContext(c, "linkRequest")
	if !ok {
		return
	}
	result, err := s.db.createLinkRequest(context.Background(), homeID, m.Name)
	if err != nil {
		log.Printf("linkRequest failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: result})
		return
	}
	s.sendLinkState(c, homeID, userID)
	log.Printf("workspace %s requested a link to %q", homeID, m.Name)
}

// withdraw home's own outbound request; idempotent
func (s *server) handleLinkCancel(c *client, m linkCancelMsg) {
	homeID, userID, ok := s.linkManagementContext(c, "linkCancel")
	if !ok {
		return
	}
	result, err := s.db.cancelLinkRequest(context.Background(), homeID, m.Slug)
	if err != nil {
		log.Printf("linkCancel failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: result})
		return
	}
	s.sendLinkState(c, homeID, userID)
}

// accept an inbound request: the Link lands (Blocks + both caps re-checked)
func (s *server) handleLinkAccept(c *client, m linkAcceptMsg) {
	homeID, userID, ok := s.linkManagementContext(c, "linkAccept")
	if !ok {
		return
	}
	result, fromID, err := s.db.acceptLinkRequest(context.Background(), homeID, m.Slug)
	if err != nil {
		log.Printf("linkAccept failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: result})
		return
	}
	s.sendLinkState(c, homeID, userID)
	log.Printf("workspaces %s and %s linked", homeID, fromID)
}

// deny an inbound request; idempotent
func (s *server) handleLinkDeny(c *client, m linkDenyMsg) {
	homeID, userID, ok := s.linkManagementContext(c, "linkDeny")
	if !ok {
		return
	}
	result, err := s.db.denyLinkRequest(context.Background(), homeID, m.Slug)
	if err != nil {
		log.Printf("linkDeny failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: result})
		return
	}
	s.sendLinkState(c, homeID, userID)
}

// remove a standing Link: the edge dies in both directions and Visitors it
// admitted are kicked back home, both ways (Q1/Q7)
func (s *server) handleLinkRemove(c *client, m linkRemoveMsg) {
	homeID, userID, ok := s.linkManagementContext(c, "linkRemove")
	if !ok {
		return
	}
	result, otherID, err := s.db.removeLink(context.Background(), homeID, m.Slug)
	if err != nil {
		log.Printf("linkRemove failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: result})
		return
	}
	s.kickVisitorsBetween(homeID, otherID)
	s.sendLinkState(c, homeID, userID)
	log.Printf("link between %s and %s removed", homeID, otherID)
}

// place a Block by typed name (Q8): one action — pending requests die, any
// Link is removed, Visitors are kicked both ways
func (s *server) handleLinkBlock(c *client, m linkBlockMsg) {
	homeID, userID, ok := s.linkManagementContext(c, "linkBlock")
	if !ok {
		return
	}
	result, otherID, err := s.db.blockWorkspace(context.Background(), homeID, m.Name)
	if err != nil {
		log.Printf("linkBlock failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: result})
		return
	}
	s.kickVisitorsBetween(homeID, otherID)
	s.sendLinkState(c, homeID, userID)
	log.Printf("workspace %s blocked %s", homeID, otherID)
}

// lift a Block; restores nothing (Q8)
func (s *server) handleLinkUnblock(c *client, m linkUnblockMsg) {
	homeID, userID, ok := s.linkManagementContext(c, "linkUnblock")
	if !ok {
		return
	}
	result, err := s.db.unblockWorkspace(context.Background(), homeID, m.Slug)
	if err != nil {
		log.Printf("linkUnblock failed: %v", err)
		return
	}
	if result != "ok" {
		c.send(svrLinkRejected{Type: "linkRejected", Reason: result})
		return
	}
	s.sendLinkState(c, homeID, userID)
}

// a Link between the pair died: kick the Visitors it admitted, both ways —
// each is told visitEnded (their client re-boards home on its own) and their
// parked tokens die too. roomFor may lazy-create an empty room; the sweep
// reaps it (same precedent as the member-removal kick)
func (s *server) kickVisitorsBetween(widA, widB string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, pair := range [][2]string{{widA, widB}, {widB, widA}} {
		room := s.rooms.roomFor(pair[0])
		for _, sess := range room.visitorSessionsOf(pair[1]) {
			s.endVisitorSession(room, sess)
		}
		room.dropParkedOfHome(pair[1])
	}
}

// end one Visitor's session in a room: visitEnded + close — their client
// re-boards home, landing at its spawn point (Q7). Caller holds s.mu
func (s *server) endVisitorSession(room *roomState, sess *session) {
	sess.sock.send(svrKicked{Type: "kicked", Reason: "visitEnded"})
	room.evict(sess.player.ID)
	s.announceDeparture(room, sess.player)
	s.raceDeparted(room, sess.player)
	s.blastDeparted(room, sess.player)
	sess.sock.close()
	log.Printf("%s's visit ended (%s)", sess.player.Name, sess.player.ID)
}

// step through the portal: move this session into a workspace linked to its
// home — or back into home itself. The move re-boards the room join-style
// (fresh welcome, fresh resume token); the visit is pure session state, so
// nothing persists (ADR 0004)
func (s *server) handleVisit(c *client, m visitMsg) {
	ctx := context.Background()
	s.mu.Lock()
	r, sess := c.boundSession()
	if sess == nil {
		s.mu.Unlock()
		log.Printf("visit before join, dropped")
		return
	}
	p := sess.player
	// traversal happens on foot, standing at the portal
	if p.ShipPad != nil || p.Racing || p.Blasting {
		s.mu.Unlock()
		c.send(svrVisitRejected{Type: "visitRejected", Reason: "flying"})
		return
	}
	portal := s.mapOfRoom(r).SpaceLink
	if math.Hypot(portal.X-p.X, portal.Y-p.Y) > spaceLinkJoinRadius {
		s.mu.Unlock()
		c.send(svrVisitRejected{Type: "visitRejected", Reason: "notNearLink"})
		return
	}
	userID := sess.userID
	homeID, homeSlug, homeName := c.homeID, c.homeSlug, c.homeName
	// the traveler's live presence carries through the portal
	carry := joinInput{
		userID:    userID,
		name:      p.Name,
		micOn:     p.MicOn,
		camOn:     p.CamOn,
		character: p.Character,
		status:    p.Status,
		homeID:    homeID,
		homeSlug:  homeSlug,
		homeName:  homeName,
	}
	fromWid, fromID := c.workspaceID, c.selfID
	s.mu.Unlock()

	fail := func(err error) { log.Printf("visit failed: %v", err) }
	reject := func(reason string) {
		c.send(svrVisitRejected{Type: "visitRejected", Reason: reason})
	}
	target, err := s.db.workspaceBySlug(ctx, m.Slug)
	if err != nil {
		fail(err)
		return
	}
	if target == nil {
		reject("notFound")
		return
	}
	goingHome := target.id == homeID
	if !goingHome {
		// every hop is judged against HOME's links — no transitivity (Q5)
		linked, err := s.db.linkExists(ctx, homeID, target.id)
		if err != nil {
			fail(err)
			return
		}
		if !linked {
			reject("notLinked")
			return
		}
	}
	// bans gate Visits exactly as they gate boarding (Q7); a member of the
	// target passing through a link is admitted like any visitor. Returning
	// home additionally requires the home membership to still stand
	admit, err := s.db.admitMember(ctx, target.id, userID)
	if err != nil {
		fail(err)
		return
	}
	if admit == "removed" {
		reject("removed")
		return
	}
	if goingHome && admit != "ok" {
		// the home membership died while out — the session dies with it (Q7)
		c.send(svrKicked{Type: "kicked", Reason: "removed"})
		c.close()
		return
	}
	loadedMap, err := s.loadRoomMap(ctx, target.id)
	if err != nil {
		fail(err)
		return
	}
	pods, err := s.db.podsOf(ctx, target.id)
	if err != nil {
		fail(err)
		return
	}
	items, err := s.db.itemsOf(ctx, target.id)
	if err != nil {
		fail(err)
		return
	}
	boards, err := s.db.leaderboardsOf(ctx, target.id)
	if err != nil {
		fail(err)
		return
	}
	// the new stay's time-tracking row; the old one closes below
	sessionRowID := gonanoid.Must()
	if err := s.db.createWorkspaceSession(ctx, sessionRowID, target.id, userID); err != nil {
		log.Printf("workspace session start failed: %v", err)
		sessionRowID = ""
	}

	s.mu.Lock()
	// the socket may have died — or the session been kicked/moved — during
	// the db calls; a stale traversal must not board anything
	r2, sess2 := c.boundSession()
	if !c.isOpen() || sess2 == nil || r2 != r || c.workspaceID != fromWid || c.selfID != fromID {
		s.mu.Unlock()
		if sessionRowID != "" {
			persist("workspace session end", func() error {
				return s.db.endWorkspaceSession(context.Background(), sessionRowID)
			})
		}
		return
	}
	targetRoom := s.rooms.roomFor(target.id)
	if targetRoom.roomMap == nil {
		targetRoom.roomMap = loadedMap
	}
	// the Visitor cap is checked live at traversal, and only for Visits —
	// members are never blocked from their own workspace (Q11)
	if !goingHome && targetRoom.visitorCount() >= maxVisitorsPerWorkspace {
		s.mu.Unlock()
		if sessionRowID != "" {
			persist("workspace session end", func() error {
				return s.db.endWorkspaceSession(context.Background(), sessionRowID)
			})
		}
		reject("full")
		return
	}
	// leave the current room for good — the deliberate move parks nothing
	r.evict(fromID)
	s.announceDeparture(r, sess2.player)
	s.raceDeparted(r, sess2.player)
	s.blastDeparted(r, sess2.player)
	// board the target at its own portal — you step out of the far gate
	roomMap := targetRoom.roomMap
	spawnAt := roomMap.SpaceLink
	zoneID := ""
	if z := zoneAt(roomMap, spawnAt.X, spawnAt.Y); z != nil {
		zoneID = z.ID
	}
	if !goingHome {
		carry.visitingFrom = &homeName
	}
	player, resumeToken := targetRoom.join(carry, spawnAt, zoneID, c)
	oldRowID := c.sessionRowID
	c.room = targetRoom
	c.selfID = player.ID
	c.workspaceID = target.id
	c.isOwner = target.createdBy == userID
	c.sessionRowID = sessionRowID
	c.send(svrWelcome{
		Type:         "welcome",
		SelfID:       player.ID,
		Workspace:    WorkspaceInfo{Slug: target.slug, Name: target.name},
		Home:         WorkspaceInfo{Slug: homeSlug, Name: homeName},
		Owner:        c.isOwner,
		Map:          roomMap,
		Roster:       targetRoom.roster(),
		ResumeToken:  resumeToken,
		IceServers:   mintIceServers(s.turn, nowMs()),
		Pods:         pods,
		Items:        items,
		Chat:         targetRoom.chatHistory(),
		Race:         targetRoom.raceSnapshot(),
		Blast:        targetRoom.blastSnapshot(),
		Leaderboards: boards,
	})
	broadcastFrom(targetRoom, player.ID, svrPlayerJoined{Type: "playerJoined", Player: player})
	others := playersOf(targetRoom.othersOf(player.ID))
	sendPairingDiff(targetRoom, player.ID, c, diffPairs("", audioGroupOf(player), others))
	s.mu.Unlock()
	// the old stay ended with the traversal, not the socket
	if oldRowID != "" {
		persist("workspace session end", func() error {
			return s.db.endWorkspaceSession(context.Background(), oldRowID)
		})
	}
	if goingHome {
		log.Printf("%s returned home to %s", player.Name, target.slug)
	} else {
		log.Printf("%s is visiting %s from %s", player.Name, target.slug, homeName)
	}
}

func (s *server) handleEditMap(c *client, m editMapMsg) {
	// replace the workspace's layout: creator-only. Decoding already
	// validated shape; semantics (disjoint zones, spawn on a floor, caps)
	// run through the same checks the editor uses
	s.mu.Lock()
	if c.selfID == "" || c.room == nil || c.workspaceID == "" {
		s.mu.Unlock()
		log.Printf("editMap before join, dropped")
		return
	}
	if !c.isOwner {
		s.mu.Unlock()
		c.send(svrMapRejected{Type: "mapRejected", Reason: "notCreator"})
		return
	}
	if denial := mapEditDenial(m.Map); denial != "" {
		s.mu.Unlock()
		c.send(svrMapRejected{Type: "mapRejected", Reason: "invalidMap"})
		log.Printf("editMap rejected (%s): %s", c.selfID, denial)
		return
	}
	r, selfID, wid := c.room, c.selfID, c.workspaceID
	s.mu.Unlock()

	ctx := context.Background()
	newMap := m.Map
	if err := s.db.saveMap(ctx, wid, newMap); err != nil {
		log.Printf("editMap failed: %v", err)
		return
	}
	// claims on zones that are gone or no longer pods are freed — a claim
	// must always point at a claimable zone
	podZones := map[string]bool{}
	for i := range newMap.Zones {
		if newMap.Zones[i].isPod() {
			podZones[newMap.Zones[i].ID] = true
		}
	}
	pods, err := s.db.podsOf(ctx, wid)
	if err != nil {
		log.Printf("editMap failed: %v", err)
		return
	}
	for _, pod := range pods {
		if !podZones[pod.ZoneID] {
			if err := s.db.deletePodClaim(ctx, wid, pod.ZoneID); err != nil {
				log.Printf("editMap failed: %v", err)
				return
			}
		}
	}
	// pods reread so the pruning above is reflected without per-row broadcasts
	pods, err = s.db.podsOf(ctx, wid)
	if err != nil {
		log.Printf("editMap failed: %v", err)
		return
	}
	// props whose deck vanished go with it, like a player whose floor is gone
	// is returned to the spawn (notes/017)
	items, err := s.db.itemsOf(ctx, wid)
	if err != nil {
		log.Printf("editMap failed: %v", err)
		return
	}
	stranded := []string{}
	kept := []PlacedItem{}
	for _, it := range items {
		if inFloor(newMap, it.X, it.Y) {
			kept = append(kept, it)
			continue
		}
		stranded = append(stranded, it.ID)
	}
	if err := s.db.deleteItems(ctx, wid, stranded); err != nil {
		log.Printf("editMap failed: %v", err)
		return
	}

	s.mu.Lock()
	r.roomMap = newMap
	// everyone re-renders from this one message
	changed := svrMapChanged{Type: "mapChanged", Map: newMap, Pods: pods, Items: kept}
	for _, sess := range r.allSessions() {
		sess.sock.send(changed)
	}
	// zones may have moved under standing players: re-derive every
	// membership, then re-pair A/V from the full before/after pair diff
	before := coZonePairs(r.roster())
	for _, sess := range r.allSessions() {
		p := sess.player
		zoneID := ""
		if p.ShipPad == nil {
			if z := zoneAt(newMap, p.X, p.Y); z != nil {
				zoneID = z.ID
			}
		}
		if strOf(p.ZoneID) == zoneID {
			continue
		}
		p.ZoneID = optStr(zoneID)
		zoneChanged := svrZoneChanged{Type: "zoneChanged", ID: p.ID, ZoneID: p.ZoneID}
		for _, other := range r.allSessions() {
			other.sock.send(zoneChanged)
		}
	}
	after := coZonePairs(r.roster())
	for key, pair := range before {
		if _, ok := after[key]; ok {
			continue
		}
		a, b := pair[0], pair[1]
		if sa := r.sessionOf(a); sa != nil {
			sa.sock.send(svrPeerDisconnect{Type: "peerDisconnect", PeerID: b})
		}
		if sb := r.sessionOf(b); sb != nil {
			sb.sock.send(svrPeerDisconnect{Type: "peerDisconnect", PeerID: a})
		}
	}
	for key, pair := range after {
		if _, ok := before[key]; ok {
			continue
		}
		a, b := pair[0], pair[1]
		if sa := r.sessionOf(a); sa != nil {
			sa.sock.send(svrPeerConnect{Type: "peerConnect", PeerID: b, Initiator: isInitiator(a, b)})
		}
		if sb := r.sessionOf(b); sb != nil {
			sb.sock.send(svrPeerConnect{Type: "peerConnect", PeerID: a, Initiator: isInitiator(b, a)})
		}
	}
	s.mu.Unlock()
	log.Printf("map edited in workspace %s by %s", wid, selfID)
}

func (s *server) handleSignal(c *client, m signalClientMsg) {
	// relay SDP/ICE to the named peer only; no co-zone guard — a candidate
	// racing a zone exit is dropped by the client's peer state machine, and
	// misrouted payloads can't reach anyone unnamed; the peer lookup spans
	// only this room
	s.mu.Lock()
	defer s.mu.Unlock()
	r, sess := c.boundSession()
	if sess == nil {
		log.Printf("signal before join, dropped")
		return
	}
	target := r.sessionOf(m.To)
	if target == nil {
		log.Printf("signal to unknown peer %s, dropped", m.To)
		return
	}
	target.sock.send(svrSignal{Type: "signal", From: c.selfID, Data: m.Data})
}
