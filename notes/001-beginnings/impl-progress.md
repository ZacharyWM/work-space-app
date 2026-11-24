# Implementation Progress

Tracks completed steps from [implementation-plan.md](implementation-plan.md).

## 1.1 Monorepo scaffold — done (2026-07-02)

- Root `package.json` with npm workspaces (`client`, `server`, `shared`);
  scripts: `dev` (concurrently), `client:dev`, `server:dev`, `typecheck`,
  `test`, `build`.
- Root `tsconfig.base.json`: strict, ES2022, bundler resolution; each
  workspace extends it.
- `shared/`: plain TS package exporting from `src/index.ts` (raw TS via the
  `exports` field — Vite, tsx, and Vitest all consume it directly, no build).
- `server/`: `ws` + `tsx` watch, listens on port 3000 (matches
  `.claude/launch.json`), imports from `shared`.
- `client/`: Vite 7 + React 19, imports from `shared`.
- Vitest at root picking up `shared/` and `server/` tests; one placeholder
  test proving workspace-name resolution.
- Gotcha hit: client pinned vite 6 while vitest hoisted vite 7 to the root,
  breaking `@vitejs/plugin-react` typechecking against duplicated vite types.
  Fixed by putting the client on vite ^7 so one copy dedupes.

Verified: `npm run typecheck` green in all three workspaces, `npm test`
passes (1 test), `npm run dev` boots server (ws on 3000) and client
(vite on 5173) together; client renders in the browser with no console
errors.

## 1.2 Shared: map schema + geometry — done (2026-07-02)

- `shared/src/map.ts`: zod schemas + inferred types for `MapData` (floor
  plates x/y/w/h/r, zones id/name/rect, decor as an empty `z.never()` union
  until 4.2, spawn point). `parseMapData` throws one readable error via
  `z.prettifyError`.
- `shared/src/geometry.ts`: `inFloor` (inclusive edges), `clampMove`
  (prototype per-axis order — x first, y tested against the updated x),
  `zoneAt` (inclusive edges, null in open space), `validateZonesDisjoint`.
- Decision: `validateZonesDisjoint` rejects zones that merely *touch*, not
  just overlap — `zoneAt` edges are inclusive, so a shared edge would make
  membership ambiguous. The prototype's zones have gaps, so this is free.
- `map.json` at repo root: 8 floor plates, 6 zones, spawn (330, 800) copied
  verbatim from the prototype's `FLOORS`/`ZONES`/player start. Dropped the
  bridge zone's `via` waypoint field (bot routing only, not in scope).
- Added `zod` to `shared`.

Verified: 18 tests pass (floor in/out incl. edges, per-axis clamp cases
incl. the updated-x ordering, zone hit-testing incl. boundaries, overlap
and shared-edge rejection, real `map.json` parses); typecheck green.

## 1.3 Shared: protocol types — done (2026-07-02)

- `shared/src/protocol.ts`: zod discriminated unions (on `type`) for all
  wire messages — client→server `join`/`pos`/`mediaState`/`speaking`/
  `signal`, server→client `welcome`/`playerJoined`/`playerLeft`/`pos`/
  `mediaState`/`speaking`/`zoneChanged`/`peerConnect`/`peerDisconnect`/
  `signal` — plus the `Player` shape
  (`id, name, hue, x, y, zoneId, micOn, camOn, speaking`).
- `zoneId` is `string | null` (null = open space), matching `zoneAt`.
- Signal `data` is `z.json()` — opaque SDP/ICE payload, only constrained to
  survive a JSON round-trip.
- Helpers: `encodeMessage` (stringify), `decodeClientMessage` /
  `decodeServerMessage` (JSON.parse + zod safeParse, throwing one readable
  error in the `parseMapData` style — the 1.4 server catches and logs).
- Fields the plan left implicit: `playerJoined` carries a full `Player`;
  `playerLeft`/`pos`/`mediaState`/`speaking`/`zoneChanged` carry the
  subject's `id` plus the changed fields.

Verified: 23 new tests pass (round-trip for every message variant incl.
a real-map `welcome`, non-JSON rejected, unknown type rejected, missing/
mistyped fields rejected, server-only type rejected by the client decoder);
41 total, typecheck green.

## 1.4 Server: presence — done (2026-07-02)

- `server/src/state.ts`: `RoomState<TSocket>` — in-memory session map keyed
  by nanoid id. Generic over the socket type so unit tests use plain string
  tokens, no `ws` import. Owns id + hue assignment (golden-angle increment,
  `joins * 137.508 % 360`, never decremented so hues stay spread after
  leaves); spawn point and zoneId are passed in by the caller to keep the
  module map-free.
- `server/src/index.ts`: loads `map.json` via `new URL` relative to the
  source file (cwd-proof), `parseMapData` + `validateZonesDisjoint` fail
  fast before listening. Handles `join` (welcome with map + full roster,
  `playerJoined` to others), `pos` (update + broadcast, no echo), close
  (leave + `playerLeft`). Per-socket ws ping/pong sweep every 5s terminates
  dead sockets, which flows through the same close handler.
- zoneId at join = `zoneAt(map, spawn)` (null today — spawn is open space)
  so the roster field stays correct if spawn ever moves into a zone.
- Bad input never crashes: decode failures, unknown types, duplicate joins,
  and pre-join `pos` are logged and dropped; socket `error` events logged.
  Valid-but-later types (`mediaState`/`speaking`/`signal`) log as unhandled
  until steps 3.x.
- `PORT` env override added (default 3000) — needed to run a second instance
  for testing next to a dev server; also serves step 5.3 later.
- Added `nanoid` to `server`.

Verified: 10 new unit tests on `RoomState` (join fields, unique ids, hue
spread + wrap + post-leave advance, roster order, othersOf excludes self,
leave/updatePos incl. unknown ids); 51 total, typecheck green. Manual: a
two-client script (node built-in `WebSocket`) against a live instance on
port 3100 — welcome with map + roster, `playerJoined`, `pos` broadcast with
no echo, `playerLeft` on close, and garbage/duplicate-join input survived.

## 1.5 Client: join screen + WS connection — done (2026-07-02)

- `client/src/net/connection.ts`: `Connection` class — opens the socket,
  sends `join` on open, decodes with `decodeServerMessage` (bad messages
  logged and dropped, mirroring the server). Owns `selfId`, `map`, and a
  live `roster` Map; applies `playerJoined`/`playerLeft`/`pos`/`mediaState`/
  `speaking`/`zoneChanged`; peer directives log as unhandled until 3.x.
  Callbacks: `onWelcome`, `onRosterChange`, `onClose`.
- `client/src/App.tsx`: phase state machine `join → connecting → aboard`.
  Join screen is a plain form (Enter submits, BOARD SHIP disabled on empty/
  whitespace name, mic/cam checkboxes are local state only). Any socket
  close — drop, server death, or failed connect — returns to the join
  screen with a "connection closed" notice (fresh-join semantics,
  decision 10). Aboard view is a placeholder roster list (name, rounded
  x/y, "you" marker) that 1.6 replaces with the canvas.
- WS URL is `ws://${location.hostname}:3000` — hostname-relative so LAN
  clients reach the server, port matching `.claude/launch.json`.
- Fixed `.claude/launch.json` `client-preview`: it nested `npm run` twice,
  so `--port 5174` was swallowed and vite got `5174` as a root dir argument
  (served an empty page). Now runs `npm run dev -w client -- --port 5174`.

Verified: typecheck + 51 tests green. Manual against live server + vite:
board from the browser (server logs join, roster shows self at spawn
330, 800); a scripted second client joins → appears in the browser roster,
its `pos` (500, 700) renders, closing it removes it; killing the server
returns the browser to the join screen with the notice; empty name keeps
BOARD SHIP disabled; no console errors or warnings.

## 1.6 Client: canvas renderer + movement + camera — done (2026-07-02)

- `client/src/render/draw.ts`: pure scene drawing, all numbers copied from
  the prototype's `draw()`/`drawAvatar()` — background + two radial washes,
  140 parallax/twinkle stars (screen space, camera-fractional shift with
  wrap), floor plates in three passes (outer hull plate, inner deck, clipped
  40px grid), airlock label + dashed circle at `map.spawn`, avatars (drop
  shadow, self white ring, hue-keyed body, visor, name pill — self reads YOU
  in accent) y-sorted back-to-front. Accent `#3EE08A` hardcoded here until
  theme.json (4.1). Zones/decor/speaking rings intentionally absent (2.2,
  4.2, 3.6).
- `client/src/render/stage.ts`: `Stage` class owning the rAF loop outside
  React — DPR-capped (2) canvas sizing with ResizeObserver; WASD/arrow keys
  on window (ignored when an INPUT/TEXTAREA has focus, preventDefault on
  move keys); movement 255 px/s diagonal-normalized through shared
  `clampMove`; camera eased follow (0.1/frame) + eased zoom (0.12/frame),
  wheel `exp(-deltaY*0.0013)` clamped 0.3–1.8, starting wide (z 0.55 →
  tz 1.05, prototype join fly-in); `pos` sends every 66ms and only when
  moved; remote avatars ease toward their last received position
  (`1 - exp(-15·dt)`, snap on first sight, display state pruned on leave).
  The self roster entry is updated as the player moves so later consumers
  (zone counts, 2.x) read a truthful roster.
- `client/src/render/ShipCanvas.tsx`: mounts the canvas + Stage, disposes on
  unmount. Replaces the 1.5 placeholder roster list in `App`; the react
  roster snapshot state is gone (`onRosterChange` is a no-op — the stage
  reads `conn.roster` every frame).
- `client/index.html`: minimal full-viewport reset (margin 0, overflow
  hidden, bg/text colors); the real styling pass is 4.3.
- Tooling: `.claude/launch.json` `client-preview` now uses `autoPort` (was
  hardcoded 5174, collided with a second session); `vite.config.ts` honors a
  harness-assigned `PORT` env var.

Verified: typecheck + 51 tests green (no new pure logic — clamp/schema
already covered). Manual against live server + vite: boarding renders the
ship (starfield, double-border plates, grid, airlock marker, self avatar
with YOU pill) and the camera flies in; a scripted second client walking the
mid floor renders and moves; a 1s hold of `a` moved the player 253px
(≈255 px/s) with 16 pos sends (≈15/s, none while idle); a 2.5s hold clamped
at the bridge's left edge (x 562 vs edge 560, one sub-frame step, prototype
behavior); wheel zoom-out clamps at 0.3 with the whole ship visible; killing
the server returns to the join screen and rejoining respawns at the airlock
cleanly; no console errors or warnings.

## 2.1 Server: zone membership — done (2026-07-02)

- `RoomState.updatePos` now takes the `zoneId` the caller computed for the
  new position (module stays map-free, same pattern as `join`) and returns
  `{ zoneChanged } | null` (null = unknown id, replacing the old boolean).
- `pos` handler in `server/src/index.ts`: `zoneAt` on every update; when the
  zone changed, broadcast `zoneChanged {id, zoneId}`.
- Decision: `zoneChanged` goes to *everyone including the mover* (unlike
  `pos`, which has no echo). The server's zone is authoritative and the 2.3
  HUD/toasts need it; deriving it client-side from throttled `pos` samples
  could disagree at boundaries.
- Transitions are instant — no debounce, per the plan's noted risk.

Verified: 2 new unit tests — a position walk (open space → zone a → within
a → zone b → within b → open space) emits exactly `["a", "b", null]` via the
same zoneAt-then-updatePos sequence the handler runs, and the player's
roster `zoneId` tracks it; updatePos tests updated for the new signature.
53 total, typecheck green.

## 2.2 Client: zone rendering — done (2026-07-02)

- `client/src/render/draw.ts`: zone pass between the floor grid and the
  airlock marker (prototype draw order), numbers copied verbatim: rounded
  rect r 10, accent fill .08/.03 (mine/other), stroke .85 lw 2.5 + shadowBlur
  18 glow for mine vs .25 lw 1.25, label `600 13px IBM Plex Mono` at
  (x+12, y+21) in accent .95/.5. Count suffix ` · n` only when occupied
  (prototype behavior — `NAME` alone when empty).
- `stage.ts` tick: derives `zoneCounts` and `myZoneId` from roster `zoneId`s
  each frame and passes them to `drawScene`. No local `zoneAt` — zoneIds are
  server-authoritative via the 2.1 `zoneChanged` echo, so every client
  renders identical counts and glow, including at boundaries.

Verified: typecheck + 53 tests green (no new pure logic — counts are a
two-line fold; the plan's verify is manual). Manual against live server +
vite, browser client + scripted ws client: zones render dim with bare names
when empty; walking into MED BAY lights the glow and shows `MED BAY · 1`;
the scripted client joining it makes `· 2` (its `welcome` roster already
carried `nova@med`); it moving to the lounge drops med to `· 1`; standing
exactly on the med corner (150, 470) counts it in (server echoed
`zone=med`), 1px outside (149, 469) counts it out (`zone=null`) — browser
count matched the server echo at every phase; walking the local player out
kills glow + suffix; scripted client disconnect clears its count via
`playerLeft`; no console errors or warnings.

## 2.3 Client: zone HUD — done (2026-07-02)

- `client/src/ui/Hud.tsx`: bottom toolbar (mic/cam toggle buttons — still
  local state only, name, zone label or "OPEN SPACE — PRIVATE", zoom −/+,
  EXIT), zone toasts, and the open-space pill (top center, only when
  `zoneId === null`). Behavior numbers copied from the prototype — toast
  texts `ENTERED · {ZONE}` (2200ms) / `LEFT ZONE · COMMS CLOSED` (2000ms,
  timer reset on each transition, zone→zone re-announces the new zone),
  labels, pill copy; visual styling deliberately minimal until the 4.3
  pass. Accent `#3EE08A` hardcoded here (as in draw.ts) until 4.1.
- `connection.ts`: optional `onSelfZoneChanged` handler fired when a
  `zoneChanged` targets self — the HUD zone is driven by the server echo
  (2.1 decision), never computed locally.
- `stage.ts`: `zoomIn`/`zoomOut` methods for the HUD buttons (prototype
  step ×1.28, same 0.3–1.8 clamp as the wheel). `ShipCanvas` exposes the
  stage through a passed-in ref so the HUD can reach the camera.
- `App.tsx`: owns `selfZoneId` (seeded from the welcome roster, updated by
  `onSelfZoneChanged`); EXIT closes the socket deliberately via a
  `leavingRef` so `onClose` skips the "connection closed" notice while
  real drops still show it. Server despawn comes free from the close
  handler (1.4).

Verified (M2 gate): typecheck + 53 tests green (no new pure logic — the
gate verify is manual). This session's preview-server slots were all taken
by other chats, so verification ran as a scripted playwright harness
(scratchpad install, cached chromium headless shell) driving two headless
browsers against the live dev servers — 24/24 checks passed: pill +
private label + MIC/CAM ON + name on board; mic/cam toggle round-trips;
zoom-out changes canvas pixels; walking into MED BAY raises the enter
toast, sets the label, hides the pill, toast auto-dismisses; a second
browser entering agrees in both (`MED BAY · 2` in the screenshot); walking
out raises the leave toast, restores label + pill, and leaves the other
browser's MED BAY label intact; EXIT returns to the join screen with no
"connection closed" notice; zero console/page errors in both browsers
throughout.

## 3.1 Client: media manager — done (2026-07-02)

- `client/src/media/localMedia.ts`: `LocalMedia` — `acquire(toggles)` runs
  getUserMedia per the join toggles, never throws (decision 8): combined
  request first (one permission prompt when both are wanted); on failure,
  per-kind solo retries so a denied cam still yields the mic (denied
  permissions reject the retry instantly, no second prompt). Missing
  `mediaDevices` (insecure http origin over LAN) boards with nothing.
  `setMicOn`/`setCamOn` flip `track.enabled` (instant mute, device stays
  warm) and return the effective state; a missing track reads and stays off.
  `dispose()` stops all tracks. Exposes one `stream` for the 3.4 peers.
- Decision: acquire *before* connecting, so the `join` message carries the
  effective toggles — a denied cam boards as `camOn=false` and the roster is
  never wrong; no correction message needed. Consequence (per plan): joining
  with a toggle off never acquires that device, so it can't be turned on
  until rejoin — revisit only if it bothers us in practice.
- `App.tsx`: `join()` is async (acquire → connect); `LocalMedia` lives in a
  ref and is disposed on any socket close (camera light off at the join
  screen). Hud gets the media manager as a prop.
- `Hud.tsx`: mic/cam buttons flip the real tracks, send `mediaState`, and
  write the new toggles onto the self roster entry (stage precedent) so
  later consumers read a truthful roster.
- Server: `RoomState.updateMedia(id, micOn, camOn)`; `mediaState` handler
  stores + broadcasts to others (no echo — the sender's HUD already knows).
- Testing gotcha: `preview_click` on React buttons didn't reach the app's
  handlers this session; driving via `preview_eval` + native `.click()` and
  `form.requestSubmit()` worked.

Verified: typecheck green, 55 tests (2 new: updateMedia stores toggles,
unknown id returns false). Manual against live server + vite preview:
deny path — getUserMedia overridden to reject `NotAllowedError`, boarding
still lands aboard with MIC OFF and CAM OFF and the expected combined→solo
fallback warnings; granted path — fake canvas/web-audio tracks, boards
MIC ON / CAM ON and `playerJoined` seen by a scripted observer carries
`mic=true cam=true`; three HUD toggles flipped `track.enabled` each time
and the observer logged exactly three matching `mediaState` relays; a
late-joining scripted client's welcome roster carried the flipped state
(`alpha mic=true cam=false`), proving server storage; EXIT after the deny
boarding returned to join with no stray notice.

## 3.2 Shared: peer-pair state machine — done (2026-07-02)

- `shared/src/peer.ts`: pure reducer `transitionPeer(phase, event) →
  {phase, effects}` over `disconnected → connecting → connected →
  disconnected`. State is just the phase — peerId/initiator live in the 3.4
  manager, which keys one phase per peer id and performs the effects. No
  WebRTC imports.
- Events: `connectRequested {initiator}`, `signalReceived {data}`,
  `iceConnected`, `disconnectRequested`, `failed`. Effects:
  `createConnection {initiator}` (initiator makes the offer),
  `deliverSignal {data}`, `closeConnection`.
- Decisions: signals still deliver while `connected` (ICE trickles after
  connect) but drop while `disconnected` (stale after teardown — safe
  because WS ordering means a signal can't precede its `peerConnect`);
  `failed` emits `closeConnection` (the manager still holds an
  RTCPeerConnection to dispose) with no auto-retry — reconnection is
  server-driven pairing (3.3); duplicate connects and disconnects when
  already there are no-ops, so replayed/raced directives are harmless.

Verified: typecheck green, 64 tests (9 new: happy path with post-connect
trickle, initiator flag pass-through, teardown mid-connecting, duplicate
connect idempotence in both live phases, failure → disconnected +
closeConnection from both live phases, stale-signal drop, disconnect/failed
no-ops when disconnected, iceConnected ignored outside connecting,
reconnect-after-failure).

## 3.3 Server: pairing — done (2026-07-02)

- `server/src/pairing.ts`: pure `diffPairs(previousZoneId, newZoneId, others)
  → {connects, disconnects}` (peer ids relative to the subject — every
  membership change moves exactly one player, so affected pairs are always
  (subject, other)), plus `isInitiator(selfId, peerId)` = lexicographically
  lower id (plan §3). Lives in `server/` not `shared/` — server-only logic,
  same precedent as `state.ts`.
- `RoomState.updatePos` now also returns `previousZoneId` (feeds the diff);
  new `sessionOf(id)` for signal routing + pair directives.
- `server/src/index.ts`: `sendPairingDiff` delivers `peerDisconnect`s then
  `peerConnect`s to both members of each affected pair. Wired at all three
  membership-change sites: `pos` with `zoneChanged` (after the `zoneChanged`
  broadcast), `join` (after welcome/playerJoined — spawn is open space today,
  so no-op until spawn moves into a zone), and socket close (departed
  player's zone → null diffed against the remaining roster; only the
  surviving side is told, sent before `playerLeft`).
- `signal {to, data}` relays as `signal {from, data}` to the named target's
  socket only; unknown target or pre-join sender logged and dropped.
- Decision: no co-zone guard on signal relay — a candidate racing a zone
  exit is dropped by the client peer state machine anyway (3.2 stale-signal
  decision), and a guard would break legit trickle at boundary races.

Verified: typecheck green, 73 tests (8 new on `diffPairs`/`isInitiator`:
enter with 2 occupants → 2 connect pairs, leave → disconnects, zone→zone
switch, other-zone/open-space players ignored, no-transition no-op, null is
never a pairable zone, close-handler shape, initiator asymmetry; 1 updated +
1 new on `updatePos` previousZoneId). Manual per plan (scripted, precedent
from 1.4/2.2): three ws clients against a live instance on port 3211 —
16/16 checks: open-space joins and first-into-empty-zone silent; second
entrant forms one pair with complementary initiator flags on both sides;
third entrant gets 2 connects while both occupants get 1; signal relayed to
the named peer only (no echo, no third-party copy, unknown target dropped
server-side); zone→zone switch disconnects all old pairs on both sides;
abrupt socket close mid-zone notifies the co-zoned survivor only; leaving
an empty-of-others zone is silent.

## 3.4 Client: WebRTC wiring — done (2026-07-02)

- `client/src/media/iceConfig.ts`: the one ICE config module — public Google
  STUN today; the server-minted TURN credentials slot in here at 5.4.
- `client/src/media/peerManager.ts`: `PeerManager` — the impure layer for the
  3.2 machine. One entry per peer id (`{phase, RTCPeerConnection, queue,
  audio}`); every input (`connect`/`disconnect`/`signal`/`dispose`) goes
  through `transitionPeer` and the manager performs the emitted effects.
  `createConnection`: builds the pc from `iceConfig`, attaches all local
  tracks, initiator creates/sends the offer; `deliverSignal`: answers an
  offer, absorbs an answer/candidate; `closeConnection`: detaches handlers,
  closes, drops the remote stream. Remote streams surface in a public
  `remoteStreams` map keyed by peer id (3.5 tiles read it).
- Signal payloads are JSON-safe type aliases (`{kind: "description", sdpType,
  sdp}` / `{kind: "candidate", candidate, sdpMid, sdpMLineIndex}`) — DOM
  interfaces don't satisfy the protocol's `z.json()` type — with a runtime
  guard that drops malformed payloads. End-of-candidates (null) is not sent.
- Async signaling work is serialized per pair on a promise queue (an answer
  racing trickled candidates would otherwise interleave `setRemoteDescription`
  and `addIceCandidate`); a step that throws dispatches `failed` for the pair.
- Decision: the initiator adds `recvonly` transceivers for kinds missing from
  the local stream (denied device, joined with toggle off) — otherwise its
  offer would carry no m-line for that kind and the peer's media could never
  flow back. The answerer needs nothing: its m-lines mirror the offer.
- Decision: remote audio plays through a hidden `Audio` element per peer,
  owned by the manager — 3.5's tiles are the *video* surface; without
  playback here, audio wouldn't be audible and the 3.4 verify would be
  meaningless. `connectionState` transitions are console-logged (the verify
  instrument). Only `failed` is terminal (`disconnected` can self-recover);
  reconnection stays server-driven (3.3), no client retry.
- `connection.ts`: `peerConnect`/`peerDisconnect`/`signal` now dispatch to
  optional handlers (no roster touch, no `onRosterChange`); the unhandled-type
  default is gone — the switch covers the full protocol.
- `App.tsx`: `PeerManager` built per join from `media.stream`, sending signals
  through `connRef`; torn down in `onClose` — EXIT closes the socket, so drop,
  server death, and EXIT all converge on the same teardown path.

Verified: typecheck green, 73 tests (no new pure logic — the machine was
tested in 3.2; this step is deliberately all impure glue). The plan's verify
wants two machines; same-host scripted proof ran instead (playwright, fake
media devices, real offer/answer/ICE through the live relay), 13/13 checks:
fake mic+cam boards MIC ON/CAM ON; alone in a zone creates no connection;
second entrant → one pc each, both reach `connected` with complementary
offer/answer roles; inbound-rtp shows audio+video bytes flowing both ways;
walking out closes both pcs; re-entering reconnects with a fresh pair; EXIT
mid-call closes both sides; no malformed-signal warnings, no page errors.
Denied-device variant (getUserMedia rejecting on one side, retried until it
drew the initiator role): trackless offerer still received the peer's
audio+video via the recvonly transceivers. **Remaining for the M3 gate
(3.7): the real two-machine/two-network run — same-host WebRTC hides NAT
issues, and headless fake audio can't prove audible playback.**

## 3.5 Client: video tiles — done (2026-07-02)

- `client/src/ui/Tiles.tsx`: top-center tile row — self first (label "You",
  own stream), then co-zone occupants in join order (roster Map insertion
  order = server join order, per the 1.4 roster tests). Cam-on renders a
  `<video>`; cam-off (or remote stream not yet arrived) renders initials —
  prototype rule, first 2 chars uppercased — with the CAM OFF caption only
  when actually off; MUTED badge from roster `micOn`. Open space renders
  nothing (`zoneId === null` → null; connections don't exist there by
  construction). Geometry/colors copied from the prototype tile markup
  (150px tile, 94px video, 11px radius, footer dot+label row); the speaking
  dot/border stay at idle values until 3.6, tile-in animation left for 4.3.
- Decision: every tile `<video>` is muted — remote audio already plays
  through the peer manager's hidden `Audio` element (3.4) and an unmuted
  tile would double it; the self tile must not feed back. Tiles are the
  *video* surface only.
- Reactivity (canvas reads state per frame, but React needs pokes):
  `Connection.onRosterChange` now passes the message type (`RosterChange`)
  so App bumps a version counter for everything except the 15Hz `pos`
  stream; `PeerManager` gained an optional `onStreamsChanged` callback fired
  when `remoteStreams` gains/loses an entry; `Hud.applyToggles` reports self
  mic/cam flips up via a new `onMediaChanged` prop. All three feed one
  `setAvVersion` bump in App.

Verified: typecheck + 73 tests green (pure logic unchanged — the plan's
verify is manual). Scripted playwright run (3 headless chromium contexts,
fake media devices, own server instance on 3211-style isolated port, ws
port rewritten via init script), 24/24 checks: no tile row in open space;
alone in MED BAY shows exactly one "You" tile with live video; all three
co-zoned see 3 tiles, self first, remotes in join order (ava/ben/cal each
saw the correct complementary orders); both remote tiles carry live video
(videoWidth > 0); ben's mic toggle shows MUTED on his tile in all three
browsers (and nowhere else) within 400ms; cam toggle flips his tile to
initials + CAM OFF everywhere incl. his own self tile, and back; cal
walking out clears his row entirely while ava/ben drop to 2 tiles; zero
page/console errors in all three browsers. Screenshot confirms the row
top-center over the canvas with the HUD intact.

## 3.6 Speaking detection — done (2026-07-02)

- `client/src/media/speaking.ts`: `SpeakingDetector` — AnalyserNode
  (fftSize 1024) on the local stream, polled every 80ms: time-domain RMS vs
  threshold 0.04, hold 400ms (speaking stays on until the signal has been
  below threshold that long, so inter-word gaps don't flicker). Emits boolean
  changes only — the change-plus-hold cadence *is* the send throttle.
  `create()` returns null when the stream has no mic track (denied/absent/
  joined mic-off — that track can't appear until rejoin per decision 8, so
  no detector either). Threshold/hold/poll numbers are ours — the prototype
  fakes speaking with `Math.random()`, so there was nothing to copy.
- Mute gating: the detector reads `track.enabled` directly each poll — a
  mute forces not-speaking on the next poll with zero wiring to the hud
  (a disabled track also renders silence, so this is belt and braces).
- `App.tsx`: detector built per join next to the peer manager; its onChange
  sends `speaking {on}`, writes the self roster entry, and bumps the tile
  rerender — canvas ring and self tile light from the same local detection.
  Disposed in onClose before LocalMedia (stop polling before the track dies).
- Server: `RoomState.updateSpeaking`; `speaking` handler stores + broadcasts
  to others (no echo — the speaker detected it locally, mediaState pattern).
  The switch's `default` arm is gone: every client message type is handled.
- Render: `draw.ts` avatars take `speaking`/`inZone` + the frame time —
  pulsing accent ring `rgba(accent,.55)` lw 2 radius `18 + 2·sin(t/170)`
  between shadow and self-ring (prototype numbers + order). Ring gates on
  the roster `zoneId` (server-authoritative, 2.2 precedent) rather than the
  prototype's positional `zoneAt`. Prototype renders the ring for speakers
  in *any* zone, not just yours — followed the prototype. `Tiles.tsx` lights
  the tile border and footer dot in accent from the same roster flag.
- Not done, deliberately: the prototype's mic-off red dot on avatars is in
  no plan step — left for the 4.3 visual-match pass. Speaking sends are not
  gated on being in a zone: they're rare, and relaying them everywhere keeps
  roster flags truthful when a speaker crosses a boundary mid-word.

Verified: typecheck green, 75 tests (2 new: updateSpeaking stores + roster
reflects, unknown id false).

## 3.7 A/V smoke checklist — written (2026-07-02), gate run pending

- `notes/checklists/av-smoke.md`: the 3.1–3.6 manual checks as nine
  repeatable items — denied-device boarding, shared-zone connect, teardown
  on exit, re-enter reconnect, no connections in Open Space, instant mute,
  cam-off tile, speaking ring, 3-person mesh — each with steps and explicit
  pass criteria, plus a recording section. Doubles as the base for the 5.5
  production smoke.
- Setup section captures the two cross-machine traps found in 3.1/3.4 and
  the vite config: vite binds localhost only (`npm run client:dev -- --host`
  for LAN), and `http://<LAN-IP>` is an insecure origin so getUserMedia is
  absent without Chrome's `--unsafely-treat-insecure-origin-as-secure` flag
  (or an https tunnel). The client's hostname-relative ws URL (1.5) means
  no server-side change is needed.
- **M3 gate not yet passed**: the gate is running the checklist with 2–3
  clients, at least one on a different machine/network, with real mics and
  audible playback — this needs human ears and second hardware, so it must
  be run by hand. Every check has a same-host scripted precedent from
  3.1–3.6; the gate run adds the NAT path and real audio. The plan's verify wants real talking on a
second machine (left for the 3.7 gate run); scripted equivalent ran instead
(playwright precedent from 2.3–3.5): two headless browsers with
gain-controllable oscillator mics in MED BAY, 17/17 checks — silence shows
no accent dot/border and no canvas ring; a 0.5-gain tone lights the
speaker's self dot+border, the remote's tile for them (and nobody else's),
and puts 176 green ring pixels in the r 15–22 band around the avatar;
silence clears all three after the hold; muting mid-tone kills speaking on
both sides and shows MUTED remotely; a 0.02-gain hum (RMS ~.014) never
trips it over 1.5s; zero page/console errors. Latency runs: speak→remote
dot lit 62–100ms, mute→remote idle 76–92ms over three rounds (localhost —
a real network adds one RTT, still inside the ~200ms target).

## 4.1 Theme wiring — done (2026-07-03)

- `theme.json` at repo root: prototype palette — `#05070D` bg, `#3EE08A`
  accent (plus the prototype's four `accentOptions` for the gate test),
  IBM Plex Mono / Space Grotesk font stacks, a `canvas` section (star,
  floor hull/deck fills, deck stroke, grid, avatar label bg/text) and a
  `ui` section whose keys ARE the CSS variable names (kebab-case, no `--`).
- `client/src/theme.ts`: imports the JSON (client tsconfig gained
  `resolveJsonModule`; vite's fs.allow covers the repo root because the
  workspace lockfile lives there), exports `theme` + the `rgba(hex, a)`
  helper (moved out of draw.ts — one copy), and `applyTheme()`, which sets
  `--bg`/`--accent`/`--accent-dim` (rgba(accent,.5), the toast border)/
  `--font-mono`/`--font-sans` plus every `theme.ui` entry on `:root`.
  Called in `main.tsx` before the react root mounts.
- Consumers: `draw.ts` reads `theme.*` directly (canvas can't use CSS vars);
  `Hud.tsx`/`Tiles.tsx` use `var(--…)` in their inline styles — CSS vars
  work in `font:` shorthand, so the mono/sans stacks flow through too (the
  hud previously used generic `monospace`/`sans-serif`; it now gets the
  prototype stacks, though no webfont is loaded until 4.3). `index.html`
  body uses `var(--bg/--text, fallback)` — the hex fallbacks there only
  cover the pre-JS paint, theme.json stays authoritative.
- Scope line drawn: every hex moved into theme.json plus the plan-listed
  colors (floor strokes, avatar labels); neutral one-off `rgba()` shades
  (washes, shadows, airlock marker, off-state whites) stay inline — they're
  not hex and not in the plan's theme list. `#FF8A8A` → `--danger`; its
  `rgba(255,77,77,…)` border/bg companions stay inline for now.
- Gate check ran scripted (playwright precedent): boarded with accent
  `#3EE08A`, flipped theme.json to `#4EE1FF`, reloaded — `--accent`/
  `--accent-dim` read cyan and the canvas (zone strokes/labels, YOU label)
  rendered cyan with zero code changes and zero console errors; reverted.

Verified: typecheck green, 75 tests green, no hex in client/src outside
the theme module (grep).

## 4.2 Decor — done (2026-07-03)

- `shared/src/map.ts`: decor `z.never()` replaced with a discriminated union
  (on `type`) of the eight plan tags — `screen`, `consoleStrip`, `crate`,
  `bed`, `cross`, `roundTable`, `seat`, `desk`. Each variant carries exactly
  the geometry the prototype's `drawDecor` hardcoded (rect for screen/bed/
  desk, point+`s` for crate, point+`r` for roundTable/seat, point+`count`/
  `gap` for the console row, bare point for the cross, which is centered);
  colors and inner details (pillow, indicators, status lights) stay
  client-side.
- Modeling decisions: the six bridge consoles are ONE `consoleStrip`
  (630, 112, count 6, gap 60) matching the prototype's loop; bridge chairs
  (r 10) and lounge seats (r 9) are the same `seat` type differing only by
  radius; consoles and the lounge table share the prototype fill `#16233C`,
  stored once as `decor.panel`.
- `map.json`: 20 items in prototype draw order — screen, consoleStrip,
  2 bridge seats, 2 beds, cross (323, 494 = the two bars' shared center),
  6 crates, roundTable, 4 lounge seats, 2 desks — coordinates verbatim from
  `drawDecor`.
- `theme.json` `canvas.decor`: screen, panel, seat, bed, bedPillow, cross,
  crate, crateStroke, desk, deskStroke (4.1 rule: no hex outside the theme
  module). Accent-derived shades (screen glow strip, console indicators,
  table rim, desk status lights) computed via `rgba(theme.accent, …)` with
  the prototype's pulse phases (`t/600`, `t/500 + x`).
- `client/src/render/decor.ts`: one drawer per union tag in a record keyed
  by `DecorItem["type"]` (exhaustiveness checked by the mapped type);
  `drawDecor(ctx, map.decor, t)` called from `draw.ts` between the floor
  grid and the zone overlays (prototype order — props sit under zone tints).
- Gotcha: the other session's dev server (tsx watch) does NOT reload on
  `shared/` or `map.json` changes — shared resolves through a symlink in
  node_modules (ignored by the watcher) and map.json is a readFileSync, so
  a stale server kept serving `decor: []` until a `server/src` touch forced
  a restart.

Verified: typecheck green, 76 tests (map.json decor parses with the exact
per-type census 1/1/6/2/1/6/1/2, unknown decor tag rejected, crate missing
`s` rejected). Manual via preview against the live server: boarded and
zoomed out — bridge viewscreen bar + glow strip, 6 consoles with accent
indicators, 2 bridge chairs, med-bay beds with pillows + red cross, both
ops desks with pulsing status lights, lounge table with accent rim + 4
seats, and all 6 amber-outlined cargo crates render in place; no console
errors (only the known headless getUserMedia denial warnings).

## 4.3 UI styling pass — done (2026-07-03)

- Join screen (`App.tsx`): prototype card verbatim — gradient + blur overlay,
  380px card, "SS MERIDIAN · CREW LINK" eyebrow in accent, "Board the ship"
  h1 + copy, CALLSIGN label, styled input ("e.g. Nova" placeholder, accent
  focus border), mic/cam checkbox rows replaced with prototype toggle
  *switches* (44×25 pill, sliding knob, state hints "Join with mic live" /
  "Join muted" etc.), BOARD SHIP → with ready states (accent bg + dark text
  when named, dim otherwise). The socket-close notice (not in the prototype)
  restyled as a small uppercase mono danger line on the card.
- `Hud.tsx`: added the missing top-left legend ("SS MERIDIAN · DECK 1" +
  "WASD / ARROWS — MOVE · SCROLL — ZOOM"); toolbar to exact prototype
  numbers — 44px mic/cam buttons with 8px state dots and red off palettes,
  1×30 dividers, name/zone block (min-width 130), 44×44 zoom, EXIT, backdrop
  blur 14 + shadow; pill and toast exact fonts/colors; prototype z-order
  (legend 15, pill 18, tiles 20, toast 25, toolbar 30).
- `Tiles.tsx`: tilein entrance animation, border-color/dot transitions. The
  prototype's fake-video effects (vidshift gradient, scan line, initials over
  the video) are deliberately absent — real streams render instead.
- `client/src/styles.css` (new, imported by main): box-sizing, placeholder
  color, tilein/toastin keyframes, hover states (media buttons brightness,
  zoom/EXIT backgrounds, BOARD SHIP brightness) and the callsign focus
  border — the states inline styles can't express. `!important` where a rule
  must beat an inline base style. Needed `client/src/vite-env.d.ts`
  (`vite/client` types) for the CSS side-effect import to typecheck.
- `index.html`: Google Fonts link for IBM Plex Mono + Space Grotesk (the
  webfonts deferred from 4.1) and body font-family var(--font-sans).
- Avatar mic-off red dot (deferred from 3.6): `AvatarEntity` gained `micOn`;
  `draw.ts` draws the prototype's 4px `#FF5D5D` shoulder dot with dark
  stroke; colors as `theme.json` `canvas.micOffDot`/`micOffDotStroke`.
- `theme.json`: ui gains `dot-on`/`dot-off` (toolbar state dots — prototype
  hardcodes green/red regardless of accent) and `card-bg`; `surface-bg`
  corrected .88 → .86 (prototype toolbar). `applyTheme()` also sets
  `--accent-strong` (rgba(accent,.85), the switch-on track). One-off neutral
  rgba() shades stay inline per the 4.1 scope line; no-hex grep still clean.
- Gotcha: one long-lived preview page froze its rAF loop (canvas stopped
  painting, no error) — not reproducible after reload; movement/pairing all
  fine on a fresh page. Watch for it recurring before blaming app code.

Verified (M4 gate): typecheck green, 76 tests.

## 5.1 Shared password — done (2026-07-03)

- Announce mechanism: the plan offered a WS-handshake probe or a `/config`
  HTTP endpoint; chose the handshake — the server sends
  `config {passwordRequired}` as the first message on every connection. The
  server today is a bare `WebSocketServer` (no HTTP server to route on), and
  a cross-port fetch from vite to :3000 would need CORS; a WS probe has
  neither problem. Cost: the join screen opens one short-lived probe socket
  on mount (server close handler already tolerates never-joined sockets).
- `shared/src/protocol.ts`: `join` gains optional `password` (omitted on
  open rooms — `JSON.stringify` drops undefined); new server messages
  `config {passwordRequired}` and `joinRejected {reason: "wrongPassword"}`
  (reason is a literal enum — the typed rejection; client maps it to copy).
- Server: `ROOM_PASSWORD` env read at startup, empty string counts as unset
  (open room). The join gate is a pure helper `passwordAccepted(roomPassword,
  provided)` in `server/src/auth.ts` (pairing.ts precedent — the testable
  core of the join handler). Wrong/missing password → `joinRejected`, then
  the server closes the socket; the player never enters `RoomState`.
- Client: `connection.ts` ignores `config` on the boarding socket (its join
  was already sent on open; the probe consumed the announce) and hands
  `joinRejected` to a new optional `onJoinRejected` handler. `App` flags the
  rejection in a ref so the close that follows shows "wrong password"
  instead of "connection closed" (leavingRef pattern); the flag resets on
  every close. `JoinScreen` probes on mount with a raw short-lived
  WebSocket; probe failure (server down) leaves the field hidden and
  boarding surfaces the normal connection error. ACCESS CODE field
  (type=password, callsign styling/class) renders only when required; BOARD
  SHIP additionally demands a non-empty code (our rule — the prototype has
  no password; an empty code could only be rejected anyway).

Verified: typecheck green, 85 tests (5 new on the acceptance matrix incl.
empty-string-vs-real-password; protocol round-trips for join-with-password/
config/joinRejected, unknown rejection reason refused). Scripted ws checks
(1.4 precedent) against own instances: password server 8/8 — config first
message with `passwordRequired: true`, wrong and missing passwords get the
typed rejection then a server close with no welcome leak, correct password
welcomes; open server 3/3 — announce false, passwordless join boards.
Browser: preview against the open port-3000 server shows no ACCESS CODE
field and boards normally (unset-env check); playwright against the
password server (ws port rewritten pre-load — the client hardcodes :3000)
9/9 — field appears from the probe, BOARD SHIP disabled until a code is
entered, wrong code lands back on the join card with the error and a
retry-able field, correct code boards and clears the notice, zero page
errors. Preview run against live
server + vite: join card matches the prototype (screenshot), BOARD SHIP
flips dim → accent when a name is entered (computed bg `rgb(62,224,138)`,
text `rgb(5,7,13)`, IBM Plex Mono loaded); boarding with denied devices
shows red MIC OFF / CAM OFF states with dots; legend, pill, and toolbar
render with exact computed values (pill 10px mono .12em on rgba(10,15,28,.72),
toolbar .86 bg + blur(14px) + 15px radius, zoom 44×44 17px Space Grotesk,
EXIT red palette); walking into OPS POD A lights the glow, swaps the label
to accent, hides the pill, and raises the tile (initials "NO", CAM OFF,
MUTED badge); leaving restores pill/label and the LEFT ZONE toast is in the
DOM 300ms after exit (screenshots too slow for its 2s life); avatar shows
the red mic-off shoulder dot; EXIT returns to the styled join card with no
notice; zero page errors. Structural deltas from the prototype, all
deliberate: no ship behind the join overlay (no connection pre-join), real
video instead of fake gradients, the notice line, and real device states.

## 5.2 Reconnect with grace window — done (2026-07-03)

- Protocol: `welcome` gains a required `resumeToken`; new client message
  `resume {token, micOn, camOn}` (toggles are the effective ones after
  re-acquiring media, decision-8 pattern); `joinRejected.reason` becomes
  `enum(wrongPassword, resumeExpired)`.
- Server state (`state.ts`, the unit-tested core): `Session` carries a
  nanoid `resumeToken` issued at join; `park(id, now)` moves a dropped
  player out of the roster into a grace map keyed by token
  (`expiresAt = now + graceMs`, constructor arg — `GRACE_MS` env on the
  server, default 30s, PORT-override precedent); `resume(token, socket, now)`
  re-admits within the window (expired entries are dropped so a second try
  can't succeed); `sessionOfToken` finds a live session by token;
  `sweepParked` is pure memory hygiene on a server interval (resume checks
  expiry itself). `leave()` is gone — park replaced its only caller.

## 5.3 VPS deploy — done (2026-07-03)

- Droplet: user-provisioned DigitalOcean droplet
  (Ubuntu 24.04, 1GB RAM, ssh as root).
  Base setup run over ssh: Node 22 (nodesource), Caddy 2 (cloudsmith apt),
  `workspace` no-login system user, ufw allowing only OpenSSH/80/443 — port
  3000 is never public, Caddy is the sole entry.
- DNS: `<domain>` A record → the droplet (user had already pointed it).
- Client WS URL (`App.tsx`): dev keeps `ws://hostname:3000`; production is
  protocol-derived `wss://${location.host}/ws` behind `import.meta.env.DEV`.
  Vite statically tree-shakes the dev branch out of the bundle (verified by
  grepping the deployed asset — only the `/ws` form is present).
- Server runs the TS sources via tsx under systemd — no build step, because
  `shared` is raw TS and a server compile would drag a shared build with it;
  tsx is already in the plan's dependency list, so it moved from server
  devDependencies to dependencies (it's the production runtime now) and a
  `start` script was added. `deploy/workspace.service`: User=workspace,
  WorkingDirectory=server, EnvironmentFile=/etc/workspace.env (PORT +
  ROOM_PASSWORD, VPS-only, never in git), Restart=always. `map.json` resolves
  via the source-relative URL, so /srv/workspace/map.json lands correctly.
- `deploy/Caddyfile`: `handle /ws` → reverse_proxy 127.0.0.1:3000 (websocket
  upgrade is automatic); everything else is file_server on client/dist with
  the SPA try_files fallback. Let's Encrypt issuance is Caddy-automatic.
- `deploy/deploy.sh`: builds the client locally (the 1GB droplet is too small
  to trust vite builds), `rsync -azR` of server+shared sources, client dist,
  map.json, and both configs (--delete sweeps only inside transferred dirs,
  so the remote node_modules survives), then `npm ci -w server --omit=dev`
  (workspace-scoped ci pulls shared's zod too), config install, daemon-reload,
  restart workspace + reload caddy. New root `README.md` documents dev,
  deploy, and the one-time VPS setup for rebuilds.
- ROOM_PASSWORD: generated, lives only in /etc/workspace.env (chmod 600).

Verified: typecheck green, 95 tests, client builds. Production: HTTPS 200 on
`https://<domain>` + hashed asset with a valid LE cert; systemd + caddy both
active, server listening on 3000 behind ufw; scripted ws smoke against
`wss://<domain>/ws` 6/6 — config announces passwordRequired, wrong password
gets the typed rejection and no welcome, two concurrent clients board with
map + roster and see each other's playerJoined. Dev regression: preview
boards against a local server unchanged (WS_URL dev branch intact). The
plan's "two clients on different networks with A/V" half needs second
hardware — it's the 5.5 production smoke (and 5.4 adds TURN for hostile
NATs; A/V today is STUN-only, "NAT permitting" per the plan).
- Decision — the "away" flag is server-internal only: spectators get the
  normal `peerDisconnect`/`playerLeft` on the drop and `playerJoined` +
  pairing connects on resume (extracted `parkAndAnnounce`, shared by the
  close handler and takeover). No away field on `Player`, no ghost avatars,
  no pairing/signal-relay guards for half-present players.
- Decision — takeover: a resume whose token maps to a *live* session (wifi
  kill the heartbeat hasn't noticed; both sides reconnect racing it)
  force-parks that session with the same announcements, terminates the stale
  socket, and proceeds as a normal resume. The close handler guards on
  `session.socket !== socket` so the stale socket's late close event can't
  park the freshly resumed session.
- Resume applies the message's mic/cam and resets `speaking`; same token
  survives across resumes (echoed back in the new welcome). Position, hue,
  id, name, zone all ride along on the parked `Player`. Resume needs no
  password: the token was only ever issued past the 5.1 gate.
- Client: `Connection` now takes the initial message (join or resume) and
  exposes `resumeToken` from the welcome. `App` stores
  `{token, micOn, camOn}` in sessionStorage (key `resume`) on every welcome,
  updates the toggles on HUD flips, and clears it on EXIT (a deliberate
  leave forfeits the grace window) and on `resumeExpired`. Unexpected close
  → `resuming` phase (minimal "SIGNAL LOST · RECONNECTING" screen) and a
  retry loop driven entirely through onClose: delays 1s/2s/4s/8s… (cap 8s),
  give-up deadline 45s (grace + slack for the server to notice the drop).
  A refresh inside the window resumes immediately on mount — supersedes
  decision 10's fresh-join semantics, as planned. Each attempt re-acquires
  media with the stored toggles, rebuilds PeerManager/SpeakingDetector, and
  A/V returns via the normal pairing flow.

Verified: typecheck green, 95 tests (10 new: park/resume/expiry/unknown-
token/re-park-same-token/sweep + distinct tokens; resume + welcome-token +
resumeExpired protocol round-trips incl. missing-token and token-less
welcome rejected). Scripted ws run (1.4 precedent) against an own instance
(GRACE_MS=3000) 17/17: welcome carries the token; drop mid-zone breaks
pairs and despawns; resume within the window restores id/hue/position/zone
on a new socket, applies the new toggles, resets speaking, re-pairs with
complementary initiator flags; takeover of a live session terminates the
stale socket, cycles despawn/respawn once, and survives the stale close
event; expired and bogus tokens get the typed rejection, a close, and no
welcome leak. Browser (preview + wire observer): boarded, walked to
(419, 800), reloaded — landed straight aboard with the same id/hue/position
and no join card; a scripted token takeover force-dropped the page and a
MutationObserver caught the full cycle — "SIGNAL LOST · RECONNECTING"
1ms after the drop, back aboard 1010ms later via the first 1s retry
(interval-based recording missed it: background-tab timer throttling);
dead-token reload fell back to the join card with "session expired" and a
cleared token; EXIT cleared the token and a reload stayed on the join card;
zero page errors throughout. The plan's true wifi-kill run needs hardware
by hand (5.5 production smoke covers it).

## 5.4 coturn — done (2026-07-03)

- `server/src/turn.ts`: `mintIceServers` — STUN always; when `TURN_SECRET` +
  `TURN_HOST` are set (both unset in dev), a TURN entry in coturn's
  static-auth-secret format: username `<expiry unix>:meridian` (TTL 12h),
  credential base64(HMAC-SHA1(secret, username)). Minted fresh on every
  welcome (join *and* resume — a resume's old credentials may be near expiry).
- Protocol: `welcome` gains a required `iceServers` array (`iceServerSchema`:
  urls + optional username/credential). Client `Connection` stores it;
  `App.onWelcome` feeds it to `client/src/media/iceConfig.ts`, which is now
  `setIceServers()` + `rtcConfig()` — read per-pair at RTCPeerConnection
  construction. `?relay` in the client URL forces
  `iceTransportPolicy: 'relay'` (the step's debug flag).
- TURN urls minted: `turn:host:3478?transport=udp`, `turn:3478?transport=tcp`,
  `turns:host:5349?transport=tcp` (TLS for networks that only pass TLS).
- Deploy: `deploy/turnserver.conf` (static-auth-secret, realm <domain>,
  relay ports 49152-65535, no-cli, denied-peer-ip for loopback/private
  ranges so the relay can't probe the droplet). The secret stays VPS-only:
  deploy.sh appends `static-auth-secret=` from `/etc/workspace.env` on the
  droplet (escaped `\$` so it never expands locally) into
  `/etc/turnserver.conf` (640 root:turnserver).
- TLS certs: coturn can't read caddy's LE storage or hot-reload certs —
  `deploy/turn-cert-sync.{sh,service,timer}` copies the cert into
  `/etc/coturn/certs` daily and restarts coturn only on change.
- One-time VPS setup (done + README'd): `apt-get install coturn`,
  `TURN_SECRET` (openssl rand) + `TURN_HOST=<domain>` appended to
  `/etc/workspace.env`, ufw 3478 + 5349/tcp + 49152:65535/udp.

Verified: typecheck green, 99 tests (3 new minting: STUN-only without config,
HMAC/expiry/urls exact, expiry advances with time; welcome round-trips with
iceServers and rejects without). Droplet: coturn active, zero errors since
restart, 5349 TLS listening with the synced cert, timer enabled. Scripted ws
join against wss://<domain> — welcome carries STUN + TURN, TTL 43200s, valid
base64 credential. Forced-relay browser run (real client at `?relay` + an
in-page scripted peer joining the med zone over ws with its own
relay-restricted RTCPeerConnection + canvas video): the app's offer SDP
advertised relay-only candidates (flag works), pairing connected, nominated
pair relay↔relay both at the droplet IP with relay ports inside the ufw range
and bytes flowing. Separate loopback restricted to `turns:5349` connected
with relayProtocol tls (cert sync works). Incidental 5.2 regression: two
mid-test page reloads resumed seamlessly. The "two clients on hostile
networks" half needs second hardware — 5.5 production smoke, as with 5.3.

## 5.5 Production smoke — scripted run passed (2026-07-03), human half pending

- Ran the full scriptable production smoke against `https://<domain>` (live
  droplet, real Caddy/coturn/systemd stack): 84/84 checks across four
  scripted suites (node ws client + playwright headless chromium with fake
  media devices, all scripts scratchpad-only per the 3.x precedent).
- ws layer (12): `config` announce first, missing and wrong passwords get the
  typed rejection then a close with no welcome leak, correct password
  welcomes with map + resume token + STUN/TURN entries carrying credentials.
- Two-client browser run (35): board with ACCESS CODE; alone in a zone =
  one "You" tile and zero pcs; co-zone pair reaches `connected` with
  audio+video inbound-rtp bytes both ways and two live `<video>` tiles;
  MUTED badge round-trip; CAM OFF round-trip with audio uninterrupted;
  walk-out closes both pcs and clears/drops tiles; open space creates no
  pc; re-enter reconnects fresh; mid-call reload resumes into the same zone
  with no join card and re-pairs; `?relay` client pair connects with the
  nominated candidate pair relay-type at the droplet IP; zero page errors.
- 6-person zone sanity (26): six clients mesh in OPS POD A — every client
  reaches 5 connected pcs and renders 6 tiles, sample client receives
  audio+video on all 5 pairs, zero page errors, and the server accepts a
  fresh join after everyone leaves. Degrades nowhere near crashing on the
  1GB droplet (server RSS ~56MB, zero journal errors, zero restarts).
- Network-kill recovery (11): CDP offline emulation on one side mid-call —
  the peer sees the pc close (server heartbeat parks the dropped player),
  ~20s outage, then resume restores the zone with no join card, a fresh
  pair connects, media flows; the SIGNAL LOST screen appeared during the
  cycle (caught by MutationObserver — with an emulated offline the client
  only notices the dead socket once the network returns, so it flashes
  <1s before the first retry resumes).
- Walk-route gotcha: spawn (330, 800) is on a plate whose top edge is
  y=730 and the connector plate starts at x=340, so holding plain `w`
  clamps forever — scripted walkers must go `w`+`d` (per-axis clamp slides
  up-right into the mid deck and OPS POD A).
- CDP harness gotchas (for future scripted runs): key events to a
  non-frontmost headless page are unreliable — `bringToFront()` before
  walking; and a keydown dispatched before the Stage mounts is never seen
  (CDP sends no key repeat), so hold keys in short press/release pump
  cycles rather than one long hold.
- **M5 gate not fully closed**: the scripted run can't prove audible
  playback, real-mic speaking rings, or genuinely hostile networks. Left
  for a human run of `av-smoke.md` against the production URL: 2–3 real
  clients with at least one on a different machine/network (phone hotspot
  or office VPN for the hostile-NAT case — TURN relay is already proven
  working), real talking for checks 2/6/8, a denied-camera boarding
  (check 1), and a real wifi kill mid-call. This is the same human half
  deferred from the 3.7 M3 gate.
