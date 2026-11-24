// pure per-peer-pair connection state machine (step 3.2): no WebRTC imports —
// the client peer manager (3.4) keys one phase per peer id, feeds events in,
// and performs the emitted effects against the real RTCPeerConnection

// audio grouping: two players are paired (hear each other) iff they share a
// non-null audio group. on foot the group is just the zone (null in open space
// = no pairing). flying a shuttle joins the one ship-wide FLIGHT group, so
// every pilot hears every other pilot regardless of which shuttle — flight
// comms. racers get their own RACE group: everyone in a shuttle race hears
// the other racers, and no one else (shuttle race feature). the sentinels
// start with a NUL so they can never collide with a map zone id.
export const FLIGHT_GROUP = "\u0000flight";
export const RACE_GROUP = "\u0000race";
// a blasters match gets its own group the same way (shuttle blasters feature)
export const BLAST_GROUP = "\u0000blast";

export function audioGroupOf(p: {
  shipPad?: number | null;
  racing?: boolean;
  blasting?: boolean;
  debrief?: "race" | "blast" | null;
  zoneId: string | null;
}): string | null {
  if (p.racing) return RACE_GROUP;
  if (p.blasting) return BLAST_GROUP;
  if (p.shipPad != null) return FLIGHT_GROUP;
  // a debrief (scoreboard up after finishing / falling) keeps the player in
  // the game's comms group until they close the board — flying overrides it
  if (p.debrief === "race") return RACE_GROUP;
  if (p.debrief === "blast") return BLAST_GROUP;
  return p.zoneId;
}

// lifecycle of one pair: disconnected → connecting → connected → disconnected
export type PeerPhase = "disconnected" | "connecting" | "connected";

// inputs: server directives (peerConnect/peerDisconnect), relayed signaling,
// and RTCPeerConnection observations reported by the impure layer
export type PeerEvent =
  // server said connect; initiator creates the offer (lexicographic rule, plan §3)
  | { type: "connectRequested"; initiator: boolean }
  // relayed SDP/ICE from the peer (opaque, protocol `signal.data`)
  | { type: "signalReceived"; data: unknown }
  // the RTCPeerConnection reached connected
  | { type: "iceConnected" }
  // server said tear down (zone exit, peer left) — or local exit/socket drop
  | { type: "disconnectRequested" }
  // the RTCPeerConnection failed or closed unexpectedly
  | { type: "failed" };

// outputs the impure layer must perform, in order
export type PeerEffect =
  // create the RTCPeerConnection, attach local tracks; initiator makes the offer
  | { type: "createConnection"; initiator: boolean }
  // apply relayed SDP/ICE to the existing connection
  | { type: "deliverSignal"; data: unknown }
  // close the RTCPeerConnection and drop its remote streams
  | { type: "closeConnection" };

export interface PeerTransition {
  phase: PeerPhase;
  effects: PeerEffect[];
}

// every pair starts (and ends) here
export const initialPeerPhase: PeerPhase = "disconnected";

// no state change, nothing to do
function stay(phase: PeerPhase): PeerTransition {
  return { phase, effects: [] };
}

// pure transition: current phase + event → next phase + effects.
// events that don't apply in the current phase are ignored (stale signals
// after teardown, duplicate directives) so replays and races are harmless.
export function transitionPeer(phase: PeerPhase, event: PeerEvent): PeerTransition {
  switch (event.type) {
    case "connectRequested":
      // duplicate connects while connecting/connected are idempotent
      if (phase !== "disconnected") return stay(phase);
      return {
        phase: "connecting",
        effects: [{ type: "createConnection", initiator: event.initiator }],
      };

    case "signalReceived":
      // deliver while connected too — ICE candidates trickle after connect;
      // drop while disconnected (stale signal after teardown)
      if (phase === "disconnected") return stay(phase);
      return { phase, effects: [{ type: "deliverSignal", data: event.data }] };

    case "iceConnected":
      // only meaningful mid-handshake; nothing for the impure layer to do
      if (phase !== "connecting") return stay(phase);
      return { phase: "connected", effects: [] };

    case "disconnectRequested":
    case "failed":
      // both end the pair; the manager still holds a connection to dispose.
      // no auto-retry on failure — reconnection is server-driven pairing (3.3)
      if (phase === "disconnected") return stay(phase);
      return { phase: "disconnected", effects: [{ type: "closeConnection" }] };
  }
}
