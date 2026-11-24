# Preliminary Plan: Single-Level Virtual Office ("Spaceship" Theme)

A simplified gather.town-style web app: one flat map, avatars that walk around, zone-based audio/video, mute and camera toggles. TypeScript everywhere. No bells, no whistles.

---

## 1. Core Concept

- **One space, one level.** A single 2D map. Zooming out far enough shows every avatar.
- **Zones.** Rectangular regions defined in the map data (desks, meeting tables, lounge, bridge, etc.). You can only see/hear the video and audio of people standing in the same zone as you. Outside any zone = no A/V connections.
- **A/V controls.** Per-user mute mic and camera off toggles. Nothing else (no screen share, no chat, no emotes — at least for v1).
- **Swappable themes.** The look of the map is data, not code. Ship with a futuristic spaceship theme first; adding a new theme later means dropping in a new asset pack + config file, not rewriting rendering code.

## 2. Tech Stack

| Layer                                | Choice                                                     | Why                                                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                             | TypeScript (strict)                                        | Your requirement; shared types across client/server                                                                                                                                                              |
| Frontend framework                   | React + Vite                                               | Your preference; Vite for fast dev/build                                                                                                                                                                         |
| Map rendering                        | HTML5 Canvas 2D (custom, small)                            | A tile map + sprites + pan/zoom doesn't need a game engine. Upgrade path to PixiJS later if perf demands it                                                                                                      |
| UI layer                             | Plain React + CSS (CSS variables for theming)              | Toolbar, video tiles, name labels                                                                                                                                                                                |
| Realtime state (positions, presence) | Node.js server with WebSockets (`ws`)                      | Simple, no framework overhead; also doubles as the WebRTC signaling channel                                                                                                                                      |
| Audio/Video                          | WebRTC, peer-to-peer mesh, scoped per zone                 | Since A/V only connects people **in the same zone**, groups stay small — P2P mesh is fine and avoids running/paying for a media server (SFU). If zones ever need 8+ people, swap in an SFU (e.g., LiveKit) later |
| Server hosting model                 | Single Node process, in-memory state                       | One room, no persistence needed for v1. No database                                                                                                                                                              |
| Repo layout                          | Monorepo (npm workspaces): `client/`, `server/`, `shared/` | `shared/` holds message types, map/zone schemas, theme schema                                                                                                                                                    |

## 3. How It Works (High Level)

### Movement & Presence

1. Client connects via WebSocket, receives the map config and current roster.
2. Arrow keys / WASD move your avatar; client sends position updates (throttled, ~10–15/sec).
3. Server is the source of truth for who's where; it broadcasts position updates to everyone.
4. Client renders all avatars on the canvas; camera supports pan and zoom (scroll wheel / pinch), from "my desk" up to "whole ship."

### Zones & A/V

1. Zones are axis-aligned rectangles in the map config, each with an `id`.
2. Server computes which zone each player is in from their position (server-side, so it can't be spoofed).
3. When two players share a zone, the server tells them to establish a WebRTC connection (signaling: offer/answer/ICE relayed over the existing WebSocket).
4. When either leaves the zone, the connection is torn down. Simple state machine per peer pair: `disconnected → connecting → connected → disconnected`.
5. Mute/camera-off toggles just enable/disable local tracks — connections stay up, so toggling is instant.

### UI

- Canvas fills the screen (the ship).
- Video tiles for people in your current zone along the top or side.
- Bottom toolbar: mic toggle, camera toggle, your name, current zone name.
- Join screen: enter a display name, grant mic/camera permissions (or join without them).

## 4. Theming System

A theme is a folder of assets plus one config file — no code changes to add one.

```
themes/
  spaceship/
    theme.json      # palette, UI colors (CSS variables), font, tile size
    tileset.png     # floor, walls, decor tiles
    avatars.png     # sprite sheet(s)
map.json            # theme-agnostic: grid of tile IDs, zone rectangles, spawn point
```

- `map.json` references **logical** tile IDs ("floor", "wall", "desk", "console"); the theme maps those IDs to sprites. Swap themes without touching the map.
- UI colors come from CSS variables set by `theme.json`, so React UI restyles automatically.
- **Spaceship v1:** dark hull floors, glowing console "desks," a bridge zone, an airlock spawn point, engine-room lounge. Zone names in-theme ("Bridge," "Med Bay," "Cargo Hold").

## 5. Project Structure (Proposed)

```
/client        React app: canvas renderer, WebRTC manager, UI
/server        Node WS server: presence, zone computation, signaling
/shared        TS types: messages, map schema, theme schema
/themes        Asset packs (spaceship first)
map.json       The one map
```

## 6. Build Order (Milestones)

1. **Walkable map** — monorepo scaffolding, WS server, canvas rendering of map + avatars, movement, pan/zoom. (No A/V yet.)
2. **Zones** — zone rectangles in map config, server-side zone detection, show "current zone" in UI, highlight zone occupants.
3. **A/V** — WebRTC mesh per zone via WS signaling; video tiles; mute/camera toggles.
4. **Spaceship theme** — real tileset + avatar sprites, theme.json wiring, polish the map layout.
5. **Hardening** — reconnect handling, mobile-ish sanity check, deploy (single small VPS or Fly.io/Railway; needs WebSocket support, no special media infra).

## 7. Explicitly Out of Scope (v1)

- Multiple maps/floors, portals, private spaces beyond zones
- Text chat, screen sharing, emotes, status messages
- Accounts/auth (join with a name; maybe a shared room password later)
- Persistence/database
- Media server (SFU) — only if zone sizes outgrow P2P

## 8. Open Questions (for when we flesh this out)

1. Expected max concurrent users, and max people in one zone? (Drives the P2P-vs-SFU decision.)
   Answer: Probably like max 12 people. I'd like to know the trade offs between the two options.
2. Grid-locked movement (tile to tile, like gather.town) or free/smooth movement?
   Answer: whatever is easiest and least technically difficult.
3. Should desks be 1-person zones ("at your desk = private") or is being outside a zone the private state?
   A desk is a zone, but multiple people can walk into that zone. Being outside a zone is private state.
4. Art: hand-made pixel assets, purchased/free tileset, or AI-generated to start?
   Answer: I don't have an opinion. I'd prefer the easiest and most flexible option.
5. Any collision (can't walk through walls/desks) in v1, or walk-anywhere to start?
   Answer: to start, lets do whatever is easiest.
