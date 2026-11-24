// wire protocol: zod-validated discriminated unions for all WS messages (step 1.3)
import { z } from "zod";
import { characterSchema } from "./character";
import { ITEM_SCALE_DEFAULT, itemColorSchema, itemKindSchema, placedItemSchema } from "./items";
import { podClaimSchema } from "./pods";
import { gameTableGameSchema, mapDataSchema, pointSchema } from "./map";

// presence status a player sets for everyone to see (notes/004)
export const playerStatusSchema = z.enum(["available", "busy", "away"]);

// who a chat message reaches (notes/010): zone = the sender's current zone
// occupants; ship = everyone in the workspace; announce = ship-wide with a
// banner + chime on arrival (the megaphone)
export const chatScopeSchema = z.enum(["zone", "ship", "announce"]);

// the emote palette (notes/010): names on the wire, glyphs client-side;
// order matches the 1-6 keyboard shortcuts and the picker strip
export const emoteSchema = z.enum(["thumbsUp", "heart", "laugh", "party", "wave", "question"]);

// chat text bounds: trimmed non-empty, capped well under any frame limit
export const chatTextSchema = z.string().trim().min(1).max(500);

// one chat message as everyone renders it: server-assigned id + timestamp,
// sender captured by id AND name (the name survives the sender leaving),
// zoneId set only on zone-scoped messages (notes/010)
export const chatMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  name: z.string().min(1),
  scope: chatScopeSchema,
  zoneId: z.string().min(1).nullable(),
  text: chatTextSchema,
  ts: z.number(),
});

// workspace slug as it rides the URL and the join/resume messages: lowercase
// alphanumeric runs joined by single hyphens, server-derived from the name (notes/006)
export const workspaceSlugSchema = z
  .string()
  .max(32)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// what a client knows about a workspace: enough to label and link it (notes/006)
export const workspaceInfoSchema = z.object({
  slug: workspaceSlugSchema,
  name: z.string().min(1),
});

// a picker list entry: label/link info plus whether this account created the
// workspace — only creators may delete (notes/007)
export const workspaceListEntrySchema = workspaceInfoSchema.extend({
  mine: z.boolean(),
});

// one row of the member management panel (notes/008): the clerk user id keys
// remove/unban requests, the display name labels the row, creator marks the
// one row that can never be removed. Removed (banned) users reuse the shape
// with creator always false. email is absent for accounts without one
// (phone-only) or rows the server has not backfilled yet
export const memberEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
  creator: z.boolean(),
});

// an invite's target address (notes/015): trimmed and lowercased — invites are
// keyed by lowercased email (ADR 0003) — with one loose shape rule both sides
// share (something@something, no spaces); a typo just makes an unreachable,
// cancellable invite
export const inviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+$/);

// a connected participant as seen by every client
export const playerSchema = z.object({
  id: z.string().min(1),
  // clerk user id behind this session; lets clients match a claimed pod to its
  // owner's live presence status even when the owner stands elsewhere (notes/009)
  userId: z.string().min(1),
  name: z.string().min(1),
  // avatar hue in degrees, assigned by the server
  hue: z.number(),
  x: z.number(),
  y: z.number(),
  // null while in open space (no zone)
  zoneId: z.string().min(1).nullable(),
  micOn: z.boolean(),
  camOn: z.boolean(),
  speaking: z.boolean(),
  // true while this player shares their screen with their zone (notes/003)
  screenOn: z.boolean(),
  // self-set presence status, visible to everyone (notes/004)
  status: playerStatusSchema,
  // avatar appearance, chosen by the player (notes/002)
  character: characterSchema,
  // flight-deck pad index of the shuttle being flown; null while on foot (notes/003)
  shipPad: z.number().int().min(0).nullable(),
  // true while this player races a shuttle; rendered like a pilot, but the
  // shuttle is race-issued, not a pad's (shuttle race feature)
  racing: z.boolean(),
  // true while this player fights in a shuttle blasters match; rendered like a
  // pilot too (shuttle blasters feature)
  blasting: z.boolean(),
  // set after finishing a race / falling in a blasters match while their
  // scoreboard is still up: keeps them in that game's comms group (audioGroupOf)
  // until they close the board (boardClose), leave, or the next match starts
  debrief: gameTableGameSchema.nullable(),
  // the home Workspace's name while this person is a Visitor — someone aboard
  // via a Link, holding no Membership here; null for members. Badges them in
  // the crew panel and on the Map (space link feature)
  visitingFrom: z.string().min(1).nullable(),
  // shuttle heading in radians; only meaningful while shipPad is set or racing,
  // and absent until the first in-flight pos arrives (late joiners default it)
  shipA: z.number().optional(),
});

// --- shuttle race (holotable game) ---

// countdown between the raceStarted broadcast and GO; the server stamps the
// race clock this far ahead, clients freeze their shuttles this long
export const RACE_COUNTDOWN_MS = 3000;

// one lobby member as the panel lists them; during a race the members are the racers
export const raceMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ready: z.boolean(),
});

// one racer's grid slot: start pose, nose toward the first gate
export const raceStartSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  a: z.number(),
});

// one row of the final standings; timeMs null = did not finish
export const raceResultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timeMs: z.number().nullable(),
});

// race state as the welcome carries it, so a late joiner sees the lobby and a
// running race's gates; per-racer progress fills in from live messages
export const raceSnapshotSchema = z.object({
  racing: z.boolean(),
  members: z.array(raceMemberSchema),
  gates: z.array(pointSchema),
});

// --- shuttle blasters (holotable game) ---

// countdown between the blastStarted broadcast and the fight; the server
// refuses fires and hits stamped before its clock, clients freeze this long
export const BLAST_COUNTDOWN_MS = 3000;

// the circular combat arena, generated around the hull at match start
export const blastArenaSchema = z.object({
  x: z.number(),
  y: z.number(),
  r: z.number().positive(),
});

// one row of the final standings, winner first; survived marks everyone still
// flying when the match ended (exactly the winner, unless the time cap hit)
export const blastResultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  survived: z.boolean(),
});

// blasters state as the welcome carries it, so a late joiner sees the lobby
// (and a running match's arena); eliminations fill in from live messages
export const blastSnapshotSchema = z.object({
  playing: z.boolean(),
  members: z.array(raceMemberSchema),
  arena: blastArenaSchema.nullable(),
});

// --- game leaderboards (holotable games) ---

// one leaderboard row: an account's best score in a game — race best time
// (ms, lower is better) or blast best kill count (higher is better)
export const leaderboardEntrySchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  score: z.number(),
});

// both games' per-workspace leaderboards, best first; the welcome carries
// them and every score change rebroadcasts them
export const leaderboardsSchema = z.object({
  race: z.array(leaderboardEntrySchema),
  blast: z.array(leaderboardEntrySchema),
});

// opaque WebRTC signaling payload (SDP/ICE); must survive a JSON round-trip
const signalDataSchema = z.json();

// one RTCPeerConnection iceServers entry, minted by the server per welcome:
// STUN is always present; a TURN entry with short-lived static-auth-secret
// credentials appears when coturn is configured (step 5.4)
export const iceServerSchema = z.object({
  urls: z.array(z.string().min(1)).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
});

// --- client → server ---

export const clientMessageSchema = z.discriminatedUnion("type", [
  // request to board one workspace with a clerk session token and initial media
  // toggles; display name + character come from the server's user record (notes/005, notes/006)
  z.object({
    type: z.literal("join"),
    token: z.string().min(1),
    workspace: workspaceSlugSchema,
    micOn: z.boolean(),
    camOn: z.boolean(),
  }),
  // request to resume a dropped session within the grace window; the token came
  // from the welcome, the slug names the HOME workspace (notes/006), and
  // visited names the room actually holding the parked session while the drop
  // happened mid-Visit — the grace window resumes a Visit in place (ADR 0004).
  // the toggles are the effective ones after re-acquiring media (step 5.2)
  z.object({
    type: z.literal("resume"),
    token: z.string().min(1),
    workspace: workspaceSlugSchema,
    visited: workspaceSlugSchema.optional(),
    micOn: z.boolean(),
    camOn: z.boolean(),
  }),
  // pre-join: list the workspaces this account has joined (the picker, notes/006);
  // token per message — clerk session tokens expire in ~60s
  z.object({ type: z.literal("listWorkspaces"), token: z.string().min(1) }),
  // pre-join: create a workspace from a name; the server derives the slug (notes/006)
  z.object({
    type: z.literal("createWorkspace"),
    token: z.string().min(1),
    name: z.string().trim().min(1).max(40),
  }),
  // pre-join: delete a workspace this account created (notes/007)
  z.object({
    type: z.literal("deleteWorkspace"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
  }),
  // pre-join member management, creator-only (notes/008): list a workspace's
  // members + removed users, remove (ban) a member, or lift a ban
  z.object({
    type: z.literal("listMembers"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
  }),
  z.object({
    type: z.literal("removeMember"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
    userId: z.string().min(1),
  }),
  z.object({
    type: z.literal("unbanMember"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
    userId: z.string().min(1),
  }),
  // pre-join invites, creator-only (notes/015): send a standing offer to one
  // email address, or cancel a pending one
  z.object({
    type: z.literal("invite"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
    email: inviteEmailSchema,
  }),
  z.object({
    type: z.literal("cancelInvite"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
    email: inviteEmailSchema,
  }),
  // pre-join, any signed-in account (notes/015): the picker's pending lists —
  // invites whose email matches this account, and this account's join requests
  z.object({ type: z.literal("listPending"), token: z.string().min(1) }),
  // resolve an invite addressed to this account's email: accept creates the
  // membership (bans + cap re-checked), decline just removes it (notes/015)
  z.object({
    type: z.literal("acceptInvite"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
  }),
  z.object({
    type: z.literal("declineInvite"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
  }),
  // petition to join a workspace by its NAME — the server resolves it through
  // the same slug derivation as creation, so a slug works too (notes/015)
  z.object({
    type: z.literal("requestJoin"),
    token: z.string().min(1),
    name: z.string().trim().min(1).max(40),
  }),
  // withdraw this account's own pending join request (notes/015)
  z.object({
    type: z.literal("cancelRequest"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
  }),
  // adjudicate a join request, creator-only (notes/015): approve creates the
  // membership (bans + cap checked at this moment), deny just removes it
  z.object({
    type: z.literal("approveRequest"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
    userId: z.string().min(1),
  }),
  z.object({
    type: z.literal("denyRequest"),
    token: z.string().min(1),
    slug: workspaceSlugSchema,
    userId: z.string().min(1),
  }),
  // own avatar (or shuttle) moved; a = shuttle heading, sent only while flying (notes/003)
  z.object({ type: z.literal("pos"), x: z.number(), y: z.number(), a: z.number().optional() }),
  // boarded a shuttle from the given pad, or docked it (pad null) (notes/003)
  z.object({ type: z.literal("ship"), pad: z.number().int().min(0).nullable() }),
  // mic/cam toggled after joining
  z.object({
    type: z.literal("mediaState"),
    micOn: z.boolean(),
    camOn: z.boolean(),
  }),
  // local speaking detection changed
  z.object({ type: z.literal("speaking"), on: z.boolean() }),
  // screen share started/stopped (notes/003)
  z.object({ type: z.literal("screenShare"), on: z.boolean() }),
  // appearance edited in the crew locker while aboard (notes/002)
  z.object({ type: z.literal("character"), character: characterSchema }),
  // presence status picked in the crew panel (notes/004)
  z.object({ type: z.literal("status"), status: playerStatusSchema }),
  // display name edited in the crew locker; persisted to the user record (notes/005)
  z.object({ type: z.literal("rename"), name: z.string().trim().min(1).max(32) }),
  // wave at one player; the server relays it to them alone (notes/004)
  z.object({ type: z.literal("wave"), to: z.string().min(1) }),
  // send a chat message to the zone or the whole ship (notes/010); the server
  // stamps id/sender/time and echoes it back with everyone else's copy
  z.object({ type: z.literal("chat"), scope: chatScopeSchema, text: chatTextSchema }),
  // flash an emote above own avatar; relayed to the room, shown locally (notes/010)
  z.object({ type: z.literal("emote"), emote: emoteSchema }),
  // claim the pod the player stands in; refused if claimed or owning another (notes/009)
  z.object({ type: z.literal("claimPod"), zoneId: z.string().min(1) }),
  // release this account's pod claim in the current workspace (notes/009)
  z.object({ type: z.literal("releasePod") }),
  // decor (notes/017): drop a prop from the library on the deck, drag one that
  // is already down to a new spot, resize one, or clear one away. Anyone aboard
  // may do all four; the server re-runs the shared placement rules on every one
  z.object({
    type: z.literal("placeItem"),
    kind: itemKindSchema,
    x: z.number(),
    y: z.number(),
    // the size the tray's slider is set to; absent = the authored size
    scale: z.number().default(ITEM_SCALE_DEFAULT),
    // the color the tray's picker is set to; absent = the authored color
    color: itemColorSchema.nullable().default(null),
  }),
  z.object({ type: z.literal("moveItem"), id: z.string().min(1), x: z.number(), y: z.number() }),
  // resize a prop already on the deck; the server clamps the value it gets
  z.object({ type: z.literal("scaleItem"), id: z.string().min(1), scale: z.number() }),
  // recolor a prop already on the deck; null puts it back to its authored color
  z.object({
    type: z.literal("colorItem"),
    id: z.string().min(1),
    color: itemColorSchema.nullable(),
  }),
  // nudge a prop's draw order without moving it: depth biases only the y-sort
  // the deck is drawn in. The server clamps the value it gets
  z.object({ type: z.literal("raiseItem"), id: z.string().min(1), depth: z.number() }),
  z.object({ type: z.literal("deleteItem"), id: z.string().min(1) }),
  // shuttle race (holotable game): join the lobby while standing at a game
  // table, leave it (or drop out mid-race), toggle readiness, start the race
  // (any member, once everyone is ready), and report a gate pass — gate is the
  // cumulative count of gates passed, detected client-side
  z.object({ type: z.literal("raceJoin") }),
  z.object({ type: z.literal("raceLeave") }),
  z.object({ type: z.literal("raceReady"), on: z.boolean() }),
  z.object({ type: z.literal("raceStart") }),
  z.object({ type: z.literal("raceProgress"), gate: z.number().int().min(1) }),
  // shuttle blasters (holotable game): the same lobby verbs at a blasters
  // table, plus combat — blastFire announces a laser bolt (origin + heading,
  // for everyone else's canvas), blastHit reports the shooter's bolt touching
  // a target's shuttle (detected client-side; the server checks both are alive)
  z.object({ type: z.literal("blastJoin") }),
  z.object({ type: z.literal("blastLeave") }),
  z.object({ type: z.literal("blastReady"), on: z.boolean() }),
  z.object({ type: z.literal("blastStart") }),
  z.object({ type: z.literal("blastFire"), x: z.number(), y: z.number(), a: z.number() }),
  z.object({ type: z.literal("blastHit"), target: z.string().min(1) }),
  // close the post-game scoreboard: releases the debrief comms hold for the
  // named game; a no-op when no matching debrief is held (stale click)
  z.object({ type: z.literal("boardClose"), game: gameTableGameSchema }),
  // space link feature (in-room, at the portal): fetch the overlay's state —
  // the home Workspace's Links, plus management lists for its creator
  z.object({ type: z.literal("spaceLink") }),
  // link management, home-workspace-creator-only (space link feature):
  // petition another workspace by NAME (resolved like createWorkspace),
  // withdraw an outbound request, accept/deny an inbound one, remove a
  // standing Link, place a Block by NAME, or lift one
  z.object({ type: z.literal("linkRequest"), name: z.string().trim().min(1).max(40) }),
  z.object({ type: z.literal("linkCancel"), slug: workspaceSlugSchema }),
  z.object({ type: z.literal("linkAccept"), slug: workspaceSlugSchema }),
  z.object({ type: z.literal("linkDeny"), slug: workspaceSlugSchema }),
  z.object({ type: z.literal("linkRemove"), slug: workspaceSlugSchema }),
  z.object({ type: z.literal("linkBlock"), name: z.string().trim().min(1).max(40) }),
  z.object({ type: z.literal("linkUnblock"), slug: workspaceSlugSchema }),
  // traverse the portal: board a Workspace linked to home, or home itself
  // (return trip). the server answers with a fresh welcome for the new room
  z.object({ type: z.literal("visit"), slug: workspaceSlugSchema }),
  // replace the workspace's map with an owner-edited layout (notes/010 map
  // editor); creator-only, semantics checked server-side via mapEditDenial
  z.object({ type: z.literal("editMap"), map: mapDataSchema }),
  // WebRTC signaling relayed to one peer
  z.object({
    type: z.literal("signal"),
    to: z.string().min(1),
    data: signalDataSchema,
  }),
]);

// --- server → client ---

export const serverMessageSchema = z.discriminatedUnion("type", [
  // join or resume refused; the server closes the socket after sending (notes/005, step 5.2).
  // removed: this account was removed (banned) from the workspace (notes/008);
  // workspaceFull: a new member would push past the member cap (notes/008);
  // notMember: no membership — boarding takes an invite or an approved join
  // request (notes/015)
  z.object({
    type: z.literal("joinRejected"),
    reason: z.enum([
      "unauthorized",
      "resumeExpired",
      "workspaceNotFound",
      "removed",
      "workspaceFull",
      "notMember",
    ]),
  }),
  // join accepted: your id, the workspace you boarded (notes/006), the map,
  // everyone currently aboard (incl. you), the token that resumes this session
  // within the grace window (step 5.2), and the ICE servers this session's
  // peer connections must use (step 5.4)
  z.object({
    type: z.literal("welcome"),
    selfId: z.string().min(1),
    // the room this session now stands in — the visited workspace during a
    // Visit (space link feature)
    workspace: workspaceInfoSchema,
    // the session's home workspace (the one boarded via URL/picker); equals
    // workspace except while visiting (space link feature, ADR 0004)
    home: workspaceInfoSchema,
    // true when this account created the workspace — gates the map editor
    // client-side (the server re-checks every edit) (notes/010 map editor)
    owner: z.boolean(),
    map: mapDataSchema,
    roster: z.array(playerSchema),
    resumeToken: z.string().min(1),
    iceServers: z.array(iceServerSchema),
    // this workspace's pod claims, from the db (notes/009)
    pods: z.array(podClaimSchema),
    // every prop standing on this workspace's deck, from the db (notes/017)
    items: z.array(placedItemSchema),
    // recent ship-scoped chat so a joiner has context; zone-scoped messages
    // are live-only — they never reach people outside the zone (notes/010)
    chat: z.array(chatMessageSchema),
    // the shuttle race lobby / running race (shuttle race feature)
    race: raceSnapshotSchema,
    // the shuttle blasters lobby / running match (shuttle blasters feature)
    blast: blastSnapshotSchema,
    // both games' persisted best scores (leaderboard feature)
    leaderboards: leaderboardsSchema,
  }),
  // pre-join replies for the picker (notes/006)
  z.object({ type: z.literal("workspaceList"), workspaces: z.array(workspaceListEntrySchema) }),
  z.object({ type: z.literal("workspaceCreated"), slug: workspaceSlugSchema, name: z.string().min(1) }),
  z.object({
    type: z.literal("createRejected"),
    // limitReached: the account already created MAX_WORKSPACES_PER_USER (notes/007)
    reason: z.enum(["slugTaken", "invalidName", "unauthorized", "limitReached"]),
  }),
  // delete replies for the picker (notes/007)
  z.object({ type: z.literal("workspaceDeleted"), slug: workspaceSlugSchema }),
  z.object({
    type: z.literal("deleteRejected"),
    reason: z.enum(["unauthorized", "notFound", "notCreator"]),
  }),
  // member management replies, creator-only (notes/008): the panel's two lists,
  // one ack per action, and a shared rejection — isCreator fires only on an
  // attempt to remove the creator's own row
  z.object({
    type: z.literal("memberList"),
    slug: workspaceSlugSchema,
    members: z.array(memberEntrySchema),
    banned: z.array(memberEntrySchema),
    // pending invites (their target emails) and join requests for the panel's
    // send/cancel and approve/deny controls (notes/015)
    invites: z.array(z.string().min(1)),
    requests: z.array(memberEntrySchema),
  }),
  z.object({ type: z.literal("memberRemoved"), slug: workspaceSlugSchema, userId: z.string().min(1) }),
  z.object({ type: z.literal("memberUnbanned"), slug: workspaceSlugSchema, userId: z.string().min(1) }),
  z.object({
    type: z.literal("memberRejected"),
    reason: z.enum(["unauthorized", "notFound", "notCreator", "isCreator"]),
  }),
  // invite replies (notes/015): acks per action plus one shared rejection.
  // notFound covers a vanished workspace OR a vanished invite (accept after
  // cancel); removed = the target account is banned; full = the member cap
  z.object({ type: z.literal("inviteSent"), slug: workspaceSlugSchema, email: z.string().min(1) }),
  z.object({ type: z.literal("inviteCancelled"), slug: workspaceSlugSchema, email: z.string().min(1) }),
  z.object({ type: z.literal("inviteAccepted"), slug: workspaceSlugSchema }),
  z.object({ type: z.literal("inviteDeclined"), slug: workspaceSlugSchema }),
  z.object({
    type: z.literal("inviteRejected"),
    reason: z.enum(["unauthorized", "notFound", "notCreator", "removed", "alreadyMember", "full"]),
  }),
  // join-request replies (notes/015), same shape: requestSent echoes the
  // resolved workspace so the picker can list it; notFound covers a name that
  // derives to nothing or a vanished request (approve after cancel)
  z.object({ type: z.literal("requestSent"), slug: workspaceSlugSchema, name: z.string().min(1) }),
  z.object({ type: z.literal("requestCancelled"), slug: workspaceSlugSchema }),
  z.object({ type: z.literal("requestApproved"), slug: workspaceSlugSchema, userId: z.string().min(1) }),
  z.object({ type: z.literal("requestDenied"), slug: workspaceSlugSchema, userId: z.string().min(1) }),
  z.object({
    type: z.literal("requestRejected"),
    reason: z.enum(["unauthorized", "notFound", "notCreator", "removed", "alreadyMember", "full"]),
  }),
  // the picker's pending lists (notes/015): invites addressed to this
  // account's email, and this account's own join requests, newest first
  z.object({
    type: z.literal("pendingList"),
    invites: z.array(workspaceInfoSchema),
    requests: z.array(workspaceInfoSchema),
  }),
  // an established session was ended server-side: this account boarded
  // somewhere else (one active session per account), the workspace was
  // deleted under it, or the creator removed this account from it (notes/008).
  // The resume token is dead — the server closes the socket after sending (notes/007)
  // visitEnded: the Visit this session was on died under it — the Link was
  // removed, the Visitor was banned, or the visited workspace was deleted —
  // and the client re-boards home on its own (space link feature)
  z.object({
    type: z.literal("kicked"),
    reason: z.enum(["boardedElsewhere", "workspaceDeleted", "removed", "visitEnded"]),
  }),
  // someone else boarded
  z.object({ type: z.literal("playerJoined"), player: playerSchema }),
  // someone left (exit, disconnect, or heartbeat timeout)
  z.object({ type: z.literal("playerLeft"), id: z.string().min(1) }),
  // another player moved; a = shuttle heading, present only while they fly (notes/003)
  z.object({
    type: z.literal("pos"),
    id: z.string().min(1),
    x: z.number(),
    y: z.number(),
    a: z.number().optional(),
  }),
  // another player boarded a shuttle (pad set) or docked it (pad null) (notes/003)
  z.object({
    type: z.literal("ship"),
    id: z.string().min(1),
    pad: z.number().int().min(0).nullable(),
  }),
  // another player toggled mic/cam
  z.object({
    type: z.literal("mediaState"),
    id: z.string().min(1),
    micOn: z.boolean(),
    camOn: z.boolean(),
  }),
  // another player started/stopped speaking
  z.object({
    type: z.literal("speaking"),
    id: z.string().min(1),
    on: z.boolean(),
  }),
  // another player started/stopped sharing their screen (notes/003)
  z.object({
    type: z.literal("screenShare"),
    id: z.string().min(1),
    on: z.boolean(),
  }),
  // another player changed their appearance (notes/002)
  z.object({
    type: z.literal("character"),
    id: z.string().min(1),
    character: characterSchema,
  }),
  // another player changed their presence status (notes/004)
  z.object({
    type: z.literal("status"),
    id: z.string().min(1),
    status: playerStatusSchema,
  }),
  // another player changed their display name (notes/005)
  z.object({
    type: z.literal("rename"),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  // someone waved at you; delivered to the target only (notes/004)
  z.object({ type: z.literal("wave"), from: z.string().min(1) }),
  // a chat message, delivered to its scope's audience, sender included — the
  // echo carries the server-assigned id/timestamp (notes/010)
  z.object({ type: z.literal("chat"), message: chatMessageSchema }),
  // another player emoted — an event like a wave, nothing stored (notes/010)
  z.object({ type: z.literal("emote"), id: z.string().min(1), emote: emoteSchema }),
  // a pod was claimed / released; sent to everyone, claimer included (notes/009)
  z.object({ type: z.literal("podClaimed"), pod: podClaimSchema }),
  z.object({ type: z.literal("podReleased"), zoneId: z.string().min(1) }),
  // a claim/release was refused; sent to the actor alone (notes/009)
  z.object({
    type: z.literal("decorRejected"),
    reason: z.enum([
      "podTaken", // someone claimed it first
      "haveClaim", // one pod per account per workspace
      "notAPod", // the zone isn't claimable
      "notInPod", // must stand in a pod to claim it
      "noClaim", // release with nothing claimed
      "visitor", // Visitors leave no persistent footprint (space link feature)
    ]),
  }),
  // a prop was placed / dragged / resized / restacked / cleared; sent to
  // everyone, actor included — the echo carries the server-assigned id (notes/017)
  z.object({ type: z.literal("itemPlaced"), item: placedItemSchema }),
  z.object({ type: z.literal("itemMoved"), id: z.string().min(1), x: z.number(), y: z.number() }),
  // the clamped size the server stored, which may differ from what was asked
  z.object({ type: z.literal("itemScaled"), id: z.string().min(1), scale: z.number() }),
  // the normalized color the server stored; null = back to the authored color
  z.object({
    type: z.literal("itemColored"),
    id: z.string().min(1),
    color: itemColorSchema.nullable(),
  }),
  // the clamped draw-order nudge the server stored
  z.object({ type: z.literal("itemRaised"), id: z.string().min(1), depth: z.number() }),
  z.object({ type: z.literal("itemDeleted"), id: z.string().min(1) }),
  // a place/move/scale/raise/delete was refused; sent to the actor alone (notes/017)
  z.object({
    type: z.literal("itemRejected"),
    reason: z.enum([
      "offFloor", // props stand on the deck, not in the starfield
      "notYourPod", // someone else's claimed pod
      "full", // the workspace hit MAX_ITEMS_PER_WORKSPACE
      "gone", // the prop was already cleared by someone else
      "visitor", // Visitors leave no persistent footprint (space link feature)
    ]),
  }),
  // the workspace's map was replaced by an owner edit (notes/010 map editor);
  // sent to everyone, editor included. pods and items ride along because the
  // edit may have pruned claims (zone gone / no longer a pod) and props whose
  // deck vanished — clients replace all three from this one message
  z.object({
    type: z.literal("mapChanged"),
    map: mapDataSchema,
    pods: z.array(podClaimSchema),
    items: z.array(placedItemSchema),
  }),
  // an editMap was refused; sent to the editor alone (notes/010 map editor)
  z.object({
    type: z.literal("mapRejected"),
    reason: z.enum(["notCreator", "invalidMap"]),
  }),
  // --- space link (workspace linking) ---
  // the Space Link overlay's state, always the HOME workspace's Links (Q5):
  // management lists ride along only for home's creator (empty otherwise)
  z.object({
    type: z.literal("spaceLinkState"),
    home: workspaceInfoSchema,
    // the caller created home — management shows (and is accepted) only then
    creator: z.boolean(),
    links: z.array(workspaceInfoSchema),
    // pending Link Requests: inbound awaits accept/deny, outbound cancel
    inbound: z.array(workspaceInfoSchema),
    outbound: z.array(workspaceInfoSchema),
    // workspaces home is blocking (creator-only, like the pending lists)
    blocks: z.array(workspaceInfoSchema),
  }),
  // a link management action of ours was refused; sent to the actor alone
  z.object({
    type: z.literal("linkRejected"),
    reason: z.enum([
      "notFound", // no workspace by that name, or the request/link is gone
      "notCreator", // only home's creator manages links, and only at home
      "self", // no self-links
      "alreadyLinked", // the pair is already linked
      "blocked", // the other side blocks this workspace
      "youBlocked", // this workspace blocks them — unblock first
      "requestPending", // they already asked — accept their inbound request
      "linkLimit", // a side is at the 10-link cap
    ]),
  }),
  // a portal traversal of ours was refused; sent to the actor alone
  z.object({
    type: z.literal("visitRejected"),
    reason: z.enum([
      "notFound", // the workspace is gone
      "notLinked", // no Link between home and there
      "removed", // banned there — a Link is not an unban
      "full", // 10 concurrent Visitors already aboard (Q11)
      "flying", // dock (or land) before stepping through
      "notNearLink", // must stand at the Space Link
    ]),
  }),
  // --- shuttle race (holotable game) ---
  // the lobby changed (join/leave/ready); the full member list every time,
  // sent to everyone so walk-ups see who's waiting at the table
  z.object({ type: z.literal("raceLobby"), members: z.array(raceMemberSchema) }),
  // the race is on: the gate loop and every racer's grid slot; racers freeze
  // for RACE_COUNTDOWN_MS after receipt, everyone else spectates
  z.object({
    type: z.literal("raceStarted"),
    gates: z.array(pointSchema),
    racers: z.array(raceStartSchema),
  }),
  // a racer passed a gate; gate = their cumulative count (drives leaderboards)
  z.object({ type: z.literal("raceProgress"), id: z.string().min(1), gate: z.number().int().min(1) }),
  // a racer crossed the last gate; the server assigns place and time
  z.object({
    type: z.literal("raceFinished"),
    id: z.string().min(1),
    place: z.number().int().min(1),
    timeMs: z.number(),
  }),
  // a racer quit mid-race — they're back on foot (their next pos says where)
  z.object({ type: z.literal("raceLeft"), id: z.string().min(1) }),
  // the race is over (everyone finished/left, or the time cap hit): final
  // standings, finishers first; the lobby resets empty
  z.object({ type: z.literal("raceEnded"), results: z.array(raceResultSchema) }),
  // a race action of ours was refused; sent to the actor alone
  z.object({
    type: z.literal("raceRejected"),
    reason: z.enum([
      "notNearTable", // must stand at a game table to join
      "raceInProgress", // no joining or starting while shuttles are out
      "lobbyFull", // the start grid is full
      "flying", // dock the pad shuttle before joining
      "notInLobby", // ready/start/leave without being a member
      "notAllReady", // start pressed before every member readied
    ]),
  }),
  // --- shuttle blasters (holotable game) ---
  // the blasters lobby changed (join/leave/ready); full list to everyone
  z.object({ type: z.literal("blastLobby"), members: z.array(raceMemberSchema) }),
  // the match is on: the arena and every player's spawn pose; players freeze
  // for BLAST_COUNTDOWN_MS after receipt, everyone else spectates
  z.object({
    type: z.literal("blastStarted"),
    arena: blastArenaSchema,
    players: z.array(raceStartSchema),
  }),
  // a player fired a laser bolt; relayed so every canvas draws it
  z.object({
    type: z.literal("blastFire"),
    id: z.string().min(1),
    x: z.number(),
    y: z.number(),
    a: z.number(),
  }),
  // a player's shuttle was destroyed by another's bolt — they're out, back on
  // foot (their next pos says where)
  z.object({ type: z.literal("blastEliminated"), id: z.string().min(1), by: z.string().min(1) }),
  // a player quit mid-match (a forfeit — they count as eliminated)
  z.object({ type: z.literal("blastLeft"), id: z.string().min(1) }),
  // the match is over (one shuttle left, everyone gone, or the time cap hit):
  // final standings, winner first; the lobby resets empty
  z.object({ type: z.literal("blastEnded"), results: z.array(blastResultSchema) }),
  // a blasters action of ours was refused; sent to the actor alone
  z.object({
    type: z.literal("blastRejected"),
    reason: z.enum([
      "notNearTable", // must stand at a blasters game table to join
      "matchInProgress", // no joining or starting while shuttles are out
      "lobbyFull", // the arena is full
      "flying", // dock the pad shuttle before joining
      "notInLobby", // ready/start/leave without being a member
      "notAllReady", // start pressed before every member readied
      "needTwo", // a fight takes at least two shuttles
    ]),
  }),
  // the persisted leaderboards changed (a race/match just ended); full fresh
  // lists to everyone aboard (leaderboard feature)
  z.object({
    type: z.literal("leaderboards"),
    race: z.array(leaderboardEntrySchema),
    blast: z.array(leaderboardEntrySchema),
  }),
  // a player's post-game debrief ended (board closed / next match started):
  // their roster entry leaves the game's comms group
  z.object({ type: z.literal("debriefEnded"), id: z.string().min(1) }),
  // a player's zone membership changed (zoneId null = left into open space)
  z.object({
    type: z.literal("zoneChanged"),
    id: z.string().min(1),
    zoneId: z.string().min(1).nullable(),
  }),
  // directive: open a peer connection; initiator creates the offer
  z.object({
    type: z.literal("peerConnect"),
    peerId: z.string().min(1),
    initiator: z.boolean(),
  }),
  // directive: tear down the peer connection
  z.object({ type: z.literal("peerDisconnect"), peerId: z.string().min(1) }),
  // WebRTC signaling relayed from a peer
  z.object({
    type: z.literal("signal"),
    from: z.string().min(1),
    data: signalDataSchema,
  }),
]);

export type Player = z.infer<typeof playerSchema>;
export type RaceMember = z.infer<typeof raceMemberSchema>;
export type RaceStart = z.infer<typeof raceStartSchema>;
export type RaceResult = z.infer<typeof raceResultSchema>;
export type RaceSnapshot = z.infer<typeof raceSnapshotSchema>;
export type BlastArena = z.infer<typeof blastArenaSchema>;
export type BlastResult = z.infer<typeof blastResultSchema>;
export type BlastSnapshot = z.infer<typeof blastSnapshotSchema>;
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
export type Leaderboards = z.infer<typeof leaderboardsSchema>;
export type PlayerStatus = z.infer<typeof playerStatusSchema>;
export type ChatScope = z.infer<typeof chatScopeSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Emote = z.infer<typeof emoteSchema>;
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;
export type SpaceLinkState = Extract<
  z.infer<typeof serverMessageSchema>,
  { type: "spaceLinkState" }
>;
export type WorkspaceListEntry = z.infer<typeof workspaceListEntrySchema>;
export type MemberEntry = z.infer<typeof memberEntrySchema>;
export type IceServer = z.infer<typeof iceServerSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// serialize an already-typed message for the wire
export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

// parse + validate raw wire data with one schema; throws one readable error
function decode<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${label}: not valid JSON`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(`invalid ${label}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// used by the server on incoming socket data
export function decodeClientMessage(raw: string): ClientMessage {
  return decode(clientMessageSchema, raw, "client message");
}

// used by the client on incoming socket data
export function decodeServerMessage(raw: string): ServerMessage {
  return decode(serverMessageSchema, raw, "server message");
}
