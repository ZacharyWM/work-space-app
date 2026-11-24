# Implementation Plan: Single-Level Virtual Office

Step-by-step build order for [plan.md](plan.md). Each step is a small,
committable unit with its own verification; a step is not done until its
verify passes, and no step starts before the previous one is done. Steps map
onto the five milestones (M1–M5) from the plan.

Conventions for every step:

- TypeScript strict; `npm run typecheck && npm test` green at the end of the
  step (once those scripts exist, step 1.1).
- One commit per step (or a few small ones). No step leaves the repo broken.
- Pure logic goes in `shared/` with Vitest tests. Anything touching
  WebRTC/media gets a manual check instead.
- The prototype (`notes/ClaudeDesignPrototype/Spaceship Virtual Office.dc.html`)
  is the reference for all geometry, colors, and behavior — copy its numbers,
  don't invent new ones.
- When finished, update `notes/001-beginnings/impl-progress.md` with what was done.

---

## Phase 1 — Walkable Ship (M1)

### 1.1 Monorepo scaffold

- Root `package.json` with npm workspaces: `client`, `server`, `shared`.
- Root `tsconfig.base.json` (strict, ES2022, bundler resolution); each
  workspace extends it.
- `shared/`: plain TS package, exports from `src/index.ts`.
- `server/`: Node + `ws` + `tsx` for dev; depends on `shared`.
- `client/`: Vite + React + TS template; depends on `shared`.
- Vitest configured at the root, picking up tests in `shared/` and `server/`.
- Root scripts: `dev` (server + client concurrently), `typecheck`, `test`,
  `build`.

**Verify**: `npm run typecheck`, `npm test` (one placeholder test), and
`npm run dev` boots both processes.

### 1.2 Shared: map schema + geometry

- `shared/src/map.ts`: types + zod schemas for `MapData` — floor plates
  (x, y, w, h, r), zones (id, name, rect), decor items (typed union, empty
  for now), spawn point. Parse function that validates and fails with a
  readable error.
- `shared/src/geometry.ts`: `inFloor(map, x, y)`, `clampMove(map, from, to)`
  (per-axis clamp, prototype behavior), `zoneAt(map, x, y)`,
  `validateZonesDisjoint(map)`.
- `map.json` at repo root: floor plates, zones, and airlock spawn copied
  verbatim from the prototype's `FLOORS`, `ZONES`, and player start
  (330, 800). Decor empty for now.

**Verify**: unit tests — points inside/outside floors, per-axis clamping at a
floor edge, zone hit-testing incl. boundaries, overlap validation rejects an
overlapping fixture, `map.json` parses.

### 1.3 Shared: protocol types

- `shared/src/protocol.ts`: zod-validated discriminated unions for all
  messages.
  - Client→server: `join {name, micOn, camOn}`, `pos {x, y}`,
    `mediaState {micOn, camOn}`, `speaking {on}`, `signal {to, data}`.
  - Server→client: `welcome {selfId, map, roster}`, `playerJoined`,
    `playerLeft`, `pos`, `mediaState`, `speaking`, `zoneChanged {id, zoneId}`,
    `peerConnect {peerId, initiator}`, `peerDisconnect {peerId}`,
    `signal {from, data}`.
  - `Player` shape: `{id, name, hue, x, y, zoneId, micOn, camOn, speaking}`.
- Encode/decode helpers (JSON + zod parse) used by both sides.

**Verify**: unit tests — round-trip encode/decode, malformed message rejected.

### 1.4 Server: presence

- `server/src/state.ts`: in-memory `Map<id, Player & {socket}>`.
- `server/src/index.ts`: HTTP + WS server. On startup: load `map.json`,
  run `validateZonesDisjoint`, fail fast.
- Handle `join`: assign nanoid id + avatar hue (spread hues, e.g. golden-angle
  increment), spawn position, reply `welcome` with map + roster, broadcast
  `playerJoined`.
- Handle `pos`: update state, broadcast to others (no echo).
- Handle socket close / ~5s heartbeat sweep: remove player, broadcast
  `playerLeft`.
- Ignore (log) unknown/invalid messages; never crash on bad input.

**Verify**: unit test the pairing-free state module (join/leave/roster);
manual: `wscat` (or a tiny script) joins, receives `welcome`, second
connection sees `playerJoined`/`pos`/`playerLeft`.

### 1.5 Client: join screen + WS connection

- Minimal unstyled join screen: name input, mic/cam toggle switches (state
  only — no getUserMedia yet), BOARD SHIP button disabled when name empty,
  Enter submits.
- `client/src/net/connection.ts`: WS client wrapper — connect on join, typed
  send/receive using shared protocol, store roster + self id.
- On socket drop: return to join screen (fresh-join semantics, decision 10).

**Verify**: manual — join from two tabs, server logs both; closing one tab
returns it to the join screen and the other receives `playerLeft`.

### 1.6 Client: canvas renderer + movement + camera

- `client/src/render/`: rAF loop drawing starfield (parallax stars), floor
  plates (double-border style from prototype), avatars (circle, visor, name
  label, drop shadow, y-sorted), airlock marker.
- DPR-aware canvas sizing with ResizeObserver.
- Movement: WASD/arrows (ignored while an input is focused), speed 255 px/s,
  `clampMove` from shared, throttled `pos` sends (~15/s, only when moved).
- Remote avatars interpolate toward their last received position.
- Camera: eased follow of self, wheel zoom 0.3–1.8 (exp factor from
  prototype), eased zoom.

**Verify (M1 gate)**: unit tests already cover clamp/schema; manual — two
browsers: both avatars visible, remote movement smooth, can't walk off
floor plates, zoom out shows the whole ship, close/rejoin works.

---

## Phase 2 — Zones (M2)

### 2.1 Server: zone membership

- On every `pos` update, compute `zoneAt`; when it changes, update the player
  and broadcast `zoneChanged`. Roster and `playerJoined` already carry
  `zoneId`.
- Transitions are instant (no debounce — noted risk, don't build it).

**Verify**: unit test — sequence of positions produces the expected
`zoneChanged` emissions (enter, leave, zone→zone switch, no emission when
staying put).

### 2.2 Client: zone rendering

- Draw zone rects: fill/outline in accent color, name + live occupant count
  (`NAME · 3`), glow + brighter stroke for the zone the local player is in.
- Occupant counts derived from roster `zoneId`s.

**Verify**: manual — two browsers walk between zones; counts and glow agree
in both at all times, including standing exactly on a boundary.

### 2.3 Client: zone HUD

- Bottom toolbar (functional, minimally styled): mic/cam toggle buttons
  (still local state only), display name, current zone label or
  "OPEN SPACE — PRIVATE", zoom −/+ buttons, EXIT (leave to join screen).
- Toasts: "ENTERED · {ZONE}" / "LEFT ZONE · COMMS CLOSED", ~2s auto-dismiss.
- Open Space pill top-center when `zoneId === null`.

**Verify (M2 gate)**: manual — labels, toasts, pill, and counts all track
zone walks in two browsers; EXIT returns to join and despawns the avatar.

---

## Phase 3 — A/V (M3)

### 3.1 Client: media manager

- `client/src/media/localMedia.ts`: on join, `getUserMedia` per the join
  toggles; handle deny / no-device by boarding without that track (decision
  8). Mic/cam toggles flip `track.enabled` and send `mediaState`.
- Server relays `mediaState` and stores it on the player.

**Verify**: manual — join with cam denied still boards; toggles update
`mediaState` in the other browser's roster (log it).

### 3.2 Shared: peer-pair state machine

- `shared/src/peer.ts`: pure state machine per peer pair —
  `disconnected → connecting → connected → disconnected` — with events
  (`connectRequested`, `signalReceived`, `iceConnected`, `disconnectRequested`,
  `failed`) and emitted effects. No WebRTC imports; fully unit-testable.

**Verify**: unit tests — happy path, teardown mid-connecting, duplicate
connect requests are idempotent, failure returns to disconnected.

### 3.3 Server: pairing

- On any zone membership change (move, join, leave, disconnect), diff each
  affected pair: newly co-zoned → `peerConnect` to both (initiator = lexico-
  graphically lower id, decision from plan §3); no-longer-co-zoned →
  `peerDisconnect` to both.
- Relay `signal` messages between the named peers only.

**Verify**: unit tests on the pairing diff (enter zone with 2 occupants →
2 connect pairs; leave → disconnects; disconnect mid-zone → disconnects);
manual — logs in two browsers show matching connect/disconnect directives.

### 3.4 Client: WebRTC wiring

- `client/src/media/peerManager.ts`: owns one `RTCPeerConnection` per active
  pair, driven by the shared state machine. Initiator creates the offer;
  ICE/SDP over `signal`. ICE config: public STUN (Google) for now, read from
  one config module (TURN slots in here at 5.4).
- Attach local tracks; surface remote streams keyed by peer id.
- Teardown on `peerDisconnect`, socket drop, and EXIT.

**Verify**: manual, **two machines** (same-host WebRTC always connects and
hides NAT issues) — walk into a shared zone: audio+video flow both ways;
walk out: connection closes (check `connectionState` logs); re-enter:
reconnects.

### 3.5 Client: video tiles

- Top-center tile row: self first (label "You", own stream muted-playback),
  then co-zone occupants ordered by join time. Cam-on: `<video>` with the
  remote stream; cam-off: initials + CAM OFF state; MUTED badge from
  `mediaState`.
- Tiles only render while in a Zone; Open Space renders none (connections
  don't exist there by construction).

**Verify**: manual — 3 participants in one zone see 3 tiles each; mute/cam
badges update across browsers instantly; leaving the zone clears tiles.

### 3.6 Speaking detection

- `client/src/media/speaking.ts`: AnalyserNode on the local mic, RMS vs
  threshold with hold time; emit boolean changes, throttled, only while
  unmuted; send `speaking`.
- Render: pulsing avatar ring (accent) and tile border/dot for anyone
  speaking in your zone; self included via local detection.

**Verify**: manual — talking lights your ring/tile on the other machine
within ~200ms; muting kills it; background hum doesn't flicker it.

### 3.7 A/V smoke checklist

- Write `notes/checklists/av-smoke.md` capturing the manual checks from
  3.1–3.6 as a repeatable list (shared-zone connect, teardown on exit,
  instant mute, cam-off tile, speaking ring, no connections in Open Space,
  3-person mesh).

**Verify (M3 gate)**: run the full checklist with 2–3 clients, at least one
on a different machine/network. All items pass.

---

## Phase 4 — Spaceship Polish (M4)

### 4.1 Theme wiring

- `theme.json` at repo root: background, accent, floor/stroke colors, avatar
  label colors, fonts, UI CSS variable values (palette from the prototype:
  `#05070D` bg, accent options, IBM Plex Mono / Space Grotesk).
- Client loads it once: sets CSS variables on `:root` for React UI; canvas
  renderer reads colors from the same object (no hardcoded hex outside the
  theme module).

**Verify**: change accent in `theme.json` → UI and canvas restyle with no
code change (M4 gate item).

### 4.2 Decor

- Extend the map schema's decor union: `consoleStrip`, `screen`, `crate`,
  `bed`, `cross`, `roundTable`, `seat`, `desk` — geometry in `map.json`
  copied from the prototype's `drawDecor` coordinates.
- `client/src/render/decor.ts`: one draw function per decor type, keyed by
  the union tag; glow pulses driven by time + accent, as in the prototype.

**Verify**: unit test — `map.json` decor parses; manual — every prototype
prop appears (bridge viewscreen + consoles, med-bay beds + cross, cargo
crates, lounge table + seats, ops desks).

### 4.3 UI styling pass

- Join screen styled per prototype: card, "SS MERIDIAN · CREW LINK" copy,
  callsign label, toggle switches, BOARD SHIP button states.
- HUD: ship name + controls legend top-left; toolbar, tiles, toasts, and
  pill match prototype fonts/colors/spacings.

**Verify (M4 gate)**: side-by-side with the prototype at the same zoom —
layout, colors, and states visually match; a non-author can't spot
structural differences.

---

## Phase 5 — Hardening & Deploy (M5)

### 5.1 Shared password

- `ROOM_PASSWORD` env var on the server; `join` carries a password field
  (input appears on the join screen only when the server announces it's
  required — probe via the initial WS handshake or a `/config` endpoint).
  Wrong password → typed rejection, join screen shows the error.

**Verify**: unit test on the join handler; manual — wrong password rejected,
correct one boards, unset env var means no password field.

### 5.2 Reconnect with grace window

- Server: on socket drop, keep the player (flagged away) for a grace window
  (~30s) keyed by a resume token issued in `welcome`; client stores it in
  `sessionStorage`.
- Client: on unexpected socket close, auto-reconnect with backoff and the
  resume token; success restores id/position/hue seamlessly; expiry falls
  back to the join screen. Peer connections are simply re-established by the
  normal pairing flow after resume.
- Refresh still lands on the join screen by choice? No — resume token in
  `sessionStorage` survives refresh: a refresh inside the grace window
  resumes. This supersedes decision 10's v1 semantics, as planned for
  hardening.

**Verify**: unit test grace-window state transitions; manual — kill wifi
15s mid-call and recover with position intact and A/V re-established; wait
past the window and land back at join.

### 5.3 VPS deploy

- Provision one small VPS (Hetzner/DO). Node LTS, the server as a systemd
  unit, client built statically.
- Caddy: serves the client build, terminates TLS (Let's Encrypt), proxies
  `/ws` to the Node process.
- Deploy script (rsync or git pull + build) documented in `README`.

**Verify**: production URL loads over HTTPS, two clients on different
networks can join, walk, and (NAT permitting) get A/V.

### 5.4 coturn

- Install coturn on the same VPS: TLS, static-auth-secret mode; server mints
  short-lived TURN credentials and includes them (with the STUN entry) in
  the ICE config delivered in `welcome`.
- Open the relay UDP port range in the firewall.

**Verify**: force relay (`iceTransportPolicy: 'relay'` in a debug flag) and
confirm A/V still connects; then the real test — two clients on hostile
networks (e.g. phone hotspot + office VPN) connect normally.

### 5.5 Production smoke (M5 gate)

- Run the full `av-smoke.md` checklist against the production URL, plus:
  wrong-password rejection, mid-call wifi-kill recovery, TURN-forced
  connection, 6-person zone sanity check (expect degradation beyond ~6 —
  accepted, verify it degrades rather than crashes).

---

## Step → Milestone map

| Milestone        | Steps   | Gate                     |
| ---------------- | ------- | ------------------------ |
| M1 Walkable ship | 1.1–1.6 | end of 1.6               |
| M2 Zones         | 2.1–2.3 | end of 2.3               |
| M3 A/V           | 3.1–3.7 | checklist run in 3.7     |
| M4 Polish        | 4.1–4.3 | visual comparison in 4.3 |
| M5 Hardening     | 5.1–5.5 | production smoke in 5.5  |

## Dependencies to add (and nothing else)

- Root: `typescript`, `vitest`, `concurrently`
- `shared`: `zod`
- `server`: `ws`, `nanoid`, `tsx` (dev)
- `client`: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`

No state libraries, no CSS frameworks, no WebRTC wrappers — the mesh is
small enough to own directly, and owning it keeps the SFU escape hatch
(ADR-0001) honest.
