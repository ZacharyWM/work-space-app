# Plan: Single-Level Virtual Office ("Spaceship" Theme)

A gather.town-style web app: one flat map, avatars that walk around, zone-based
audio/video, mute and camera toggles. TypeScript everywhere. The design
prototype in `notes/ClaudeDesignPrototype/Spaceship Virtual Office.dc.html` is
the behavioral and visual spec; where this plan and the prototype disagree, the
prototype wins.

Domain terms (Zone, Open Space, Floor Plate, Map, Display Name, Speaking) are
defined in [CONTEXT.md](../../CONTEXT.md). Architecture decisions with real
trade-offs are recorded in [docs/adr/](../../docs/adr/).

---

## 1. Locked Decisions

Resolved during the grilling session of 2026-07-02.

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **P2P mesh for A/V, accept the ~5-6 person per-zone video ceiling** | Zero media infra; a degraded 12-person all-hands is an accepted v1 limitation. [ADR-0001](../../docs/adr/0001-p2p-mesh-for-zone-av.md) |
| 2 | **Procedural vector rendering, no image assets** | Matches the approved prototype exactly; no art pipeline. Kills the tileset/sprite-sheet design from the preliminary plan. [ADR-0002](../../docs/adr/0002-procedural-vector-rendering.md) |
| 3 | **Free smooth movement** (not grid-locked) | Easiest option and what the prototype does. |
| 4 | **Floor-bounds collision only** | Avatars are clamped to Floor Plates (two-line check); they can walk through decor and each other. |
| 5 | **Camera follows the player; zoom only, no free pan** | Scroll wheel / +− buttons zoom 0.3–1.8; minimum zoom shows the whole ship, making pan unnecessary. |
| 6 | **Server is authoritative for Zone membership; positions are client-trusted** | The point is consistency (one authority decides who is connected to whom), not anti-cheat. Fine for a ~12-person trusted team. |
| 7 | **Speaking indicators are in scope** (A/V milestone) | Local audio-level detection, boolean broadcast; the prototype leans on it for presence feel. |
| 8 | **getUserMedia at the join screen** | Grant once, before boarding; declining still lets you board without A/V. Zone entry never stalls on a permission dialog. |
| 9 | **Duplicate display names allowed** | Identity is the connection; names are labels. Self-policing at 12 people. |
| 10 | **v1 refresh = fresh join** | Dropped socket removes you after ~5s; reload starts over at the airlock. Hardening adds auto-reconnect with a grace window. |
| 11 | **STUN only until hardening; then self-hosted coturn** | Some peer pairs (hostile NATs, VPNs) cannot connect without TURN; acceptable during development, not in production. |
| 12 | **Shared password added at hardening** | This is a workplace tool with live cameras/mics; one env-var password gates the internet-facing deploy. No accounts. |
| 13 | **Deploy to a single small VPS** (Node + Caddy for TLS; coturn on the same host later) | Full UDP control for TURN; HTTPS is mandatory for getUserMedia. |
| 14 | **Testing: unit tests for pure logic, manual checklist for A/V** | Vitest for zone math, movement clamping, schemas, peer state machine. Two-browser smoke checklist per milestone for everything WebRTC. |
| 15 | **Terminology: "Display Name" is the domain term** | "Callsign" is spaceship-theme copy only. |

## 2. Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript, strict, everywhere |
| Frontend | React + Vite |
| Map rendering | HTML5 Canvas 2D, procedural vector drawing (no game engine, no images) |
| UI | Plain React + CSS; theme colors as CSS variables |
| Realtime | Node.js + `ws` WebSocket server; also carries WebRTC signaling |
| A/V | WebRTC P2P mesh, scoped per Zone |
| Server model | Single Node process, in-memory state, no database |
| Testing | Vitest (pure logic only) |
| Repo | npm workspaces monorepo: `client/`, `server/`, `shared/` |
| Deploy | One VPS: Node behind Caddy (TLS); coturn added in hardening |

## 3. Architecture

### Repo layout

```
/client        React app: canvas renderer, WebRTC manager, UI
/server        Node WS server: presence, zone computation, signaling relay
/shared        TS types: protocol messages, map schema, theme schema, pure logic
map.json       The one Map (floor plates, zones, decor, spawn)
theme.json     Spaceship palette, fonts, UI colors
```

Pure logic that both sides need (zone hit-testing, floor clamping, schema
validation) lives in `shared/` and is unit-tested there.

### Identity & join flow

1. Client loads join screen: display name input, mic/cam pre-toggles.
2. `getUserMedia` is requested at join with the chosen constraints. Declining
   or having no devices still allows boarding (camera-off tile state).
3. On join the server assigns a connection-scoped id (e.g. nanoid) and an
   avatar hue, places the player at the airlock spawn, and sends the map
   config + current roster.
4. Duplicate names are allowed. Nothing persists server-side; refresh is a
   fresh join.

### Movement & presence

- WASD/arrows move the avatar continuously; movement is clamped to Floor
  Plates per-axis (the prototype's `inFloor` check).
- Client sends throttled position updates (~15/s). Server broadcasts them.
- Remote avatars are interpolated between updates so 15/s doesn't look
  jittery.
- Camera follows the local player with eased zoom (0.3–1.8).

### Zones & signaling

- Zones are non-overlapping axis-aligned rectangles in `map.json`. The server
  validates non-overlap at startup and fails fast.
- The server recomputes each player's Zone from their reported position and is
  the single authority on membership. Zone transitions take effect
  immediately (prototype behavior). Known risk: walking along a zone edge can
  flap connections; if it annoys in practice, add a ~300ms server-side
  debounce on transitions — noted, not built.
- When two players share a Zone, the server instructs them to connect. The
  peer with the lexicographically lower id makes the WebRTC offer
  (deterministic initiator, no glare). Offer/answer/ICE relay over the
  existing WebSocket.
- When either leaves the Zone (or disconnects), the server instructs
  teardown. Per-pair state machine:
  `disconnected → connecting → connected → disconnected`.
- ICE servers: public STUN during development; coturn credentials added in
  hardening.

### A/V behavior

- Mute / camera-off toggle `track.enabled` locally — connections stay up, so
  toggling is instant. State changes are broadcast so others render the
  MUTED badge / camera-off tile.
- Speaking: each client runs a WebAudio AnalyserNode on its own mic, derives
  a boolean against a threshold, and broadcasts changes (throttled). Others
  render the avatar ring + tile highlight. Only shown inside a Zone.
- In Open Space no peer connections exist at all — private by construction.

### Protocol (shape, not final)

Client→server: `join`, `pos`, `mediaState` (micOn/camOn), `speaking`,
`signal` (relayed SDP/ICE), `leave`.
Server→client: `welcome` (id, map, roster), `playerJoined`, `playerLeft`,
`pos`, `mediaState`, `speaking`, `zoneChanged`, `peerConnect`,
`peerDisconnect`, `signal`.
All messages are typed in `shared/` and validated at the boundary.

## 4. Map & Theme Data

No images anywhere. `map.json` is theme-agnostic geometry; `theme.json` is
color/typography.

- **map.json**: floor plates (rounded rects), Zones (id, name, rect), decor
  items as typed primitives (console strip, crate, bed, round table, seat,
  desk — each a small draw function keyed by type), spawn point (airlock).
- **theme.json**: background color, accent, floor/line colors, fonts, UI CSS
  variables. Swapping palette/fonts is data-only; a new *kind* of decor prop
  is code (accepted consequence of ADR-0002).
- **Ship layout** (from the prototype, verbatim): Bridge, Med Bay, Ops Pod A,
  Ops Pod B, Cargo Hold, Engine Lounge; airlock spawn at bottom-left;
  starfield backdrop with parallax.

## 5. UI Spec (from the prototype)

- **Join screen**: name input, mic/cam toggle switches with hints, BOARD
  SHIP button (disabled until name non-empty), Enter submits.
- **In-ship HUD**: ship name + controls legend top-left.
- **Video tiles** top-center: self first (labeled "You"), then zone
  occupants; animated-gradient placeholder behind initials when cam on,
  CAM OFF state otherwise; MUTED badge; speaking accent border + dot.
- **Open Space pill** when in no Zone: "COMMS OFFLINE — ENTER A ZONE TO
  CONNECT".
- **Toasts** on zone enter ("ENTERED · BRIDGE") and exit ("LEFT ZONE · COMMS
  CLOSED").
- **Zone rendering**: outlined rects with name + live occupant count; your
  current zone glows in the accent color.
- **Toolbar** bottom-center: mic toggle, cam toggle, name + current
  zone/OPEN SPACE label, zoom −/+, EXIT.
- **Avatars**: colored circle (server-assigned hue), name label above, muted
  dot, speaking ring, drop shadow; drawn in y-order.

## 6. Milestones

Each milestone has explicit verification; it isn't done until the checks pass.

### M1 — Walkable ship
Monorepo scaffold, shared protocol types, WS server with join/roster/position
broadcast, canvas renderer (starfield, floor plates, avatars), movement with
floor clamping, follow-camera with zoom, join screen (name only; media toggles
wired but inert).
**Verify**: unit tests for floor clamping + message schemas; two browsers see
each other join, move smoothly (interpolated), and leave.

### M2 — Zones
Zone rects in map.json with startup overlap validation, server-side zone
membership, zone outlines + occupant counts on canvas, current-zone glow,
toolbar zone label, enter/exit toasts, Open Space pill.
**Verify**: unit tests for zone hit-testing and overlap validation; two
browsers agree on who is in which zone at all times, including boundary
walks.

### M3 — A/V
getUserMedia at join, per-zone mesh signaling with deterministic initiator,
peer state machine, video tiles (self first), mute/cam toggles with broadcast
badges, speaking detection + indicators. Public STUN.
**Verify**: unit tests for the peer state machine; manual checklist with 2-3
browsers/machines — connect on shared zone entry, teardown on exit, instant
mute, cam-off tile, speaking ring tracks actual speech, no connections in
Open Space.

### M4 — Spaceship polish
Full decor set (bridge viewscreen/consoles, med-bay beds, cargo crates,
lounge table, ops desks), theme.json driving CSS variables + canvas palette,
final map layout matching the prototype, join screen styled per prototype.
**Verify**: side-by-side visual comparison against the prototype; palette
swap in theme.json restyles app without code changes.

### M5 — Hardening & deploy
WS auto-reconnect with grace-window position/identity resume, shared password
(env var, checked at join), coturn on the VPS with credentials in ICE config,
deploy behind Caddy with TLS, ~5s server-side disconnect sweep.
**Verify**: kill wifi mid-call and recover within grace window; wrong
password rejected; two clients on hostile NATs (e.g. phone hotspot) connect
via TURN; full manual checklist passes on the production URL.

## 7. Out of Scope (v1)

- Multiple maps/floors, portals, private spaces beyond Zones
- Text chat, screen share, emotes, status messages
- Accounts/auth beyond the shared password
- Persistence/database
- SFU / media server (revisit only if the mesh ceiling actually hurts — see
  ADR-0001)
- Mobile/touch support (desktop keyboard is assumed; mobile is a sanity
  check, not a target)

## 8. Accepted Limitations & Risks

- **Mesh ceiling**: >~6 video participants in one Zone degrades
  (upload bandwidth, encode CPU). Known and accepted; not a bug.
- **No TURN until M5**: some peer pairs on hostile networks can't establish
  A/V during development.
- **Zone-edge flapping**: instant zone transitions can flap connections when
  someone walks the boundary; debounce is the ready fix if needed.
- **Client-trusted positions**: a malicious client can teleport or spoof
  location. Irrelevant for a small trusted team; do not build defenses.
