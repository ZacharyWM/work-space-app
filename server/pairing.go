// pairing diff (port of server/src/pairing.ts + the audio-group rule from
// shared/src/peer.ts): which peer pairs form/break when one player's audio
// group changes. The group is a zone on foot, or the ship-wide FLIGHT group
// while piloting a shuttle — boarding/docking re-pairs like a move
package main

// flying a shuttle joins the one ship-wide flight group, so every pilot hears
// every other pilot regardless of shuttle. Racers get their own race group:
// everyone in a shuttle race hears the other racers, and no one else (shuttle
// race feature). The NUL prefix can never collide with a map zone id. Groups
// are plain strings here; "" means none (open space)
const flightGroup = "\x00flight"
const raceGroup = "\x00race"

// a blasters match gets its own group the same way (shuttle blasters feature)
const blastGroup = "\x00blast"

// the audio group a player currently occupies; "" = open space, no pairing
func audioGroupOf(p *Player) string {
	if p.Racing {
		return raceGroup
	}
	if p.Blasting {
		return blastGroup
	}
	if p.ShipPad != nil {
		return flightGroup
	}
	// a debrief (scoreboard up after finishing / falling) keeps the player in
	// the game's comms group until they close the board — flying overrides it
	if p.Debrief != nil && *p.Debrief == "race" {
		return raceGroup
	}
	if p.Debrief != nil && *p.Debrief == "blast" {
		return blastGroup
	}
	if p.ZoneID != nil {
		return *p.ZoneID
	}
	return ""
}

// every membership change moves exactly one player between groups, so every
// affected pair is (subject, other) — the diff only needs to name the other
// side of each pair
type pairingDiff struct {
	// peer ids the subject is newly co-grouped with
	connects []string
	// peer ids the subject is no longer co-grouped with
	disconnects []string
}

// diff the subject's pairs across an audio-group change; others is everyone
// else (their groups unchanged by this transition). "" group = no pairs
func diffPairs(previousGroup, newGroup string, others []*Player) pairingDiff {
	var d pairingDiff
	// no transition — nothing forms or breaks
	if previousGroup == newGroup {
		return d
	}
	for _, other := range others {
		// groups are disjoint, so an other matches at most one side of the diff
		group := audioGroupOf(other)
		if previousGroup != "" && group == previousGroup {
			d.disconnects = append(d.disconnects, other.ID)
		}
		if newGroup != "" && group == newGroup {
			d.connects = append(d.connects, other.ID)
		}
	}
	return d
}

// offer creator for a pair: lexicographically lower id — deterministic, both
// sides agree without coordination
func isInitiator(selfID, peerID string) bool { return selfID < peerID }
