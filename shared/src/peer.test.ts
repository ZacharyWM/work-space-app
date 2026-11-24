// peer-pair state machine tests (step 3.2 verify)
import { describe, expect, it } from "vitest";
import {
  audioGroupOf,
  BLAST_GROUP,
  FLIGHT_GROUP,
  initialPeerPhase,
  RACE_GROUP,
  transitionPeer,
  type PeerEvent,
  type PeerPhase,
} from "./peer";

// run a sequence of events from disconnected, collecting every effect
function run(events: PeerEvent[]): { phase: PeerPhase; effects: unknown[] } {
  let phase: PeerPhase = initialPeerPhase;
  const effects: unknown[] = [];
  for (const event of events) {
    const t = transitionPeer(phase, event);
    phase = t.phase;
    effects.push(...t.effects);
  }
  return { phase, effects };
}

describe("transitionPeer", () => {
  it("runs the happy path: connect → signals → connected → teardown", () => {
    const { phase, effects } = run([
      { type: "connectRequested", initiator: true },
      { type: "signalReceived", data: { sdp: "answer" } },
      { type: "iceConnected" },
      // ICE candidates keep trickling after connect and must still deliver
      { type: "signalReceived", data: { candidate: "late" } },
      { type: "disconnectRequested" },
    ]);
    expect(phase).toBe("disconnected");
    expect(effects).toEqual([
      { type: "createConnection", initiator: true },
      { type: "deliverSignal", data: { sdp: "answer" } },
      { type: "deliverSignal", data: { candidate: "late" } },
      { type: "closeConnection" },
    ]);
  });

  it("passes the initiator flag through to createConnection", () => {
    const t = transitionPeer("disconnected", { type: "connectRequested", initiator: false });
    expect(t.phase).toBe("connecting");
    expect(t.effects).toEqual([{ type: "createConnection", initiator: false }]);
  });

  it("tears down mid-connecting", () => {
    const { phase, effects } = run([
      { type: "connectRequested", initiator: true },
      { type: "disconnectRequested" },
    ]);
    expect(phase).toBe("disconnected");
    expect(effects).toEqual([
      { type: "createConnection", initiator: true },
      { type: "closeConnection" },
    ]);
  });

  it("ignores duplicate connect requests while connecting and connected", () => {
    expect(transitionPeer("connecting", { type: "connectRequested", initiator: true })).toEqual({
      phase: "connecting",
      effects: [],
    });
    expect(transitionPeer("connected", { type: "connectRequested", initiator: false })).toEqual({
      phase: "connected",
      effects: [],
    });
  });

  it("returns to disconnected on failure, closing the connection", () => {
    for (const phase of ["connecting", "connected"] as const) {
      expect(transitionPeer(phase, { type: "failed" })).toEqual({
        phase: "disconnected",
        effects: [{ type: "closeConnection" }],
      });
    }
  });

  it("drops stale signals after teardown", () => {
    expect(transitionPeer("disconnected", { type: "signalReceived", data: { candidate: "x" } })).toEqual({
      phase: "disconnected",
      effects: [],
    });
  });

  it("treats disconnect and failure as no-ops when already disconnected", () => {
    expect(transitionPeer("disconnected", { type: "disconnectRequested" })).toEqual({
      phase: "disconnected",
      effects: [],
    });
    expect(transitionPeer("disconnected", { type: "failed" })).toEqual({
      phase: "disconnected",
      effects: [],
    });
  });

  it("ignores iceConnected outside connecting", () => {
    expect(transitionPeer("disconnected", { type: "iceConnected" })).toEqual({
      phase: "disconnected",
      effects: [],
    });
    expect(transitionPeer("connected", { type: "iceConnected" })).toEqual({
      phase: "connected",
      effects: [],
    });
  });

  it("allows the server to reconnect a pair after failure", () => {
    const { phase, effects } = run([
      { type: "connectRequested", initiator: true },
      { type: "failed" },
      { type: "connectRequested", initiator: true },
    ]);
    expect(phase).toBe("connecting");
    expect(effects).toEqual([
      { type: "createConnection", initiator: true },
      { type: "closeConnection" },
      { type: "createConnection", initiator: true },
    ]);
  });
});

describe("audioGroupOf", () => {
  it("pins a debrief holder to the game's comms group wherever they stand", () => {
    expect(audioGroupOf({ debrief: "race", zoneId: "med" })).toBe(RACE_GROUP);
    expect(audioGroupOf({ debrief: "blast", zoneId: null })).toBe(BLAST_GROUP);
  });

  it("lets an actual game or flight supersede a lingering hold", () => {
    expect(audioGroupOf({ racing: true, debrief: "blast", zoneId: null })).toBe(RACE_GROUP);
    expect(audioGroupOf({ blasting: true, debrief: "race", zoneId: null })).toBe(BLAST_GROUP);
    expect(audioGroupOf({ shipPad: 0, debrief: "race", zoneId: null })).toBe(FLIGHT_GROUP);
  });

  it("falls back to the zone (or open space) without a hold", () => {
    expect(audioGroupOf({ debrief: null, zoneId: "med" })).toBe("med");
    expect(audioGroupOf({ debrief: null, zoneId: null })).toBeNull();
  });
});
