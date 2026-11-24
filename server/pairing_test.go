// unit tests for the pairing diff (port of pairing.test.ts)
package main

import (
	"reflect"
	"testing"
)

// shorthand for the roster shape the diff reads: an on-foot occupant
func occ(id, zoneID string) *Player {
	return &Player{ID: id, ZoneID: optStr(zoneID)}
}

// a flying occupant: shipPad set puts them in the ship-wide FLIGHT group
func pilotP(id string) *Player {
	pad := 0
	return &Player{ID: id, ShipPad: &pad}
}

// a debrief holder: on foot (post-game scoreboard up) with the comms hold set
func debriefP(id, game, zoneID string) *Player {
	g := game
	p := occ(id, zoneID)
	p.Debrief = &g
	return p
}

func expectDiff(t *testing.T, got pairingDiff, connects, disconnects []string) {
	t.Helper()
	if !reflect.DeepEqual(got.connects, connects) {
		t.Errorf("connects = %v, want %v", got.connects, connects)
	}
	if !reflect.DeepEqual(got.disconnects, disconnects) {
		t.Errorf("disconnects = %v, want %v", got.disconnects, disconnects)
	}
}

func TestDiffPairs(t *testing.T) {
	t.Run("entering a zone with two occupants connects both pairs", func(t *testing.T) {
		diff := diffPairs("", "med", []*Player{occ("p1", "med"), occ("p2", "med")})
		expectDiff(t, diff, []string{"p1", "p2"}, nil)
	})

	t.Run("leaving a zone to open space disconnects every co-occupant", func(t *testing.T) {
		diff := diffPairs("med", "", []*Player{occ("p1", "med"), occ("p2", "med")})
		expectDiff(t, diff, nil, []string{"p1", "p2"})
	})

	t.Run("switching zone to zone disconnects old and connects new", func(t *testing.T) {
		diff := diffPairs("med", "lounge", []*Player{
			occ("old1", "med"), occ("new1", "lounge"), occ("new2", "lounge"),
		})
		expectDiff(t, diff, []string{"new1", "new2"}, []string{"old1"})
	})

	t.Run("ignores players in other zones and in open space", func(t *testing.T) {
		diff := diffPairs("", "med", []*Player{occ("elsewhere", "lounge"), occ("drifting", "")})
		expectDiff(t, diff, nil, nil)
	})

	t.Run("no transition yields no pairs, even with co-occupants present", func(t *testing.T) {
		expectDiff(t, diffPairs("med", "med", []*Player{occ("p1", "med")}), nil, nil)
		expectDiff(t, diffPairs("", "", []*Player{occ("p1", "")}), nil, nil)
	})

	t.Run("open space is not a zone: null-zone others never pair on a null side", func(t *testing.T) {
		diff := diffPairs("", "med", []*Player{occ("drifting", "")})
		expectDiff(t, diff, nil, nil)
	})

	t.Run("a departure mid-zone disconnects the remaining occupants", func(t *testing.T) {
		diff := diffPairs("med", "", []*Player{occ("stayer", "med"), occ("other", "lounge")})
		expectDiff(t, diff, nil, []string{"stayer"})
	})

	t.Run("boarding a shuttle connects to every other pilot and no walker", func(t *testing.T) {
		diff := diffPairs("", flightGroup, []*Player{pilotP("a"), pilotP("b"), occ("walker", "med")})
		expectDiff(t, diff, []string{"a", "b"}, nil)
	})

	t.Run("docking into open space disconnects from every pilot", func(t *testing.T) {
		diff := diffPairs(flightGroup, "", []*Player{pilotP("a"), pilotP("b")})
		expectDiff(t, diff, nil, []string{"a", "b"})
	})

	t.Run("boarding from a zone leaves the zone for flight comms in one diff", func(t *testing.T) {
		diff := diffPairs("med", flightGroup, []*Player{occ("roomie", "med"), pilotP("a")})
		expectDiff(t, diff, []string{"a"}, []string{"roomie"})
	})

	t.Run("closing the scoreboard leaves race comms for the zone in one diff", func(t *testing.T) {
		racer := occ("racer", "")
		racer.Racing = true
		diff := diffPairs(raceGroup, "med", []*Player{
			racer, debriefP("holder", "race", "lounge"), occ("roomie", "med"),
		})
		expectDiff(t, diff, []string{"roomie"}, []string{"racer", "holder"})
	})
}

func TestAudioGroupDebrief(t *testing.T) {
	// a debrief pins the group to the game's comms channel wherever they stand
	if g := audioGroupOf(debriefP("p", "race", "med")); g != raceGroup {
		t.Errorf("race debrief in a zone = %q, want race group", g)
	}
	if g := audioGroupOf(debriefP("p", "blast", "")); g != blastGroup {
		t.Errorf("blast debrief in open space = %q, want blast group", g)
	}
	// an actual game supersedes a lingering hold
	racer := debriefP("p", "blast", "")
	racer.Racing = true
	if g := audioGroupOf(racer); g != raceGroup {
		t.Errorf("racing with a stale hold = %q, want race group", g)
	}
	// flying a pad shuttle overrides the hold too (flight comms while airborne)
	pilot := debriefP("p", "race", "")
	pad := 0
	pilot.ShipPad = &pad
	if g := audioGroupOf(pilot); g != flightGroup {
		t.Errorf("flying with a hold = %q, want flight group", g)
	}
}

func TestIsInitiator(t *testing.T) {
	// the lexicographically lower id initiates, and exactly one side does
	if !isInitiator("abc", "xyz") {
		t.Error("abc should initiate against xyz")
	}
	if isInitiator("xyz", "abc") {
		t.Error("xyz should not initiate against abc")
	}
}
