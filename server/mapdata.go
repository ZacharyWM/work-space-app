// map data + pure geometry (port of shared/src/map.ts + the server-used slice
// of geometry.ts): parse/validate MapData, zone hit-testing, disjointness, and
// the owner-edit semantic checks. The client keeps the TS copy.
package main

import (
	"encoding/json"
	"fmt"
)

// axis-aligned rectangle; origin top-left, w/h extend right/down
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// a 2d point (spawn, positions, pads)
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// walkable floor plate; r is the corner radius (render-only, not collision)
type Floor struct {
	Rect
	R float64 `json:"r"`
}

// named zone whose rect drives membership and A/V pairing; pod marks the
// claimable personal zones. Pod is a pointer so absent-vs-false round-trips
// exactly as the TS optional did
type Zone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Rect Rect   `json:"rect"`
	Pod  *bool  `json:"pod,omitempty"`
}

// a game table (holotable): a point element plus the game it hosts — the
// original shuttle race or shuttle blasters. Tables saved before the field
// existed parse as race tables
type GameTable struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Game string  `json:"game"`
}

// the games a table may host (shared gameTableGameSchema)
const (
	tableGameRace  = "race"
	tableGameBlast = "blast"
)

// an NPC: a point element whose x/y anchors its client-side wander
// (notes/014 robot pets); the server only validates and relays it
type Npc struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Kind string  `json:"kind"`
}

// the bodies an NPC may wear (shared npcKindSchema)
const (
	npcKindDog = "dog"
	npcKindBot = "bot"
)

// the full layout. Decor items are validated on parse but kept raw — the
// server never reads their fields, only counts them and relays them
type MapData struct {
	Floors []Floor           `json:"floors"`
	Zones  []Zone            `json:"zones"`
	Decor  []json.RawMessage `json:"decor"`
	Pads   []Point           `json:"pads"`
	// holotables (game tables): stand at one to join its game's lobby
	GameTables []GameTable `json:"gameTables"`
	// wandering NPCs (notes/014 robot pets)
	Npcs []Npc `json:"npcs"`
	// the Space Link portal — every Map has exactly one, like the spawn point
	// (space link feature)
	SpaceLink Point `json:"spaceLink"`
	Spawn     Point `json:"spawn"`
}

// true when the zone is claimable (pod set and true)
func (z *Zone) isPod() bool { return z.Pod != nil && *z.Pod }

// the original hardcoded flight-deck pads: backfilled into maps saved before
// pads were part of the layout, but only while the legacy deck plate is still
// present to stand them on
var legacyDeck = Point{X: 1380, Y: 800}
var legacyPads = []Point{{X: 1465, Y: 975}, {X: 1585, Y: 975}, {X: 1705, Y: 975}}

// decode-time twin of MapData: pointer slices tell an absent key apart from an
// empty array (pads absent means the map predates pads and gets the legacy trio)
type mapDataWire struct {
	Floors     *[]Floor           `json:"floors"`
	Zones      *[]Zone            `json:"zones"`
	Decor      *[]json.RawMessage `json:"decor"`
	Pads       *[]Point           `json:"pads"`
	GameTables *[]GameTable       `json:"gameTables"`
	Npcs       *[]Npc             `json:"npcs"`
	SpaceLink  *Point             `json:"spaceLink"`
	Spawn      *Point             `json:"spawn"`
}

// decor item shapes: the type tag plus which fields each variant requires;
// values are checked for the same positivity rules the zod schema enforced
type decorWire struct {
	Type  *string  `json:"type"`
	X     *float64 `json:"x"`
	Y     *float64 `json:"y"`
	W     *float64 `json:"w"`
	H     *float64 `json:"h"`
	Count *float64 `json:"count"`
	Gap   *float64 `json:"gap"`
	S     *float64 `json:"s"`
	R     *float64 `json:"r"`
}

// one decor item against its variant's schema
func validateDecorItem(raw json.RawMessage) error {
	var d decorWire
	if err := json.Unmarshal(raw, &d); err != nil {
		return err
	}
	if d.Type == nil {
		return fmt.Errorf("decor item missing type")
	}
	// every variant sits on an x/y (rect variants included)
	if d.X == nil || d.Y == nil {
		return fmt.Errorf("decor %q missing position", *d.Type)
	}
	switch *d.Type {
	case "screen", "bed", "desk": // rect variants
		if d.W == nil || d.H == nil || *d.W <= 0 || *d.H <= 0 {
			return fmt.Errorf("decor %q needs positive w/h", *d.Type)
		}
	case "consoleStrip":
		if d.Count == nil || *d.Count <= 0 || *d.Count != float64(int(*d.Count)) {
			return fmt.Errorf("consoleStrip needs a positive integer count")
		}
		if d.Gap == nil || *d.Gap <= 0 {
			return fmt.Errorf("consoleStrip needs a positive gap")
		}
	case "crate":
		if d.S == nil || *d.S <= 0 {
			return fmt.Errorf("crate needs a positive s")
		}
	case "cross": // point only
	case "roundTable", "seat":
		if d.R == nil || *d.R <= 0 {
			return fmt.Errorf("decor %q needs a positive r", *d.Type)
		}
	default:
		return fmt.Errorf("unknown decor type %q", *d.Type)
	}
	return nil
}

// parse + validate unknown JSON into MapData (zod mapDataSchema equivalent,
// legacy-pads transform included); one readable error on the first issue
func parseMapData(raw []byte) (*MapData, error) {
	var w mapDataWire
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, fmt.Errorf("invalid map data: %w", err)
	}
	if w.Floors == nil || w.Zones == nil || w.Decor == nil || w.Spawn == nil {
		return nil, fmt.Errorf("invalid map data: floors, zones, decor, and spawn are required")
	}
	if len(*w.Floors) < 1 {
		return nil, fmt.Errorf("invalid map data: at least one floor plate is required")
	}
	for _, f := range *w.Floors {
		if f.W <= 0 || f.H <= 0 {
			return nil, fmt.Errorf("invalid map data: floor w/h must be positive")
		}
		if f.R < 0 {
			return nil, fmt.Errorf("invalid map data: floor corner radius must be nonnegative")
		}
	}
	for _, z := range *w.Zones {
		if z.ID == "" || z.Name == "" {
			return nil, fmt.Errorf("invalid map data: every zone needs an id and a name")
		}
		if z.Rect.W <= 0 || z.Rect.H <= 0 {
			return nil, fmt.Errorf("invalid map data: zone %q rect w/h must be positive", z.ID)
		}
	}
	for _, d := range *w.Decor {
		if err := validateDecorItem(d); err != nil {
			return nil, fmt.Errorf("invalid map data: %w", err)
		}
	}
	m := &MapData{Floors: *w.Floors, Zones: *w.Zones, Decor: *w.Decor, Spawn: *w.Spawn}
	// game tables absent means the map predates them: none. A table's absent
	// game defaults to the original race (shared gameTableSchema default)
	m.GameTables = []GameTable{}
	if w.GameTables != nil {
		m.GameTables = *w.GameTables
	}
	for i := range m.GameTables {
		switch m.GameTables[i].Game {
		case "":
			m.GameTables[i].Game = tableGameRace
		case tableGameRace, tableGameBlast:
		default:
			return nil, fmt.Errorf("invalid map data: unknown game table game %q", m.GameTables[i].Game)
		}
	}
	// NPCs absent means the map predates them: none (notes/014 robot pets)
	m.Npcs = []Npc{}
	if w.Npcs != nil {
		m.Npcs = *w.Npcs
	}
	for _, n := range m.Npcs {
		if n.Kind != npcKindDog && n.Kind != npcKindBot {
			return nil, fmt.Errorf("invalid map data: unknown npc kind %q", n.Kind)
		}
	}
	// the portal absent means the map predates it: it lands at the spawn, the
	// one point guaranteed walkable on every saved map (space link feature)
	if w.SpaceLink != nil {
		m.SpaceLink = *w.SpaceLink
	} else {
		m.SpaceLink = m.Spawn
	}
	if w.Pads != nil {
		m.Pads = *w.Pads
	} else {
		// pads absent: the legacy trio while the old deck plate survives, else none
		m.Pads = []Point{}
		for _, f := range m.Floors {
			if f.X == legacyDeck.X && f.Y == legacyDeck.Y {
				m.Pads = append([]Point{}, legacyPads...)
				break
			}
		}
	}
	return m, nil
}

// point-in-rect with inclusive edges (prototype semantics)
func inRect(x, y float64, r Rect) bool {
	return x >= r.X && x <= r.X+r.W && y >= r.Y && y <= r.Y+r.H
}

// true when the point lies on any floor plate
func inFloor(m *MapData, x, y float64) bool {
	for _, f := range m.Floors {
		if inRect(x, y, f.Rect) {
			return true
		}
	}
	return false
}

// first zone containing the point (edges inclusive); nil means open space
func zoneAt(m *MapData, x, y float64) *Zone {
	for i := range m.Zones {
		if inRect(x, y, m.Zones[i].Rect) {
			return &m.Zones[i]
		}
	}
	return nil
}

// --- decor placement rules (port of shared/src/items.ts) ---

// pod zone id -> owning account, the shape both rules below read
func podOwnersOf(pods []PodClaim) map[string]string {
	owners := make(map[string]string, len(pods))
	for _, p := range pods {
		owners[p.ZoneID] = p.UserID
	}
	return owners
}

// why placing a prop here is refused; "" = allowed. Props stand on the deck,
// anywhere on it — open space and every zone — except inside a pod somebody
// else has claimed
func placementDenialAt(m *MapData, x, y float64, owners map[string]string, userID string) string {
	if !inFloor(m, x, y) {
		return "offFloor"
	}
	return removalDenialAt(m, x, y, owners, userID)
}

// why removing (or dragging away) a prop here is refused; "" = allowed. Only a
// pod claimed by someone else protects its props — open space, other zones,
// and unclaimed pods are communal
func removalDenialAt(m *MapData, x, y float64, owners map[string]string, userID string) string {
	zone := zoneAt(m, x, y)
	if zone == nil || !zone.isPod() {
		return ""
	}
	if owner, ok := owners[zone.ID]; ok && owner != userID {
		return "notYourPod"
	}
	return ""
}

// closed rects intersecting: overlapping area OR a shared edge/corner
func rectsIntersect(a, b Rect) bool {
	return a.X <= b.X+b.W && b.X <= a.X+a.W && a.Y <= b.Y+b.H && b.Y <= a.Y+a.H
}

// first pair of zones that overlap or touch, nil when all are disjoint —
// zoneAt edges are inclusive, so even a shared edge makes membership ambiguous
func firstZoneOverlap(m *MapData) (*Zone, *Zone) {
	for i := 0; i < len(m.Zones); i++ {
		for j := i + 1; j < len(m.Zones); j++ {
			if rectsIntersect(m.Zones[i].Rect, m.Zones[j].Rect) {
				return &m.Zones[i], &m.Zones[j]
			}
		}
	}
	return nil, nil
}

// zones must not overlap or touch; an error names the offending pair
func validateZonesDisjoint(m *MapData) error {
	if a, b := firstZoneOverlap(m); a != nil {
		return fmt.Errorf("zones overlap: %q and %q", a.ID, b.ID)
	}
	return nil
}

// bounds for owner-edited maps: keeps a custom layout finite, renderable, and
// inside a sane coordinate box (shared MAP_LIMITS)
const (
	maxFloors     = 60
	maxZones      = 40
	maxDecor      = 200
	maxPads       = 12
	maxGameTables = 4
	maxNpcs       = 12
	mapCoordMin   = -8000.0
	mapCoordMax   = 8000.0
)

// true when the rect lies fully inside the coordinate box
func rectInBounds(r Rect) bool {
	return r.X >= mapCoordMin && r.Y >= mapCoordMin && r.X+r.W <= mapCoordMax && r.Y+r.H <= mapCoordMax
}

// why an edited map is refused, as a human-readable line; "" = acceptable.
// The client runs the same checks to disable SAVE on exactly what the server
// would reject; parse already ran — this checks semantics
func mapEditDenial(m *MapData) string {
	if len(m.Floors) > maxFloors {
		return fmt.Sprintf("too many floor plates (max %d)", maxFloors)
	}
	if len(m.Zones) > maxZones {
		return fmt.Sprintf("too many zones (max %d)", maxZones)
	}
	if len(m.Decor) > maxDecor {
		return fmt.Sprintf("too much decor (max %d)", maxDecor)
	}
	for _, f := range m.Floors {
		if !rectInBounds(f.Rect) {
			return "a floor plate is out of bounds"
		}
	}
	ids := map[string]bool{}
	for _, z := range m.Zones {
		if !rectInBounds(z.Rect) {
			return fmt.Sprintf("zone %q is out of bounds", z.Name)
		}
		if trimSpaceJS(z.Name) == "" {
			return "every zone needs a name"
		}
		if ids[z.ID] {
			return fmt.Sprintf("duplicate zone id %q", z.ID)
		}
		ids[z.ID] = true
	}
	if a, b := firstZoneOverlap(m); a != nil {
		return fmt.Sprintf("zones %q and %q overlap", a.Name, b.Name)
	}
	if !inFloor(m, m.Spawn.X, m.Spawn.Y) {
		return "the spawn point must sit on a floor plate"
	}
	// the portal has spawn-point semantics: movable, never deletable, always
	// reachable on foot (space link feature)
	if !inFloor(m, m.SpaceLink.X, m.SpaceLink.Y) {
		return "the space link must sit on a floor plate"
	}
	// pads must be reachable on foot; on-floor also implies in-bounds
	if len(m.Pads) > maxPads {
		return fmt.Sprintf("too many ship pads (max %d)", maxPads)
	}
	for _, p := range m.Pads {
		if !inFloor(m, p.X, p.Y) {
			return "every ship pad must sit on a floor plate"
		}
	}
	// holotables must be reachable on foot too (shuttle race feature)
	if len(m.GameTables) > maxGameTables {
		return fmt.Sprintf("too many game tables (max %d)", maxGameTables)
	}
	for _, p := range m.GameTables {
		if !inFloor(m, p.X, p.Y) {
			return "every game table must sit on a floor plate"
		}
	}
	// NPCs wander out from their anchor, so the anchor must be walkable
	// (notes/014 robot pets)
	if len(m.Npcs) > maxNpcs {
		return fmt.Sprintf("too many NPCs (max %d)", maxNpcs)
	}
	for _, n := range m.Npcs {
		if !inFloor(m, n.X, n.Y) {
			return "every NPC must sit on a floor plate"
		}
	}
	return ""
}
