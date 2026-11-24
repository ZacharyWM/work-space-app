// wire protocol (port of shared/src/protocol.ts): decode + validate every
// client message, and the typed server messages the handlers emit. The client
// keeps the TS zod schemas; field names, presence, and null-vs-absent must
// match them exactly
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
)

// --- shared shapes ---

// presence status a player sets for everyone to see
var playerStatuses = []string{"available", "busy", "away"}

// who a chat message reaches: zone = the sender's current zone occupants;
// ship = everyone; announce = ship-wide with a banner + chime
var chatScopes = []string{"zone", "ship", "announce"}

// the emote palette: names on the wire, glyphs client-side
var emotes = []string{"thumbsUp", "heart", "laugh", "party", "wave", "question"}

// workspace slug as it rides the URL and join/resume: lowercase alphanumeric
// runs joined by single hyphens, max 32
var slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// invite email shape, matching the TS inviteEmailSchema: something@something,
// no whitespace — deliberately loose, a typo just makes a cancellable invite
var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+$`)

func validSlug(s string) bool { return len(s) <= 32 && slugPattern.MatchString(s) }

// zod string length limits count UTF-16 code units (JS string.length); match
// that so the go server accepts exactly what the TS client considers valid
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// JS String.prototype.trim equivalent (zod .trim()); Go's definition of space
// differs only on exotic code points no client sends
func trimSpaceJS(s string) string { return strings.TrimSpace(s) }

// a connected participant as seen by every client
type Player struct {
	ID string `json:"id"`
	// clerk user id behind this session; lets clients match a claimed pod to
	// its owner's live presence even when the owner stands elsewhere
	UserID string `json:"userId"`
	Name   string `json:"name"`
	// avatar hue in degrees, assigned by the server
	Hue float64 `json:"hue"`
	X   float64 `json:"x"`
	Y   float64 `json:"y"`
	// nil while in open space (JSON null)
	ZoneID   *string `json:"zoneId"`
	MicOn    bool    `json:"micOn"`
	CamOn    bool    `json:"camOn"`
	Speaking bool    `json:"speaking"`
	// true while this player shares their screen with their zone
	ScreenOn bool `json:"screenOn"`
	// self-set presence status, visible to everyone
	Status string `json:"status"`
	// avatar appearance, chosen by the player
	Character Character `json:"character"`
	// flight-deck pad index of the shuttle being flown; nil while on foot
	ShipPad *int `json:"shipPad"`
	// true while this player races a shuttle (shuttle race feature)
	Racing bool `json:"racing"`
	// true while this player fights in a blasters match (shuttle blasters feature)
	Blasting bool `json:"blasting"`
	// "race" or "blast" after finishing/falling while their scoreboard is still
	// up: keeps them in that game's comms group until boardClose, departure, or
	// the next match's start; nil otherwise (JSON null)
	Debrief *string `json:"debrief"`
	// the home Workspace's name while this person is a Visitor (aboard via a
	// Link, no Membership here); nil for members (space link feature)
	VisitingFrom *string `json:"visitingFrom"`
	// shuttle heading in radians; only meaningful while ShipPad is set or
	// Racing, and absent until the first in-flight pos arrives
	ShipA *float64 `json:"shipA,omitempty"`
}

// one shuttle race lobby member; during a race the members are the racers
type RaceMember struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Ready bool   `json:"ready"`
}

// one racer's grid slot: start pose, nose toward the first gate
type RaceStart struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	A  float64 `json:"a"`
}

// one row of the final standings; TimeMs nil = did not finish
type RaceResult struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	TimeMs *float64 `json:"timeMs"`
}

// race state as the welcome carries it (late joiners see the lobby / gates)
type RaceSnapshot struct {
	Racing  bool         `json:"racing"`
	Members []RaceMember `json:"members"`
	Gates   []Point      `json:"gates"`
}

// the circular blasters arena, generated around the hull at match start
type BlastArena struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	R float64 `json:"r"`
}

// one row of the blasters standings, winner first; Survived marks everyone
// still flying when the match ended
type BlastResult struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Survived bool   `json:"survived"`
}

// blasters state as the welcome carries it (late joiners see the lobby, and a
// running match's arena)
type BlastSnapshot struct {
	Playing bool         `json:"playing"`
	Members []RaceMember `json:"members"`
	Arena   *BlastArena  `json:"arena"`
}

// one leaderboard row: an account's best score in a game — race best time
// (ms, lower is better) or blast best kill count (higher is better)
type LeaderboardEntry struct {
	UserID string  `json:"userId"`
	Name   string  `json:"name"`
	Score  float64 `json:"score"`
}

// both games' per-workspace leaderboards, best first; the welcome carries
// them and every score change rebroadcasts them
type Leaderboards struct {
	Race  []LeaderboardEntry `json:"race"`
	Blast []LeaderboardEntry `json:"blast"`
}

// one chat message as everyone renders it: server-assigned id + timestamp,
// sender captured by id AND name, zoneId set only on zone-scoped messages
type ChatMessage struct {
	ID     string  `json:"id"`
	From   string  `json:"from"`
	Name   string  `json:"name"`
	Scope  string  `json:"scope"`
	ZoneID *string `json:"zoneId"`
	Text   string  `json:"text"`
	Ts     int64   `json:"ts"`
}

// what a client knows about a workspace: enough to label and link it
type WorkspaceInfo struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// a picker list entry: label/link info plus whether this account created the
// workspace — only creators may delete
type WorkspaceListEntry struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	Mine bool   `json:"mine"`
}

// one row of the member management panel; Email is omitted for accounts
// without one (phone-only) or rows not backfilled from clerk yet
type MemberEntry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Email   string `json:"email,omitempty"`
	Creator bool   `json:"creator"`
}

// one pod claim as it rides the welcome/podClaimed messages
type PodClaim struct {
	ZoneID string `json:"zoneId"`
	UserID string `json:"userId"`
	Name   string `json:"name"`
}

// every placeable decor kind (port of shared/src/items.ts ITEM_KINDS); the
// server only validates the tag — the art lives client-side
var itemKinds = []string{
	"desk", "deskL", "standingDesk", "execDesk", "glassDesk", "benchDesk",
	"chair", "monitor", "bookshelf", "whiteboard", "cabinet", "meetingTable",
	"couch", "beanbag", "sideTable", "rug", "lamp", "coffee", "cooler",
	"mug", "beerMug", "teaCup", "teapot", "wineGlass", "waterBottle", "sodaCan",
	"plant", "bonsai", "flowerVase", "cactus", "orchid", "snakePlant", "succulents",
	"monstera", "sunflower", "flowerBox",
	"crate", "locker", "rack", "tank",
	"arcade", "jukebox", "trophy", "duck", "cat",
}

// how many props one workspace may hold (shared MAX_ITEMS_PER_WORKSPACE)
const maxItemsPerWorkspace = 300

// how far a prop may be sized from its authored art (shared ITEM_SCALE_MIN /
// ITEM_SCALE_MAX); the client's slider offers exactly this range
const (
	itemScaleMin     = 0.5
	itemScaleMax     = 2.5
	itemScaleDefault = 1.0
)

// bound and quantize a requested size, so slider float noise and forged values
// alike land on a sane number (port of shared clampItemScale)
func clampItemScale(scale float64) float64 {
	if math.IsNaN(scale) || math.IsInf(scale, 0) {
		return itemScaleDefault
	}
	return math.Round(math.Min(itemScaleMax, math.Max(itemScaleMin, scale))*100) / 100
}

// how far a prop's draw order may be nudged from where it stands, in world px
// (shared ITEM_DEPTH_MAX); the client's FRONT/BACK buttons step within it
const itemDepthMax = 80.0

// bound and quantize a requested draw-order nudge (port of shared clampItemDepth)
func clampItemDepth(depth float64) float64 {
	if math.IsNaN(depth) || math.IsInf(depth, 0) {
		return 0
	}
	return math.Round(math.Min(itemDepthMax, math.Max(-itemDepthMax, depth)))
}

// a prop's color override is one lowercase #rrggbb (shared itemColorSchema);
// the art it tints and the shades derived from it are client-side entirely
var itemColorRe = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// fold a requested color to the one canonical form, or to nil for "the color
// the art was drawn in" — which is what an absent, malformed, or forged value
// all mean (port of shared normalizeItemColor)
func normalizeItemColor(color *string) *string {
	if color == nil {
		return nil
	}
	hex := strings.ToLower(strings.TrimSpace(*color))
	// #rgb is the same color as #rrggbb with every digit doubled
	if m, _ := regexp.MatchString(`^#[0-9a-f]{3}$`, hex); m {
		hex = fmt.Sprintf("#%c%c%c%c%c%c", hex[1], hex[1], hex[2], hex[2], hex[3], hex[3])
	}
	if !itemColorRe.MatchString(hex) {
		return nil
	}
	return &hex
}

// one placed prop as it rides the welcome and the item broadcasts
type PlacedItem struct {
	ID    string  `json:"id"`
	Kind  string  `json:"kind"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Scale float64 `json:"scale"`
	// draw-order nudge: biases the client's back-to-front y-sort only, so a
	// prop standing on a table can be lifted over it without being moved
	Depth float64 `json:"depth"`
	// color override, or null for the color the art was drawn in
	Color *string `json:"color"`
}

// one RTCPeerConnection iceServers entry, minted per welcome
type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// --- client → server ---

// decoded client messages; decodeClientMessage returns exactly one of these

type joinMsg struct {
	Token     string
	Workspace string
	MicOn     bool
	CamOn     bool
}

// a resume names the HOME workspace; Visited ("" = at home) names the room
// actually holding the parked session when the drop happened mid-Visit — the
// grace window resumes a Visit in place (space link feature, ADR 0004)
type resumeMsg struct {
	joinMsg
	Visited string
}
type listWorkspacesMsg struct{ Token string }
type createWorkspaceMsg struct{ Token, Name string }
type deleteWorkspaceMsg struct{ Token, Slug string }
type listMembersMsg struct{ Token, Slug string }
type removeMemberMsg struct{ Token, Slug, UserID string }
type unbanMemberMsg removeMemberMsg

// invites + join requests (notes/015); Email arrives trimmed and lowercased
// from the decoder, Name is a workspace name resolved via deriveSlug
type inviteMsg struct{ Token, Slug, Email string }
type cancelInviteMsg inviteMsg
type listPendingMsg struct{ Token string }
type acceptInviteMsg struct{ Token, Slug string }
type declineInviteMsg acceptInviteMsg
type requestJoinMsg struct{ Token, Name string }
type cancelRequestMsg struct{ Token, Slug string }
type approveRequestMsg struct{ Token, Slug, UserID string }
type denyRequestMsg approveRequestMsg
type posMsg struct {
	X, Y float64
	A    *float64
}
type shipMsg struct{ Pad *int } // nil = dock
type mediaStateMsg struct{ MicOn, CamOn bool }
type speakingMsg struct{ On bool }
type screenShareMsg struct{ On bool }
type characterMsg struct{ Character Character }
type statusMsg struct{ Status string }
type renameMsg struct{ Name string }
type waveMsg struct{ To string }
type chatClientMsg struct{ Scope, Text string }
type emoteMsg struct{ Emote string }
type claimPodMsg struct{ ZoneID string }
type releasePodMsg struct{}
type placeItemMsg struct {
	Kind  string
	X, Y  float64
	Scale float64
	Color *string
}
type moveItemMsg struct {
	ID   string
	X, Y float64
}
type scaleItemMsg struct {
	ID    string
	Scale float64
}
type colorItemMsg struct {
	ID    string
	Color *string
}
type raiseItemMsg struct {
	ID    string
	Depth float64
}
type deleteItemMsg struct{ ID string }
type raceJoinMsg struct{}
type raceLeaveMsg struct{}
type raceReadyMsg struct{ On bool }
type raceStartMsg struct{}
type raceProgressMsg struct{ Gate int }
type blastJoinMsg struct{}
type blastLeaveMsg struct{}
type blastReadyMsg struct{ On bool }
type blastStartMsg struct{}
type blastFireMsg struct{ X, Y, A float64 }
type blastHitMsg struct{ Target string }
type boardCloseMsg struct{ Game string }

// space link (workspace linking): overlay state, link management (home
// creator only), and portal traversal
type spaceLinkMsg struct{}
type linkRequestMsg struct{ Name string }
type linkCancelMsg struct{ Slug string }
type linkAcceptMsg struct{ Slug string }
type linkDenyMsg struct{ Slug string }
type linkRemoveMsg struct{ Slug string }
type linkBlockMsg struct{ Name string }
type linkUnblockMsg struct{ Slug string }
type visitMsg struct{ Slug string }
type editMapMsg struct{ Map *MapData }
type signalClientMsg struct {
	To   string
	Data json.RawMessage
}

// raw wire fields for every client message type; pointers make required-field
// presence checkable, RawMessage tells null apart from absent
type clientWire struct {
	Type      *string          `json:"type"`
	Token     *string          `json:"token"`
	Workspace *string          `json:"workspace"`
	Visited   *string          `json:"visited"`
	MicOn     *bool            `json:"micOn"`
	CamOn     *bool            `json:"camOn"`
	Name      *string          `json:"name"`
	Slug      *string          `json:"slug"`
	UserID    *string          `json:"userId"`
	Email     *string          `json:"email"`
	X         *float64         `json:"x"`
	Y         *float64         `json:"y"`
	A         *float64         `json:"a"`
	Pad       json.RawMessage  `json:"pad"`
	On        *bool            `json:"on"`
	Character *json.RawMessage `json:"character"`
	Status    *string          `json:"status"`
	To        *string          `json:"to"`
	Scope     *string          `json:"scope"`
	Text      *string          `json:"text"`
	Emote     *string          `json:"emote"`
	ZoneID    *string          `json:"zoneId"`
	ID        *string          `json:"id"`
	Kind      *string          `json:"kind"`
	Scale     *float64         `json:"scale"`
	Depth     *float64         `json:"depth"`
	Color     *string          `json:"color"`
	Map       *json.RawMessage `json:"map"`
	Data      json.RawMessage  `json:"data"`
	Gate      *float64         `json:"gate"`
	Target    *string          `json:"target"`
	Game      *string          `json:"game"`
}

// non-empty required string field
func reqStr(v *string, field string) (string, error) {
	if v == nil || *v == "" {
		return "", fmt.Errorf("missing %s", field)
	}
	return *v, nil
}

// required workspace slug field
func reqSlug(v *string, field string) (string, error) {
	if v == nil || !validSlug(*v) {
		return "", fmt.Errorf("invalid %s", field)
	}
	return *v, nil
}

// required bool field
func reqBool(v *bool, field string) (bool, error) {
	if v == nil {
		return false, fmt.Errorf("missing %s", field)
	}
	return *v, nil
}

// one of a fixed enum
func reqEnum(v *string, options []string, field string) (string, error) {
	if v != nil {
		for _, o := range options {
			if *v == o {
				return o, nil
			}
		}
	}
	return "", fmt.Errorf("invalid %s", field)
}

// invite email (zod inviteEmailSchema): trim, lowercase, bound the UTF-16
// length, then the loose shape rule — something@something, no whitespace
func reqEmail(v *string, field string) (string, error) {
	if v == nil {
		return "", fmt.Errorf("missing %s", field)
	}
	t := strings.ToLower(trimSpaceJS(*v))
	if n := utf16Len(t); n < 3 || n > 254 {
		return "", fmt.Errorf("invalid %s length", field)
	}
	if !emailPattern.MatchString(t) {
		return "", fmt.Errorf("invalid %s", field)
	}
	return t, nil
}

// zod .trim().min(1).max(n): trim first, then bound the UTF-16 length
func reqTrimmed(v *string, max int, field string) (string, error) {
	if v == nil {
		return "", fmt.Errorf("missing %s", field)
	}
	t := trimSpaceJS(*v)
	if n := utf16Len(t); n < 1 || n > max {
		return "", fmt.Errorf("invalid %s length", field)
	}
	return t, nil
}

// join/resume share one shape
func decodeJoin(w *clientWire) (joinMsg, error) {
	var m joinMsg
	var err error
	if m.Token, err = reqStr(w.Token, "token"); err != nil {
		return m, err
	}
	if m.Workspace, err = reqSlug(w.Workspace, "workspace"); err != nil {
		return m, err
	}
	if m.MicOn, err = reqBool(w.MicOn, "micOn"); err != nil {
		return m, err
	}
	m.CamOn, err = reqBool(w.CamOn, "camOn")
	return m, err
}

// parse + validate raw wire data (zod clientMessageSchema equivalent); the
// returned value is one of the *Msg structs above
func decodeClientMessage(raw []byte) (any, error) {
	var w clientWire
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, fmt.Errorf("not valid JSON: %w", err)
	}
	if w.Type == nil {
		return nil, fmt.Errorf("missing type")
	}
	switch *w.Type {
	case "join":
		m, err := decodeJoin(&w)
		return m, err
	case "resume":
		m, err := decodeJoin(&w)
		if err != nil {
			return nil, err
		}
		// visited is optional but must be a valid slug when present
		r := resumeMsg{joinMsg: m}
		if w.Visited != nil {
			if r.Visited, err = reqSlug(w.Visited, "visited"); err != nil {
				return nil, err
			}
		}
		return r, nil
	case "listWorkspaces":
		token, err := reqStr(w.Token, "token")
		return listWorkspacesMsg{Token: token}, err
	case "createWorkspace":
		token, err := reqStr(w.Token, "token")
		if err != nil {
			return nil, err
		}
		name, err := reqTrimmed(w.Name, 40, "name")
		return createWorkspaceMsg{Token: token, Name: name}, err
	case "deleteWorkspace":
		token, err := reqStr(w.Token, "token")
		if err != nil {
			return nil, err
		}
		slug, err := reqSlug(w.Slug, "slug")
		return deleteWorkspaceMsg{Token: token, Slug: slug}, err
	case "listMembers":
		token, err := reqStr(w.Token, "token")
		if err != nil {
			return nil, err
		}
		slug, err := reqSlug(w.Slug, "slug")
		return listMembersMsg{Token: token, Slug: slug}, err
	case "removeMember", "unbanMember":
		var m removeMemberMsg
		var err error
		if m.Token, err = reqStr(w.Token, "token"); err != nil {
			return nil, err
		}
		if m.Slug, err = reqSlug(w.Slug, "slug"); err != nil {
			return nil, err
		}
		if m.UserID, err = reqStr(w.UserID, "userId"); err != nil {
			return nil, err
		}
		if *w.Type == "unbanMember" {
			return unbanMemberMsg(m), nil
		}
		return m, nil
	case "invite", "cancelInvite":
		var m inviteMsg
		var err error
		if m.Token, err = reqStr(w.Token, "token"); err != nil {
			return nil, err
		}
		if m.Slug, err = reqSlug(w.Slug, "slug"); err != nil {
			return nil, err
		}
		if m.Email, err = reqEmail(w.Email, "email"); err != nil {
			return nil, err
		}
		if *w.Type == "cancelInvite" {
			return cancelInviteMsg(m), nil
		}
		return m, nil
	case "listPending":
		token, err := reqStr(w.Token, "token")
		return listPendingMsg{Token: token}, err
	case "acceptInvite", "declineInvite", "cancelRequest":
		token, err := reqStr(w.Token, "token")
		if err != nil {
			return nil, err
		}
		slug, err := reqSlug(w.Slug, "slug")
		if err != nil {
			return nil, err
		}
		switch *w.Type {
		case "acceptInvite":
			return acceptInviteMsg{Token: token, Slug: slug}, nil
		case "declineInvite":
			return declineInviteMsg{Token: token, Slug: slug}, nil
		default:
			return cancelRequestMsg{Token: token, Slug: slug}, nil
		}
	case "requestJoin":
		token, err := reqStr(w.Token, "token")
		if err != nil {
			return nil, err
		}
		// a workspace NAME (or slug — slugs are fixed points of deriveSlug),
		// bounded like createWorkspace's name
		name, err := reqTrimmed(w.Name, 40, "name")
		return requestJoinMsg{Token: token, Name: name}, err
	case "approveRequest", "denyRequest":
		var m approveRequestMsg
		var err error
		if m.Token, err = reqStr(w.Token, "token"); err != nil {
			return nil, err
		}
		if m.Slug, err = reqSlug(w.Slug, "slug"); err != nil {
			return nil, err
		}
		if m.UserID, err = reqStr(w.UserID, "userId"); err != nil {
			return nil, err
		}
		if *w.Type == "denyRequest" {
			return denyRequestMsg(m), nil
		}
		return m, nil
	case "pos":
		if w.X == nil || w.Y == nil {
			return nil, fmt.Errorf("missing x/y")
		}
		return posMsg{X: *w.X, Y: *w.Y, A: w.A}, nil
	case "ship":
		// pad is required but nullable: absent is invalid, null means dock
		if w.Pad == nil {
			return nil, fmt.Errorf("missing pad")
		}
		if string(w.Pad) == "null" {
			return shipMsg{Pad: nil}, nil
		}
		var pad float64
		if err := json.Unmarshal(w.Pad, &pad); err != nil || pad < 0 || pad != float64(int(pad)) {
			return nil, fmt.Errorf("invalid pad")
		}
		p := int(pad)
		return shipMsg{Pad: &p}, nil
	case "mediaState":
		var m mediaStateMsg
		var err error
		if m.MicOn, err = reqBool(w.MicOn, "micOn"); err != nil {
			return nil, err
		}
		m.CamOn, err = reqBool(w.CamOn, "camOn")
		return m, err
	case "speaking", "screenShare":
		on, err := reqBool(w.On, "on")
		if err != nil {
			return nil, err
		}
		if *w.Type == "speaking" {
			return speakingMsg{On: on}, nil
		}
		return screenShareMsg{On: on}, nil
	case "character":
		if w.Character == nil {
			return nil, fmt.Errorf("missing character")
		}
		var c Character
		if err := json.Unmarshal(*w.Character, &c); err != nil {
			return nil, fmt.Errorf("invalid character: %w", err)
		}
		if err := validateCharacter(c); err != nil {
			return nil, err
		}
		return characterMsg{Character: c}, nil
	case "status":
		status, err := reqEnum(w.Status, playerStatuses, "status")
		return statusMsg{Status: status}, err
	case "rename":
		name, err := reqTrimmed(w.Name, 32, "name")
		return renameMsg{Name: name}, err
	case "wave":
		to, err := reqStr(w.To, "to")
		return waveMsg{To: to}, err
	case "chat":
		scope, err := reqEnum(w.Scope, chatScopes, "scope")
		if err != nil {
			return nil, err
		}
		text, err := reqTrimmed(w.Text, 500, "text")
		return chatClientMsg{Scope: scope, Text: text}, err
	case "emote":
		emote, err := reqEnum(w.Emote, emotes, "emote")
		return emoteMsg{Emote: emote}, err
	case "claimPod":
		zoneID, err := reqStr(w.ZoneID, "zoneId")
		return claimPodMsg{ZoneID: zoneID}, err
	case "releasePod":
		return releasePodMsg{}, nil
	case "placeItem":
		kind, err := reqEnum(w.Kind, itemKinds, "kind")
		if err != nil {
			return nil, err
		}
		if w.X == nil || w.Y == nil {
			return nil, fmt.Errorf("missing x/y")
		}
		// an absent scale means the authored size (shared schema default)
		scale := itemScaleDefault
		if w.Scale != nil {
			scale = *w.Scale
		}
		// an absent or unparseable color means the color the art was drawn in
		return placeItemMsg{
			Kind:  kind,
			X:     *w.X,
			Y:     *w.Y,
			Scale: clampItemScale(scale),
			Color: normalizeItemColor(w.Color),
		}, nil
	case "moveItem":
		id, err := reqStr(w.ID, "id")
		if err != nil {
			return nil, err
		}
		if w.X == nil || w.Y == nil {
			return nil, fmt.Errorf("missing x/y")
		}
		return moveItemMsg{ID: id, X: *w.X, Y: *w.Y}, nil
	case "scaleItem":
		id, err := reqStr(w.ID, "id")
		if err != nil {
			return nil, err
		}
		if w.Scale == nil {
			return nil, fmt.Errorf("missing scale")
		}
		return scaleItemMsg{ID: id, Scale: clampItemScale(*w.Scale)}, nil
	case "colorItem":
		id, err := reqStr(w.ID, "id")
		if err != nil {
			return nil, err
		}
		// null is the explicit "put it back to the authored color", which is
		// the same nil the normalizer returns for anything it can't parse
		return colorItemMsg{ID: id, Color: normalizeItemColor(w.Color)}, nil
	case "raiseItem":
		id, err := reqStr(w.ID, "id")
		if err != nil {
			return nil, err
		}
		if w.Depth == nil {
			return nil, fmt.Errorf("missing depth")
		}
		return raiseItemMsg{ID: id, Depth: clampItemDepth(*w.Depth)}, nil
	case "deleteItem":
		id, err := reqStr(w.ID, "id")
		return deleteItemMsg{ID: id}, err
	case "raceJoin":
		return raceJoinMsg{}, nil
	case "raceLeave":
		return raceLeaveMsg{}, nil
	case "raceReady":
		on, err := reqBool(w.On, "on")
		return raceReadyMsg{On: on}, err
	case "raceStart":
		return raceStartMsg{}, nil
	case "raceProgress":
		// gate is the cumulative count of gates passed: a positive integer
		if w.Gate == nil || *w.Gate < 1 || *w.Gate != float64(int(*w.Gate)) {
			return nil, fmt.Errorf("invalid gate")
		}
		return raceProgressMsg{Gate: int(*w.Gate)}, nil
	case "blastJoin":
		return blastJoinMsg{}, nil
	case "blastLeave":
		return blastLeaveMsg{}, nil
	case "blastReady":
		on, err := reqBool(w.On, "on")
		return blastReadyMsg{On: on}, err
	case "blastStart":
		return blastStartMsg{}, nil
	case "blastFire":
		// a laser bolt's origin + heading, relayed for everyone's canvas
		if w.X == nil || w.Y == nil || w.A == nil {
			return nil, fmt.Errorf("missing x/y/a")
		}
		return blastFireMsg{X: *w.X, Y: *w.Y, A: *w.A}, nil
	case "blastHit":
		target, err := reqStr(w.Target, "target")
		return blastHitMsg{Target: target}, err
	case "boardClose":
		game, err := reqEnum(w.Game, []string{"race", "blast"}, "game")
		return boardCloseMsg{Game: game}, err
	case "spaceLink":
		return spaceLinkMsg{}, nil
	case "linkRequest", "linkBlock":
		// a workspace NAME (or slug — slugs are fixed points of deriveSlug),
		// bounded like createWorkspace's name
		name, err := reqTrimmed(w.Name, 40, "name")
		if err != nil {
			return nil, err
		}
		if *w.Type == "linkBlock" {
			return linkBlockMsg{Name: name}, nil
		}
		return linkRequestMsg{Name: name}, nil
	case "linkCancel", "linkAccept", "linkDeny", "linkRemove", "linkUnblock", "visit":
		slug, err := reqSlug(w.Slug, "slug")
		if err != nil {
			return nil, err
		}
		switch *w.Type {
		case "linkCancel":
			return linkCancelMsg{Slug: slug}, nil
		case "linkAccept":
			return linkAcceptMsg{Slug: slug}, nil
		case "linkDeny":
			return linkDenyMsg{Slug: slug}, nil
		case "linkRemove":
			return linkRemoveMsg{Slug: slug}, nil
		case "linkUnblock":
			return linkUnblockMsg{Slug: slug}, nil
		default:
			return visitMsg{Slug: slug}, nil
		}
	case "editMap":
		if w.Map == nil {
			return nil, fmt.Errorf("missing map")
		}
		m, err := parseMapData(*w.Map)
		if err != nil {
			return nil, err
		}
		return editMapMsg{Map: m}, nil
	case "signal":
		to, err := reqStr(w.To, "to")
		if err != nil {
			return nil, err
		}
		// opaque SDP/ICE payload; must survive a JSON round-trip. RawMessage
		// stays nil only when the key is absent — JSON null decodes to "null"
		if w.Data == nil {
			return nil, fmt.Errorf("missing data")
		}
		return signalClientMsg{To: to, Data: w.Data}, nil
	default:
		return nil, fmt.Errorf("unknown type %q", *w.Type)
	}
}

// --- server → client ---

// each struct carries its literal type tag so json.Marshal writes exactly the
// discriminated union the client's zod schemas expect

type svrJoinRejected struct {
	Type   string `json:"type"` // "joinRejected"
	Reason string `json:"reason"`
}
type svrWelcome struct {
	Type   string `json:"type"` // "welcome"
	SelfID string `json:"selfId"`
	// the room this session now stands in — the visited workspace during a
	// Visit (space link feature)
	Workspace WorkspaceInfo `json:"workspace"`
	// the session's home workspace; equals Workspace except while visiting
	Home WorkspaceInfo `json:"home"`
	Owner       bool          `json:"owner"`
	Map         *MapData      `json:"map"`
	Roster      []*Player     `json:"roster"`
	ResumeToken string        `json:"resumeToken"`
	IceServers  []IceServer   `json:"iceServers"`
	Pods        []PodClaim    `json:"pods"`
	Items       []PlacedItem  `json:"items"`
	Chat        []ChatMessage `json:"chat"`
	// the shuttle race lobby / running race (shuttle race feature)
	Race RaceSnapshot `json:"race"`
	// the shuttle blasters lobby / running match (shuttle blasters feature)
	Blast BlastSnapshot `json:"blast"`
	// both games' persisted leaderboards (leaderboard feature)
	Leaderboards Leaderboards `json:"leaderboards"`
}
type svrWorkspaceList struct {
	Type       string               `json:"type"` // "workspaceList"
	Workspaces []WorkspaceListEntry `json:"workspaces"`
}
type svrWorkspaceCreated struct {
	Type string `json:"type"` // "workspaceCreated"
	Slug string `json:"slug"`
	Name string `json:"name"`
}
type svrCreateRejected struct {
	Type   string `json:"type"` // "createRejected"
	Reason string `json:"reason"`
}
type svrWorkspaceDeleted struct {
	Type string `json:"type"` // "workspaceDeleted"
	Slug string `json:"slug"`
}
type svrDeleteRejected struct {
	Type   string `json:"type"` // "deleteRejected"
	Reason string `json:"reason"`
}
type svrMemberList struct {
	Type    string        `json:"type"` // "memberList"
	Slug    string        `json:"slug"`
	Members []MemberEntry `json:"members"`
	Banned  []MemberEntry `json:"banned"`
	// pending invites (their target emails) + join requests (notes/015)
	Invites  []string      `json:"invites"`
	Requests []MemberEntry `json:"requests"`
}
type svrMemberRemoved struct {
	Type   string `json:"type"` // "memberRemoved"
	Slug   string `json:"slug"`
	UserID string `json:"userId"`
}
type svrMemberUnbanned struct {
	Type   string `json:"type"` // "memberUnbanned"
	Slug   string `json:"slug"`
	UserID string `json:"userId"`
}
type svrMemberRejected struct {
	Type   string `json:"type"` // "memberRejected"
	Reason string `json:"reason"`
}

// invite + join-request replies (notes/015): one ack per action and a shared
// rejection per family
type svrInviteSent struct {
	Type  string `json:"type"` // "inviteSent"
	Slug  string `json:"slug"`
	Email string `json:"email"`
}
type svrInviteCancelled struct {
	Type  string `json:"type"` // "inviteCancelled"
	Slug  string `json:"slug"`
	Email string `json:"email"`
}
type svrInviteAccepted struct {
	Type string `json:"type"` // "inviteAccepted"
	Slug string `json:"slug"`
}
type svrInviteDeclined struct {
	Type string `json:"type"` // "inviteDeclined"
	Slug string `json:"slug"`
}
type svrInviteRejected struct {
	Type   string `json:"type"` // "inviteRejected"
	Reason string `json:"reason"`
}
type svrRequestSent struct {
	Type string `json:"type"` // "requestSent"
	Slug string `json:"slug"`
	Name string `json:"name"`
}
type svrRequestCancelled struct {
	Type string `json:"type"` // "requestCancelled"
	Slug string `json:"slug"`
}
type svrRequestApproved struct {
	Type   string `json:"type"` // "requestApproved"
	Slug   string `json:"slug"`
	UserID string `json:"userId"`
}
type svrRequestDenied struct {
	Type   string `json:"type"` // "requestDenied"
	Slug   string `json:"slug"`
	UserID string `json:"userId"`
}
type svrRequestRejected struct {
	Type   string `json:"type"` // "requestRejected"
	Reason string `json:"reason"`
}

// the picker's pending lists (notes/015)
type svrPendingList struct {
	Type     string          `json:"type"` // "pendingList"
	Invites  []WorkspaceInfo `json:"invites"`
	Requests []WorkspaceInfo `json:"requests"`
}
type svrKicked struct {
	Type   string `json:"type"` // "kicked"
	Reason string `json:"reason"`
}
type svrPlayerJoined struct {
	Type   string  `json:"type"` // "playerJoined"
	Player *Player `json:"player"`
}
type svrPlayerLeft struct {
	Type string `json:"type"` // "playerLeft"
	ID   string `json:"id"`
}
type svrPos struct {
	Type string   `json:"type"` // "pos"
	ID   string   `json:"id"`
	X    float64  `json:"x"`
	Y    float64  `json:"y"`
	A    *float64 `json:"a,omitempty"`
}
type svrShip struct {
	Type string `json:"type"` // "ship"
	ID   string `json:"id"`
	Pad  *int   `json:"pad"`
}
type svrMediaState struct {
	Type  string `json:"type"` // "mediaState"
	ID    string `json:"id"`
	MicOn bool   `json:"micOn"`
	CamOn bool   `json:"camOn"`
}
type svrSpeaking struct {
	Type string `json:"type"` // "speaking"
	ID   string `json:"id"`
	On   bool   `json:"on"`
}
type svrScreenShare struct {
	Type string `json:"type"` // "screenShare"
	ID   string `json:"id"`
	On   bool   `json:"on"`
}
type svrCharacter struct {
	Type      string    `json:"type"` // "character"
	ID        string    `json:"id"`
	Character Character `json:"character"`
}
type svrStatus struct {
	Type   string `json:"type"` // "status"
	ID     string `json:"id"`
	Status string `json:"status"`
}
type svrRename struct {
	Type string `json:"type"` // "rename"
	ID   string `json:"id"`
	Name string `json:"name"`
}
type svrWave struct {
	Type string `json:"type"` // "wave"
	From string `json:"from"`
}
type svrChat struct {
	Type    string      `json:"type"` // "chat"
	Message ChatMessage `json:"message"`
}
type svrEmote struct {
	Type  string `json:"type"` // "emote"
	ID    string `json:"id"`
	Emote string `json:"emote"`
}
type svrPodClaimed struct {
	Type string   `json:"type"` // "podClaimed"
	Pod  PodClaim `json:"pod"`
}
type svrPodReleased struct {
	Type   string `json:"type"` // "podReleased"
	ZoneID string `json:"zoneId"`
}
type svrDecorRejected struct {
	Type   string `json:"type"` // "decorRejected"
	Reason string `json:"reason"`
}
type svrMapChanged struct {
	Type  string       `json:"type"` // "mapChanged"
	Map   *MapData     `json:"map"`
	Pods  []PodClaim   `json:"pods"`
	Items []PlacedItem `json:"items"`
}
type svrItemPlaced struct {
	Type string     `json:"type"` // "itemPlaced"
	Item PlacedItem `json:"item"`
}
type svrItemMoved struct {
	Type string  `json:"type"` // "itemMoved"
	ID   string  `json:"id"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}
type svrItemScaled struct {
	Type  string  `json:"type"` // "itemScaled"
	ID    string  `json:"id"`
	Scale float64 `json:"scale"`
}
type svrItemColored struct {
	Type  string  `json:"type"` // "itemColored"
	ID    string  `json:"id"`
	Color *string `json:"color"`
}
type svrItemRaised struct {
	Type  string  `json:"type"` // "itemRaised"
	ID    string  `json:"id"`
	Depth float64 `json:"depth"`
}
type svrItemDeleted struct {
	Type string `json:"type"` // "itemDeleted"
	ID   string `json:"id"`
}
type svrItemRejected struct {
	Type   string `json:"type"` // "itemRejected"
	Reason string `json:"reason"`
}
type svrMapRejected struct {
	Type   string `json:"type"` // "mapRejected"
	Reason string `json:"reason"`
}

// --- space link (workspace linking) ---

// the Space Link overlay's state: always the HOME workspace's Links; the
// management lists ride along only for home's creator (empty otherwise)
type svrSpaceLinkState struct {
	Type     string          `json:"type"` // "spaceLinkState"
	Home     WorkspaceInfo   `json:"home"`
	Creator  bool            `json:"creator"`
	Links    []WorkspaceInfo `json:"links"`
	Inbound  []WorkspaceInfo `json:"inbound"`
	Outbound []WorkspaceInfo `json:"outbound"`
	Blocks   []WorkspaceInfo `json:"blocks"`
}
type svrLinkRejected struct {
	Type   string `json:"type"` // "linkRejected"
	Reason string `json:"reason"`
}
type svrVisitRejected struct {
	Type   string `json:"type"` // "visitRejected"
	Reason string `json:"reason"`
}
type svrRaceLobby struct {
	Type    string       `json:"type"` // "raceLobby"
	Members []RaceMember `json:"members"`
}
type svrRaceStarted struct {
	Type   string      `json:"type"` // "raceStarted"
	Gates  []Point     `json:"gates"`
	Racers []RaceStart `json:"racers"`
}
type svrRaceProgress struct {
	Type string `json:"type"` // "raceProgress"
	ID   string `json:"id"`
	Gate int    `json:"gate"`
}
type svrRaceFinished struct {
	Type   string  `json:"type"` // "raceFinished"
	ID     string  `json:"id"`
	Place  int     `json:"place"`
	TimeMs float64 `json:"timeMs"`
}
type svrRaceLeft struct {
	Type string `json:"type"` // "raceLeft"
	ID   string `json:"id"`
}
type svrRaceEnded struct {
	Type    string       `json:"type"` // "raceEnded"
	Results []RaceResult `json:"results"`
}
type svrRaceRejected struct {
	Type   string `json:"type"` // "raceRejected"
	Reason string `json:"reason"`
}
type svrBlastLobby struct {
	Type    string       `json:"type"` // "blastLobby"
	Members []RaceMember `json:"members"`
}
type svrBlastStarted struct {
	Type    string      `json:"type"` // "blastStarted"
	Arena   BlastArena  `json:"arena"`
	Players []RaceStart `json:"players"`
}
type svrBlastFire struct {
	Type string  `json:"type"` // "blastFire"
	ID   string  `json:"id"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	A    float64 `json:"a"`
}
type svrBlastEliminated struct {
	Type string `json:"type"` // "blastEliminated"
	ID   string `json:"id"`
	By   string `json:"by"`
}
type svrBlastLeft struct {
	Type string `json:"type"` // "blastLeft"
	ID   string `json:"id"`
}
type svrBlastEnded struct {
	Type    string        `json:"type"` // "blastEnded"
	Results []BlastResult `json:"results"`
}
type svrBlastRejected struct {
	Type   string `json:"type"` // "blastRejected"
	Reason string `json:"reason"`
}
type svrLeaderboards struct {
	Type  string             `json:"type"` // "leaderboards"
	Race  []LeaderboardEntry `json:"race"`
	Blast []LeaderboardEntry `json:"blast"`
}
type svrDebriefEnded struct {
	Type string `json:"type"` // "debriefEnded"
	ID   string `json:"id"`
}
type svrZoneChanged struct {
	Type   string  `json:"type"` // "zoneChanged"
	ID     string  `json:"id"`
	ZoneID *string `json:"zoneId"`
}
type svrPeerConnect struct {
	Type      string `json:"type"` // "peerConnect"
	PeerID    string `json:"peerId"`
	Initiator bool   `json:"initiator"`
}
type svrPeerDisconnect struct {
	Type   string `json:"type"` // "peerDisconnect"
	PeerID string `json:"peerId"`
}
type svrSignal struct {
	Type string          `json:"type"` // "signal"
	From string          `json:"from"`
	Data json.RawMessage `json:"data"`
}
