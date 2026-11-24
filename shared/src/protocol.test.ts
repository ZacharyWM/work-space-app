// protocol tests: round-trip encode/decode, malformed messages rejected (step 1.3 verify)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHARACTER } from "./character";
import { parseMapData } from "./map";
import {
  type ClientMessage,
  type Player,
  type ServerMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
} from "./protocol";

// real map for the welcome payload
const map = parseMapData(
  JSON.parse(readFileSync(new URL("../../map.json", import.meta.url), "utf8")),
);

// ICE servers as the server mints them: STUN always, TURN when configured (step 5.4)
const iceServers = [
  { urls: ["stun:stun.l.google.com:19302"] },
  {
    urls: ["turn:turn.example.com:3478?transport=udp"],
    username: "1750000000:blip-a",
    credential: "base64hmac=",
  },
];

// a valid player for roster/joined payloads
const player: Player = {
  id: "p1",
  userId: "user_2ab",
  name: "Ripley",
  hue: 137.5,
  x: 330,
  y: 800,
  zoneId: null,
  micOn: true,
  camOn: false,
  speaking: false,
  screenOn: false,
  status: "available",
  character: DEFAULT_CHARACTER,
  shipPad: null,
  racing: false,
  blasting: false,
  debrief: null,
  visitingFrom: null,
};

// an idle race snapshot for the welcome (shuttle race feature)
const race = { racing: false, members: [], gates: [] };

// an idle blasters snapshot for the welcome (shuttle blasters feature)
const blast = { playing: false, members: [], arena: null };

describe("client messages", () => {
  const messages: ClientMessage[] = [
    // identity rides the clerk session token now (notes/005); joins name a
    // workspace by slug (notes/006)
    { type: "join", token: "sess-jwt", workspace: "alpha", micOn: true, camOn: false },
    { type: "resume", token: "tok-1", workspace: "deck-42", micOn: true, camOn: false },
    // a resume that dropped mid-Visit names the room holding the parked
    // session too (space link feature, ADR 0004)
    { type: "resume", token: "tok-1", workspace: "deck-42", visited: "alpha", micOn: true, camOn: false },
    // pre-join workspace picker round-trips (notes/006, notes/007)
    { type: "listWorkspaces", token: "sess-jwt" },
    { type: "createWorkspace", token: "sess-jwt", name: "Deep Space Crew" },
    { type: "deleteWorkspace", token: "sess-jwt", slug: "deck-42" },
    // pre-join member management, creator-only (notes/008)
    { type: "listMembers", token: "sess-jwt", slug: "deck-42" },
    { type: "removeMember", token: "sess-jwt", slug: "deck-42", userId: "user_2ab" },
    { type: "unbanMember", token: "sess-jwt", slug: "deck-42", userId: "user_2ab" },
    // invites + join requests (notes/015)
    { type: "invite", token: "sess-jwt", slug: "deck-42", email: "kane@nostromo.io" },
    { type: "cancelInvite", token: "sess-jwt", slug: "deck-42", email: "kane@nostromo.io" },
    { type: "listPending", token: "sess-jwt" },
    { type: "acceptInvite", token: "sess-jwt", slug: "deck-42" },
    { type: "declineInvite", token: "sess-jwt", slug: "deck-42" },
    { type: "requestJoin", token: "sess-jwt", name: "Deep Space Crew" },
    { type: "cancelRequest", token: "sess-jwt", slug: "deck-42" },
    { type: "approveRequest", token: "sess-jwt", slug: "deck-42", userId: "user_2ab" },
    { type: "denyRequest", token: "sess-jwt", slug: "deck-42", userId: "user_2ab" },
    { type: "pos", x: 12.5, y: -3 },
    // heading rides in-flight pos updates (notes/003)
    { type: "pos", x: 12.5, y: -3, a: -1.57 },
    { type: "ship", pad: 1 },
    { type: "ship", pad: null },
    { type: "mediaState", micOn: false, camOn: true },
    { type: "speaking", on: true },
    // screen share toggles (notes/003)
    { type: "screenShare", on: true },
    { type: "screenShare", on: false },
    { type: "character", character: { ...DEFAULT_CHARACTER, hat: "cap", helmet: true } },
    // presence status + targeted wave (notes/004)
    { type: "status", status: "busy" },
    { type: "wave", to: "p2" },
    // display name edit (notes/005)
    { type: "rename", name: "Ripley" },
    // chat to the zone, the ship, or all hands (notes/010)
    { type: "chat", scope: "zone", text: "anyone near the med bay?" },
    { type: "chat", scope: "ship", text: "standup on the bridge in 5" },
    { type: "chat", scope: "announce", text: "abandon ship drill at noon" },
    // emote flash (notes/010)
    { type: "emote", emote: "thumbsUp" },
    { type: "emote", emote: "question" },
    // pod claims (notes/009)
    { type: "claimPod", zoneId: "opsA" },
    { type: "releasePod" },
    // decor: place / drag / resize / clear a prop, anyone aboard (notes/017)
    { type: "placeItem", kind: "plant", x: 900, y: 620, scale: 1, color: null },
    { type: "placeItem", kind: "arcade", x: -40, y: 12.5, scale: 2.5, color: "#c0553f" },
    { type: "moveItem", id: "it_1", x: 940, y: 640 },
    { type: "scaleItem", id: "it_1", scale: 0.5 },
    // recolor a prop, or put it back to the color its art was drawn in
    { type: "colorItem", id: "it_1", color: "#3d6b8e" },
    { type: "colorItem", id: "it_1", color: null },
    // restack a prop against the ones it overlaps (notes/017)
    { type: "raiseItem", id: "it_1", depth: 20 },
    { type: "raiseItem", id: "it_1", depth: -80 },
    { type: "deleteItem", id: "it_1" },
    // owner map edit carries the full replacement layout (notes/010 map editor)
    { type: "editMap", map },
    // shuttle race lobby + progress (shuttle race feature)
    { type: "raceJoin" },
    { type: "raceLeave" },
    { type: "raceReady", on: true },
    { type: "raceReady", on: false },
    { type: "raceStart" },
    { type: "raceProgress", gate: 3 },
    // shuttle blasters lobby + combat (shuttle blasters feature)
    { type: "blastJoin" },
    { type: "blastLeave" },
    { type: "blastReady", on: true },
    { type: "blastStart" },
    { type: "blastFire", x: 900, y: -200, a: 1.2 },
    { type: "blastHit", target: "p2" },
    // post-game scoreboard close releases the debrief comms hold
    { type: "boardClose", game: "race" },
    { type: "boardClose", game: "blast" },
    // space link: overlay state, link management, and portal traversal
    { type: "spaceLink" },
    { type: "linkRequest", name: "Deep Space Crew" },
    { type: "linkCancel", slug: "deck-42" },
    { type: "linkAccept", slug: "deck-42" },
    { type: "linkDeny", slug: "deck-42" },
    { type: "linkRemove", slug: "deck-42" },
    { type: "linkBlock", name: "Deck 42" },
    { type: "linkUnblock", slug: "deck-42" },
    { type: "visit", slug: "deck-42" },
    { type: "signal", to: "p2", data: { sdp: "v=0", kind: "offer" } },
  ];

  it.each(messages)("round-trips $type", (msg) => {
    expect(decodeClientMessage(encodeMessage(msg))).toEqual(msg);
  });

  it("rejects non-JSON input", () => {
    expect(() => decodeClientMessage("not json")).toThrow(
      /invalid client message/,
    );
  });

  it("rejects an unknown message type", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "warp" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects a join with a missing token (notes/005)", () => {
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "join", workspace: "alpha", micOn: true, camOn: true }),
      ),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "join", token: "", workspace: "alpha", micOn: true, camOn: true }),
      ),
    ).toThrow(/invalid client message/);
  });

  it("rejects a join without a workspace or with a malformed slug (notes/006)", () => {
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "join", token: "t", micOn: true, camOn: true }),
      ),
    ).toThrow(/invalid client message/);
    for (const workspace of ["", "Alpha", "a--b", "-a", "a-", "a_b", "a".repeat(33)]) {
      expect(() =>
        decodeClientMessage(
          JSON.stringify({ type: "join", token: "t", workspace, micOn: true, camOn: true }),
        ),
      ).toThrow(/invalid client message/);
    }
  });

  it("rejects a createWorkspace with a blank or oversized name, trims padding (notes/006)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "createWorkspace", token: "t", name: "   " })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "createWorkspace", token: "t", name: "x".repeat(41) }),
      ),
    ).toThrow(/invalid client message/);
    expect(
      decodeClientMessage(
        JSON.stringify({ type: "createWorkspace", token: "t", name: " Alpha " }),
      ),
    ).toEqual({ type: "createWorkspace", token: "t", name: "Alpha" });
  });

  it("rejects a listWorkspaces without a token (notes/006)", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "listWorkspaces" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects an out-of-palette character (notes/002)", () => {
    expect(() =>
      decodeClientMessage(
        JSON.stringify({
          type: "character",
          character: { ...DEFAULT_CHARACTER, shirt: "#000000" },
        }),
      ),
    ).toThrow(/invalid client message/);
  });

  it("rejects a blank or oversized rename, trims padding (notes/005)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "rename", name: "   " })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "rename", name: "x".repeat(33) })),
    ).toThrow(/invalid client message/);
    expect(decodeClientMessage(JSON.stringify({ type: "rename", name: " Ripley " }))).toEqual({
      type: "rename",
      name: "Ripley",
    });
  });

  it("rejects a resume with a missing token", () => {
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "resume", micOn: true, camOn: true }),
      ),
    ).toThrow(/invalid client message/);
  });

  it("rejects a pos with a non-numeric coordinate", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "pos", x: "10", y: 0 })),
    ).toThrow(/invalid client message/);
  });

  it("rejects a ship with a negative or fractional pad (notes/003)", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "ship", pad: -1 }))).toThrow(
      /invalid client message/,
    );
    expect(() => decodeClientMessage(JSON.stringify({ type: "ship", pad: 0.5 }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects a status outside the enum (notes/004)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "status", status: "afk" })),
    ).toThrow(/invalid client message/);
  });

  it("rejects a wave without a target (notes/004)", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "wave" }))).toThrow(
      /invalid client message/,
    );
    expect(() => decodeClientMessage(JSON.stringify({ type: "wave", to: "" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects a server-only message type", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "playerLeft", id: "p1" })),
    ).toThrow(/invalid client message/);
  });

  it("rejects a claimPod without a zone (notes/009)", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "claimPod" }))).toThrow(
      /invalid client message/,
    );
    expect(() => decodeClientMessage(JSON.stringify({ type: "claimPod", zoneId: "" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects a raceProgress with a zero, negative, or fractional gate (shuttle race)", () => {
    for (const gate of [0, -1, 1.5, "2", undefined]) {
      expect(() =>
        decodeClientMessage(JSON.stringify({ type: "raceProgress", gate })),
      ).toThrow(/invalid client message/);
    }
  });

  it("rejects a blastFire with a missing coordinate or heading (shuttle blasters)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "blastFire", x: 1, y: 2 })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "blastFire", x: 1, a: 0 })),
    ).toThrow(/invalid client message/);
  });

  it("rejects a blastHit without a target (shuttle blasters)", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "blastHit" }))).toThrow(
      /invalid client message/,
    );
    expect(() => decodeClientMessage(JSON.stringify({ type: "blastHit", target: "" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects a chat with a blank or oversized text, trims padding (notes/010)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "chat", scope: "ship", text: "   " })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "chat", scope: "ship", text: "x".repeat(501) })),
    ).toThrow(/invalid client message/);
    expect(
      decodeClientMessage(JSON.stringify({ type: "chat", scope: "zone", text: " hi " })),
    ).toEqual({ type: "chat", scope: "zone", text: "hi" });
  });

  it("rejects a chat with an unknown scope (notes/010)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "chat", scope: "galaxy", text: "hi" })),
    ).toThrow(/invalid client message/);
  });

  it("rejects an emote outside the palette (notes/010)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "emote", emote: "🎉" })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "emote", emote: "salute" })),
    ).toThrow(/invalid client message/);
  });

  it("rejects a removeMember without a target user (notes/008)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "removeMember", token: "t", slug: "alpha" })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "removeMember", token: "t", slug: "alpha", userId: "" }),
      ),
    ).toThrow(/invalid client message/);
  });

  it("trims and lowercases an invite email (notes/015, ADR 0003)", () => {
    const decoded = decodeClientMessage(
      JSON.stringify({ type: "invite", token: "t", slug: "alpha", email: "  Kane@Nostromo.IO " }),
    );
    expect(decoded).toEqual({ type: "invite", token: "t", slug: "alpha", email: "kane@nostromo.io" });
  });

  it("rejects an invite with a shapeless email (notes/015)", () => {
    for (const email of ["", "kane", "kane@", "@nostromo.io", "kane @nostromo.io"]) {
      expect(() =>
        decodeClientMessage(JSON.stringify({ type: "invite", token: "t", slug: "alpha", email })),
      ).toThrow(/invalid client message/);
    }
  });

  it("rejects a requestJoin with a blank or oversized name (notes/015)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "requestJoin", token: "t", name: "   " })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "requestJoin", token: "t", name: "x".repeat(41) }),
      ),
    ).toThrow(/invalid client message/);
  });
});

describe("server messages", () => {
  // the workspace the welcome names (notes/006)
  const workspace = { slug: "alpha", name: "Alpha" };
  // a pod claim as the welcome carries it (notes/009)
  const pod = { zoneId: "opsA", userId: "user_1", name: "Ripley" };
  // one placed prop, as the welcome and the item broadcasts carry it (notes/017)
  const item = {
    id: "it_1",
    kind: "plant" as const,
    x: 900,
    y: 620,
    scale: 1.4,
    depth: 20,
    color: "#3d6b8e",
  };
  // a chat message as the log and the welcome history carry it (notes/010)
  const chatMsg = {
    id: "c1",
    from: "p1",
    name: "Ripley",
    scope: "ship",
    zoneId: null,
    text: "standup on the bridge in 5",
    ts: 1751000000000,
  } as const;

  const messages: ServerMessage[] = [
    { type: "joinRejected", reason: "unauthorized" },
    { type: "joinRejected", reason: "resumeExpired" },
    // join to a slug no workspace owns (notes/006)
    { type: "joinRejected", reason: "workspaceNotFound" },
    // removed (banned) account, or no member slot left (notes/008)
    { type: "joinRejected", reason: "removed" },
    { type: "joinRejected", reason: "workspaceFull" },
    // pods ride the welcome (notes/009)
    {
      type: "welcome",
      selfId: "p1",
      workspace,
      home: workspace,
      owner: true,
      map,
      roster: [player],
      resumeToken: "tok-1",
      iceServers,
      pods: [pod],
      items: [item],
      chat: [chatMsg],
      race,
      blast,
      leaderboards: { race: [], blast: [] },
    },
    // a welcome mid-race carries the lobby-turned-racer list and the gates;
    // one mid-match carries the blasters arena the same way
    {
      type: "welcome",
      selfId: "p1",
      workspace,
      home: workspace,
      owner: false,
      map,
      roster: [player],
      resumeToken: "tok-1",
      iceServers,
      pods: [],
      items: [],
      chat: [],
      race: {
        racing: true,
        members: [{ id: "p1", name: "Ripley", ready: true }],
        gates: [
          { x: 900, y: -400 },
          { x: 2000, y: 600 },
        ],
      },
      blast: {
        playing: true,
        members: [{ id: "p1", name: "Ripley", ready: true }],
        arena: { x: 1100, y: 650, r: 1400 },
      },
      // best scores ride the welcome too (leaderboard feature)
      leaderboards: {
        race: [{ userId: "user_1", name: "Ripley", score: 61500 }],
        blast: [{ userId: "user_1", name: "Ripley", score: 3 }],
      },
    },
    // pre-join picker replies; list entries carry the creator flag (notes/006, notes/007)
    {
      type: "workspaceList",
      workspaces: [
        { ...workspace, mine: true },
        { slug: "deck-42", name: "Deck 42", mine: false },
      ],
    },
    { type: "workspaceList", workspaces: [] },
    { type: "workspaceCreated", slug: "alpha", name: "Alpha" },
    { type: "createRejected", reason: "slugTaken" },
    { type: "createRejected", reason: "invalidName" },
    { type: "createRejected", reason: "unauthorized" },
    // the per-account creation cap (notes/007)
    { type: "createRejected", reason: "limitReached" },
    // delete replies + established-session evictions (notes/007)
    { type: "workspaceDeleted", slug: "alpha" },
    { type: "deleteRejected", reason: "unauthorized" },
    { type: "deleteRejected", reason: "notFound" },
    { type: "deleteRejected", reason: "notCreator" },
    { type: "kicked", reason: "boardedElsewhere" },
    { type: "kicked", reason: "workspaceDeleted" },
    { type: "kicked", reason: "removed" },
    // a Visit died under this session (space link feature)
    { type: "kicked", reason: "visitEnded" },
    // member management replies (notes/008)
    {
      type: "memberList",
      slug: "alpha",
      members: [
        // email optional: present, absent, and empty-string forms all decode
        { id: "user_1", name: "Ripley", email: "ripley@weyland.com", creator: true },
        { id: "user_2", name: "Dallas", creator: false },
      ],
      banned: [{ id: "user_3", name: "Ash", email: "ash@weyland.com", creator: false }],
      // pending invites + join requests ride the same panel reply (notes/015)
      invites: ["lambert@nostromo.io"],
      requests: [{ id: "user_4", name: "Kane", email: "kane@nostromo.io", creator: false }],
    },
    { type: "memberList", slug: "alpha", members: [], banned: [], invites: [], requests: [] },
    { type: "memberRemoved", slug: "alpha", userId: "user_2" },
    { type: "memberUnbanned", slug: "alpha", userId: "user_3" },
    { type: "memberRejected", reason: "unauthorized" },
    { type: "memberRejected", reason: "notFound" },
    { type: "memberRejected", reason: "notCreator" },
    { type: "memberRejected", reason: "isCreator" },
    // invite + join-request replies (notes/015)
    { type: "inviteSent", slug: "alpha", email: "kane@nostromo.io" },
    { type: "inviteCancelled", slug: "alpha", email: "kane@nostromo.io" },
    { type: "inviteAccepted", slug: "alpha" },
    { type: "inviteDeclined", slug: "alpha" },
    { type: "inviteRejected", reason: "alreadyMember" },
    { type: "inviteRejected", reason: "full" },
    { type: "requestSent", slug: "alpha", name: "Alpha" },
    { type: "requestCancelled", slug: "alpha" },
    { type: "requestApproved", slug: "alpha", userId: "user_4" },
    { type: "requestDenied", slug: "alpha", userId: "user_4" },
    { type: "requestRejected", reason: "removed" },
    { type: "requestRejected", reason: "notFound" },
    {
      type: "pendingList",
      invites: [{ slug: "alpha", name: "Alpha" }],
      requests: [{ slug: "deck-42", name: "Deck 42" }],
    },
    { type: "pendingList", invites: [], requests: [] },
    { type: "joinRejected", reason: "notMember" },
    { type: "playerJoined", player },
    { type: "playerLeft", id: "p1" },
    { type: "pos", id: "p1", x: 100, y: 200 },
    { type: "pos", id: "p1", x: 100, y: 200, a: 3.14 },
    { type: "ship", id: "p1", pad: 0 },
    { type: "ship", id: "p1", pad: null },
    { type: "mediaState", id: "p1", micOn: true, camOn: true },
    { type: "speaking", id: "p1", on: false },
    // screen share relayed to the room (notes/003)
    { type: "screenShare", id: "p1", on: true },
    { type: "character", id: "p1", character: { ...DEFAULT_CHARACTER, hair: "none" } },
    // presence status relayed to the room, wave to the target only (notes/004)
    { type: "status", id: "p1", status: "away" },
    { type: "wave", from: "p1" },
    // display name change relayed to the room (notes/005)
    { type: "rename", id: "p1", name: "Ellen" },
    // chat delivered to its scope's audience (notes/010)
    { type: "chat", message: chatMsg },
    { type: "chat", message: { ...chatMsg, scope: "zone", zoneId: "bridge" } },
    { type: "chat", message: { ...chatMsg, scope: "announce" } },
    // emote relayed to the room (notes/010)
    { type: "emote", id: "p1", emote: "party" },
    { type: "zoneChanged", id: "p1", zoneId: "bridge" },
    { type: "zoneChanged", id: "p1", zoneId: null },
    // pod broadcasts and the claim rejection (notes/009)
    { type: "podClaimed", pod },
    { type: "podReleased", zoneId: "opsA" },
    { type: "itemPlaced", item },
    { type: "itemMoved", id: "it_1", x: 940, y: 640 },
    { type: "itemScaled", id: "it_1", scale: 2.5 },
    { type: "itemColored", id: "it_1", color: "#9a6a38" },
    { type: "itemColored", id: "it_1", color: null },
    { type: "itemRaised", id: "it_1", depth: -20 },
    { type: "itemDeleted", id: "it_1" },
    { type: "itemRejected", reason: "offFloor" },
    { type: "itemRejected", reason: "notYourPod" },
    { type: "itemRejected", reason: "full" },
    { type: "itemRejected", reason: "gone" },
    { type: "decorRejected", reason: "podTaken" },
    { type: "decorRejected", reason: "haveClaim" },
    { type: "decorRejected", reason: "noClaim" },
    // owner map edit broadcast + its rejection (notes/010 map editor)
    { type: "mapChanged", map, pods: [pod], items: [item] },
    { type: "mapChanged", map, pods: [], items: [] },
    { type: "mapRejected", reason: "notCreator" },
    { type: "mapRejected", reason: "invalidMap" },
    // space link: the overlay's state (management lists ride only for the
    // creator), a badged visitor on the roster, and the typed refusals
    {
      type: "spaceLinkState",
      home: workspace,
      creator: true,
      links: [{ slug: "deck-42", name: "Deck 42" }],
      inbound: [{ slug: "nostromo", name: "Nostromo" }],
      outbound: [],
      blocks: [{ slug: "sulaco", name: "Sulaco" }],
    },
    {
      type: "spaceLinkState",
      home: workspace,
      creator: false,
      links: [],
      inbound: [],
      outbound: [],
      blocks: [],
    },
    { type: "playerJoined", player: { ...player, visitingFrom: "Deck 42" } },
    { type: "linkRejected", reason: "alreadyLinked" },
    { type: "linkRejected", reason: "blocked" },
    { type: "linkRejected", reason: "linkLimit" },
    { type: "visitRejected", reason: "notLinked" },
    { type: "visitRejected", reason: "full" },
    // shuttle race broadcasts (shuttle race feature)
    { type: "raceLobby", members: [{ id: "p1", name: "Ripley", ready: false }] },
    { type: "raceLobby", members: [] },
    {
      type: "raceStarted",
      gates: [
        { x: 900, y: -400 },
        { x: 2000, y: 600 },
      ],
      racers: [{ id: "p1", x: 300, y: -380, a: 0.5 }],
    },
    { type: "raceProgress", id: "p1", gate: 2 },
    { type: "raceFinished", id: "p1", place: 1, timeMs: 84200 },
    { type: "raceLeft", id: "p1" },
    {
      type: "raceEnded",
      results: [
        { id: "p1", name: "Ripley", timeMs: 84200 },
        { id: "p2", name: "Dallas", timeMs: null },
      ],
    },
    { type: "raceRejected", reason: "notNearTable" },
    { type: "raceRejected", reason: "raceInProgress" },
    { type: "raceRejected", reason: "lobbyFull" },
    { type: "raceRejected", reason: "flying" },
    { type: "raceRejected", reason: "notInLobby" },
    { type: "raceRejected", reason: "notAllReady" },
    // shuttle blasters broadcasts (shuttle blasters feature)
    { type: "blastLobby", members: [{ id: "p1", name: "Ripley", ready: false }] },
    { type: "blastLobby", members: [] },
    {
      type: "blastStarted",
      arena: { x: 1100, y: 650, r: 1400 },
      players: [
        { id: "p1", x: 1100, y: -120, a: 1.57 },
        { id: "p2", x: 1100, y: 1420, a: -1.57 },
      ],
    },
    { type: "blastFire", id: "p1", x: 900, y: -200, a: 1.2 },
    { type: "blastEliminated", id: "p2", by: "p1" },
    { type: "blastLeft", id: "p2" },
    {
      type: "blastEnded",
      results: [
        { id: "p1", name: "Ripley", survived: true },
        { id: "p2", name: "Dallas", survived: false },
      ],
    },
    { type: "blastRejected", reason: "notNearTable" },
    { type: "blastRejected", reason: "matchInProgress" },
    { type: "blastRejected", reason: "needTwo" },
    // fresh best scores after a race/match ended (leaderboard feature)
    {
      type: "leaderboards",
      race: [
        { userId: "user_1", name: "Ripley", score: 61500 },
        { userId: "user_2", name: "Dallas", score: 72800 },
      ],
      blast: [{ userId: "user_2", name: "Dallas", score: 4 }],
    },
    // a post-game debrief comms hold released (board closed / next match started)
    { type: "debriefEnded", id: "p1" },
    { type: "peerConnect", peerId: "p2", initiator: true },
    { type: "peerDisconnect", peerId: "p2" },
    { type: "signal", from: "p2", data: { candidate: "candidate:1" } },
  ];

  it.each(messages)("round-trips $type", (msg) => {
    expect(decodeServerMessage(encodeMessage(msg))).toEqual(msg);
  });

  it("rejects a welcome with an invalid roster entry", () => {
    const bad = { ...player, hue: "red" };
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          workspace,
          owner: false,
          map,
          roster: [bad],
          resumeToken: "tok-1",
          iceServers,
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a welcome without the owner flag (notes/010 map editor)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          workspace,
          map,
          roster: [player],
          resumeToken: "tok-1",
          iceServers,
          pods: [],
          chat: [],
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects an editMap whose map fails the schema (notes/010 map editor)", () => {
    expect(() =>
      decodeClientMessage(
        JSON.stringify({ type: "editMap", map: { ...map, floors: [] } }),
      ),
    ).toThrow(/invalid client message/);
  });

  it("rejects a welcome without a resume token (step 5.2)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({ type: "welcome", selfId: "p1", workspace, map, roster: [player], iceServers }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a welcome without ice servers (step 5.4)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          workspace,
          map,
          roster: [player],
          resumeToken: "tok-1",
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a welcome without a workspace (notes/006)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          map,
          roster: [player],
          resumeToken: "tok-1",
          iceServers,
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a workspaceList entry with a malformed slug (notes/006)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "workspaceList",
          workspaces: [{ slug: "Not A Slug", name: "X", mine: false }],
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a workspaceList entry without the creator flag (notes/007)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({ type: "workspaceList", workspaces: [{ slug: "alpha", name: "Alpha" }] }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a welcome without pods (notes/009)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          workspace,
          map,
          roster: [player],
          resumeToken: "tok-1",
          iceServers,
          chat: [],
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a welcome without the chat history (notes/010)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          workspace,
          map,
          roster: [player],
          resumeToken: "tok-1",
          iceServers,
          pods: [pod],
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a chat message without an id or timestamp (notes/010)", () => {
    const { id: _id, ...noId } = chatMsg;
    expect(() =>
      decodeServerMessage(JSON.stringify({ type: "chat", message: noId })),
    ).toThrow(/invalid server message/);
    const { ts: _ts, ...noTs } = chatMsg;
    expect(() =>
      decodeServerMessage(JSON.stringify({ type: "chat", message: noTs })),
    ).toThrow(/invalid server message/);
  });

  it("rejects a decorRejected with an unknown reason (notes/009)", () => {
    expect(() =>
      decodeServerMessage(JSON.stringify({ type: "decorRejected", reason: "hullBreach" })),
    ).toThrow(/invalid server message/);
  });

  it("rejects a placeItem whose kind left the library (notes/017)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "placeItem", kind: "sofa", x: 1, y: 2 })),
    ).toThrow(/invalid client message/);
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "placeItem", kind: "plant", x: 1 })),
    ).toThrow(/invalid client message/);
  });

  it("places at the authored size and color when the client sends neither (notes/017)", () => {
    expect(
      decodeClientMessage(JSON.stringify({ type: "placeItem", kind: "plant", x: 1, y: 2 })),
    ).toEqual({ type: "placeItem", kind: "plant", x: 1, y: 2, scale: 1, color: null });
  });

  it("rejects a scaleItem without an id or a size (notes/017)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "scaleItem", id: "", scale: 2 })),
    ).toThrow(/invalid client message/);
    expect(() => decodeClientMessage(JSON.stringify({ type: "scaleItem", id: "it_1" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects a raiseItem without an id or a depth (notes/017)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "raiseItem", id: "", depth: 20 })),
    ).toThrow(/invalid client message/);
    expect(() => decodeClientMessage(JSON.stringify({ type: "raiseItem", id: "it_1" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects a moveItem or deleteItem without an id (notes/017)", () => {
    expect(() =>
      decodeClientMessage(JSON.stringify({ type: "moveItem", id: "", x: 1, y: 2 })),
    ).toThrow(/invalid client message/);
    expect(() => decodeClientMessage(JSON.stringify({ type: "deleteItem" }))).toThrow(
      /invalid client message/,
    );
  });

  it("rejects an itemRejected with an unknown reason (notes/017)", () => {
    expect(() =>
      decodeServerMessage(JSON.stringify({ type: "itemRejected", reason: "hullBreach" })),
    ).toThrow(/invalid server message/);
  });

  it("rejects a welcome without the placed items (notes/017)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          workspace,
          owner: true,
          map,
          roster: [player],
          resumeToken: "tok-1",
          iceServers,
          pods: [pod],
          chat: [],
          race,
          blast,
          leaderboards: { race: [], blast: [] },
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a kicked with an unknown reason (notes/007)", () => {
    expect(() =>
      decodeServerMessage(JSON.stringify({ type: "kicked", reason: "mutiny" })),
    ).toThrow(/invalid server message/);
  });

  it("rejects a memberRejected with an unknown reason (notes/008)", () => {
    expect(() =>
      decodeServerMessage(JSON.stringify({ type: "memberRejected", reason: "hullBreach" })),
    ).toThrow(/invalid server message/);
  });

  it("rejects a memberList entry without the creator flag (notes/008)", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "memberList",
          slug: "alpha",
          members: [{ id: "user_1", name: "Ripley" }],
          banned: [],
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a createRejected with an unknown reason (notes/006)", () => {
    expect(() =>
      decodeServerMessage(JSON.stringify({ type: "createRejected", reason: "hullBreach" })),
    ).toThrow(/invalid server message/);
  });

  it("rejects a joinRejected with an unknown reason", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({ type: "joinRejected", reason: "hullBreach" }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a roster entry without a status (notes/004)", () => {
    const { status: _status, ...bad } = player;
    expect(() =>
      decodeServerMessage(
        JSON.stringify({
          type: "welcome",
          selfId: "p1",
          map,
          roster: [bad],
          resumeToken: "tok-1",
          iceServers,
        }),
      ),
    ).toThrow(/invalid server message/);
  });

  it("rejects a zoneChanged with an empty zoneId", () => {
    expect(() =>
      decodeServerMessage(
        JSON.stringify({ type: "zoneChanged", id: "p1", zoneId: "" }),
      ),
    ).toThrow(/invalid server message/);
  });
});
