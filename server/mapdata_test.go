// map parsing + geometry + edit-denial tests (port of the server-relevant
// slices of shared's map/geometry tests)
package main

import (
	"os"
	"strings"
	"testing"
)

func TestParseRepoMap(t *testing.T) {
	// the real default ship must parse and validate — main fails fast on it
	raw, err := os.ReadFile("../map.json")
	if err != nil {
		t.Fatalf("cannot read repo map: %v", err)
	}
	m, err := parseMapData(raw)
	if err != nil {
		t.Fatalf("repo map must parse: %v", err)
	}
	if err := validateZonesDisjoint(m); err != nil {
		t.Fatalf("repo map zones must be disjoint: %v", err)
	}
	if len(m.Floors) == 0 {
		t.Error("repo map must have floors")
	}
}

func TestParseMapDataValidation(t *testing.T) {
	reject := func(raw string) {
		t.Helper()
		if _, err := parseMapData([]byte(raw)); err == nil {
			t.Errorf("parse accepted %s", raw)
		}
	}
	reject(`{}`)
	reject(`{"floors":[],"zones":[],"decor":[],"spawn":{"x":0,"y":0}}`)                             // floors min 1
	reject(`{"floors":[{"x":0,"y":0,"w":0,"h":10,"r":0}],"zones":[],"decor":[],"spawn":{"x":0,"y":0}}`) // w not positive
	reject(`{"floors":[{"x":0,"y":0,"w":10,"h":10,"r":0}],"zones":[{"id":"","name":"A","rect":{"x":0,"y":0,"w":1,"h":1}}],"decor":[],"spawn":{"x":0,"y":0}}`)
	reject(`{"floors":[{"x":0,"y":0,"w":10,"h":10,"r":0}],"zones":[],"decor":[{"type":"crate","x":1,"y":1}],"spawn":{"x":0,"y":0}}`) // crate needs s
	reject(`{"floors":[{"x":0,"y":0,"w":10,"h":10,"r":0}],"zones":[],"decor":[{"type":"hologram","x":1,"y":1}],"spawn":{"x":0,"y":0}}`)
}

func TestParseMapDataLegacyPads(t *testing.T) {
	// pads absent + the legacy deck plate present: the legacy trio appears
	withDeck := `{"floors":[{"x":1380,"y":800,"w":400,"h":300,"r":0}],"zones":[],"decor":[],"spawn":{"x":1400,"y":820}}`
	m, err := parseMapData([]byte(withDeck))
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Pads) != 3 || m.Pads[0].X != 1465 || m.Pads[0].Y != 975 {
		t.Errorf("legacy pads wrong: %+v", m.Pads)
	}
	// pads absent, no legacy deck: empty pads
	noDeck := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"spawn":{"x":50,"y":50}}`
	m, _ = parseMapData([]byte(noDeck))
	if m.Pads == nil || len(m.Pads) != 0 {
		t.Errorf("padless map must get an empty (non-nil) pad list: %+v", m.Pads)
	}
	// explicit pads are kept verbatim, even empty
	explicit := `{"floors":[{"x":1380,"y":800,"w":400,"h":300,"r":0}],"zones":[],"decor":[],"pads":[],"spawn":{"x":1400,"y":820}}`
	m, _ = parseMapData([]byte(explicit))
	if len(m.Pads) != 0 {
		t.Errorf("explicit empty pads must not be backfilled: %+v", m.Pads)
	}
}

func TestParseMapDataGameTables(t *testing.T) {
	// absent gameTables default to an empty (non-nil) list
	old := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"spawn":{"x":50,"y":50}}`
	m, err := parseMapData([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	if m.GameTables == nil || len(m.GameTables) != 0 {
		t.Errorf("tableless map must get an empty (non-nil) table list: %+v", m.GameTables)
	}
	// explicit tables are kept verbatim
	withTable := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"gameTables":[{"x":50,"y":60}],"spawn":{"x":50,"y":50}}`
	m, _ = parseMapData([]byte(withTable))
	if len(m.GameTables) != 1 || m.GameTables[0].X != 50 || m.GameTables[0].Y != 60 {
		t.Errorf("game tables wrong: %+v", m.GameTables)
	}
	// a table saved before the game field existed hosts the original race;
	// explicit games are kept, unknown games are refused (shuttle blasters)
	if m.GameTables[0].Game != tableGameRace {
		t.Errorf("absent game must default to race: %+v", m.GameTables)
	}
	blastTable := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"gameTables":[{"x":50,"y":60,"game":"blast"}],"spawn":{"x":50,"y":50}}`
	m, _ = parseMapData([]byte(blastTable))
	if len(m.GameTables) != 1 || m.GameTables[0].Game != tableGameBlast {
		t.Errorf("explicit blast game wrong: %+v", m.GameTables)
	}
	badGame := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"gameTables":[{"x":50,"y":60,"game":"chess"}],"spawn":{"x":50,"y":50}}`
	if _, err := parseMapData([]byte(badGame)); err == nil {
		t.Error("an unknown game must be refused")
	}
	// the edit gate: tables must sit on a floor plate, capped like pads
	m.GameTables = []GameTable{{X: 500, Y: 500, Game: tableGameRace}}
	if denial := mapEditDenial(m); denial == "" {
		t.Error("an off-floor game table must be refused")
	}
	m.GameTables = make([]GameTable, maxGameTables+1)
	for i := range m.GameTables {
		m.GameTables[i] = GameTable{X: 50, Y: 50, Game: tableGameRace}
	}
	if denial := mapEditDenial(m); denial == "" {
		t.Error("too many game tables must be refused")
	}
}

func TestParseMapDataNpcs(t *testing.T) {
	// absent npcs default to an empty (non-nil) list (notes/014 robot pets)
	old := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"spawn":{"x":50,"y":50}}`
	m, err := parseMapData([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	if m.Npcs == nil || len(m.Npcs) != 0 {
		t.Errorf("npc-less map must get an empty (non-nil) npc list: %+v", m.Npcs)
	}
	// explicit npcs are kept verbatim, both kinds
	withNpcs := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"npcs":[{"x":10,"y":20,"kind":"dog"},{"x":30,"y":40,"kind":"bot"}],"spawn":{"x":50,"y":50}}`
	m, _ = parseMapData([]byte(withNpcs))
	if len(m.Npcs) != 2 || m.Npcs[0].Kind != npcKindDog || m.Npcs[1].Kind != npcKindBot {
		t.Errorf("npcs wrong: %+v", m.Npcs)
	}
	// unknown (and missing) kinds are refused
	badKind := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"npcs":[{"x":10,"y":20,"kind":"cat"}],"spawn":{"x":50,"y":50}}`
	if _, err := parseMapData([]byte(badKind)); err == nil {
		t.Error("an unknown npc kind must be refused")
	}
	noKind := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"npcs":[{"x":10,"y":20}],"spawn":{"x":50,"y":50}}`
	if _, err := parseMapData([]byte(noKind)); err == nil {
		t.Error("an npc without a kind must be refused")
	}
	// the edit gate: npcs must sit on a floor plate, capped like pads
	m.Npcs = []Npc{{X: 500, Y: 500, Kind: npcKindDog}}
	if denial := mapEditDenial(m); denial == "" {
		t.Error("an off-floor npc must be refused")
	}
	m.Npcs = make([]Npc, maxNpcs+1)
	for i := range m.Npcs {
		m.Npcs[i] = Npc{X: 50, Y: 50, Kind: npcKindBot}
	}
	if denial := mapEditDenial(m); denial == "" {
		t.Error("too many npcs must be refused")
	}
}

func TestZoneAtInclusiveEdges(t *testing.T) {
	// prototype semantics: edges are inclusive
	if z := zoneAt(zonedMap, 100, 100); z == nil || z.ID != "a" {
		t.Error("zone edges must be inclusive")
	}
	if zoneAt(zonedMap, 150, 50) != nil {
		t.Error("open space must be nil")
	}
	if z := zoneAt(zonedMap, 250, 50); z == nil || z.ID != "b" {
		t.Error("zone b must hit")
	}
}

func TestValidateZonesDisjoint(t *testing.T) {
	touching := &MapData{
		Floors: []Floor{{Rect: Rect{W: 1000, H: 1000}}},
		Zones: []Zone{
			{ID: "a", Name: "A", Rect: Rect{X: 0, Y: 0, W: 100, H: 100}},
			// shares an edge with a — inclusive zoneAt makes membership ambiguous
			{ID: "b", Name: "B", Rect: Rect{X: 100, Y: 0, W: 100, H: 100}},
		},
		Pads:  []Point{},
		Spawn: Point{X: 500, Y: 500},
	}
	if err := validateZonesDisjoint(touching); err == nil {
		t.Error("touching zones must be rejected")
	}
	if err := validateZonesDisjoint(zonedMap); err != nil {
		t.Errorf("disjoint zones must pass: %v", err)
	}
}

func TestMapEditDenial(t *testing.T) {
	base := func() *MapData {
		return &MapData{
			Floors: []Floor{{Rect: Rect{X: 0, Y: 0, W: 1000, H: 1000}}},
			Zones:  []Zone{{ID: "z1", Name: "Bridge", Rect: Rect{X: 0, Y: 0, W: 100, H: 100}}},
			Pads:   []Point{{X: 500, Y: 500}},
			Spawn:  Point{X: 500, Y: 500},
		}
	}
	if d := mapEditDenial(base()); d != "" {
		t.Errorf("valid map denied: %s", d)
	}
	m := base()
	m.Spawn = Point{X: 5000, Y: 5000} // off-floor
	if mapEditDenial(m) == "" {
		t.Error("spawn off the floor must be denied")
	}
	m = base()
	m.Zones = append(m.Zones, Zone{ID: "z1", Name: "Dup", Rect: Rect{X: 200, Y: 0, W: 50, H: 50}})
	if !strings.Contains(mapEditDenial(m), "duplicate zone id") {
		t.Error("duplicate zone ids must be denied")
	}
	m = base()
	m.Zones[0].Rect.X = -9000 // out of the coordinate box
	if mapEditDenial(m) == "" {
		t.Error("out-of-bounds zone must be denied")
	}
	m = base()
	m.Pads = append(m.Pads, Point{X: 5000, Y: 5000})
	if mapEditDenial(m) == "" {
		t.Error("a pad off the floor must be denied")
	}
	m = base()
	m.Zones[0].Name = "  "
	if mapEditDenial(m) == "" {
		t.Error("a blank zone name must be denied")
	}
}

// the deck is communal — every zone takes props — except a pod somebody else
// has claimed (notes/017). Mirrors shared/src/items.test.ts
func TestItemPlacementRules(t *testing.T) {
	m, err := parseMapData([]byte(`{
		"floors":[{"x":0,"y":0,"w":300,"h":100,"r":0}],
		"zones":[
			{"id":"podA","name":"POD A","pod":true,"rect":{"x":0,"y":0,"w":100,"h":100}},
			{"id":"lounge","name":"LOUNGE","rect":{"x":150,"y":0,"w":100,"h":100}}
		],
		"decor":[],"pads":[],"spawn":{"x":280,"y":50}}`))
	if err != nil {
		t.Fatalf("map parse failed: %v", err)
	}
	owners := podOwnersOf([]PodClaim{{ZoneID: "podA", UserID: "u1", Name: "Ripley"}})

	cases := []struct {
		name       string
		x, y       float64
		userID     string
		owners     map[string]string
		wantPlace  string
		wantRemove string
	}{
		{"open space is communal", 280, 50, "u2", owners, "", ""},
		{"plain zones take props", 200, 50, "u2", owners, "", ""},
		{"own pod", 50, 50, "u1", owners, "", ""},
		{"someone else's pod", 50, 50, "u2", owners, "notYourPod", "notYourPod"},
		{"unclaimed pod", 50, 50, "u2", map[string]string{}, "", ""},
		{"off the deck", 5, 500, "u1", owners, "offFloor", ""},
	}
	for _, c := range cases {
		if got := placementDenialAt(m, c.x, c.y, c.owners, c.userID); got != c.wantPlace {
			t.Errorf("%s: placement denial %q, want %q", c.name, got, c.wantPlace)
		}
		if got := removalDenialAt(m, c.x, c.y, c.owners, c.userID); got != c.wantRemove {
			t.Errorf("%s: removal denial %q, want %q", c.name, got, c.wantRemove)
		}
	}
}

func TestParseMapDataSpaceLink(t *testing.T) {
	// absent: the portal lands at the spawn, the one guaranteed-walkable point
	old := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"spawn":{"x":50,"y":50}}`
	m, err := parseMapData([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	if m.SpaceLink != (Point{X: 50, Y: 50}) {
		t.Errorf("space link must default to the spawn: %+v", m.SpaceLink)
	}
	// authored: kept verbatim
	authored := `{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"spaceLink":{"x":20,"y":30},"spawn":{"x":50,"y":50}}`
	m, _ = parseMapData([]byte(authored))
	if m.SpaceLink != (Point{X: 20, Y: 30}) {
		t.Errorf("authored space link must survive: %+v", m.SpaceLink)
	}
}

func TestMapEditDenialSpaceLink(t *testing.T) {
	m, err := parseMapData([]byte(
		`{"floors":[{"x":0,"y":0,"w":100,"h":100,"r":0}],"zones":[],"decor":[],"pads":[],"spaceLink":{"x":500,"y":500},"spawn":{"x":50,"y":50}}`))
	if err != nil {
		t.Fatal(err)
	}
	if denial := mapEditDenial(m); !strings.Contains(denial, "space link") {
		t.Errorf("off-floor space link must be denied, got %q", denial)
	}
	m.SpaceLink = Point{X: 50, Y: 50}
	if denial := mapEditDenial(m); denial != "" {
		t.Errorf("on-floor space link must pass, got %q", denial)
	}
}
