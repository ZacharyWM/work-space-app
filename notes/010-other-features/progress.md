# progress — other features (notes/010)

## status

Four of the five top-list features implemented, one commit each, plus
feature 12 (map editor / custom offices) by explicit request. The fifth
(minimap) was implemented and later removed by request. Typecheck + tests
green, each verified live in the browser with two signed-in users (one
driving the UI, one as a raw-WS client). CONTEXT.md gained glossary terms
for Chat Message, Announcement, Emote, Locate, and Map Editor (and the
Map term now allows per-workspace layouts). Not deployed.

## research decisions

- Compared against Gather.town, Teamflow, SpatialChat, Kumospace, SoWork.
- Ranked by universality across competitors + daily-use pain of absence +
  fit with the zone model (see feature_list.md for the full ordering and
  the excluded already-have list).
- Top 5 chosen for implementation: text chat, emoji reactions, locate a
  teammate, ship-wide announcement, minimap.

## feature progress

### 1. text chat — done

Implemented, typecheck + tests green (235), verified live in the browser
with two signed-in users (one UI, one raw-WS client).

Decisions:

- **Two scopes**: `ship` (everyone aboard) and `zone` (the sender's current
  zone occupants only). Gather's third "nearby" scope was dropped — zones
  already are the proximity unit here.
- **Server stamps everything**: id (nanoid), sender id + display name,
  scope, zoneId, timestamp. The sender renders from the server echo, same
  precedent as decor — no local append, one synced source.
- **History is in-memory and ship-only**: `RoomState.chatLog` keeps the
  last 100 ship-scoped messages, delivered in the welcome so joiners have
  context. Zone-scoped chat is live-only — people outside the zone (or who
  join later) never receive it, matching how zone A/V is private. No db
  table: chat is session chatter, not a record, and it dies with the room
  like the roster (parked-empty rooms are reaped).
- **Zone chat needs a zone**: server drops zone-scoped sends from open
  space; the client disables the ZONE toggle there (falls back to SHIP).
- **No chime, no rate limit**: unread badge on the CHAT button instead of
  sound (chat is ambient, waves are the "look at me" channel); rate
  limiting deferred until misuse exists (20-member cap bounds the blast
  radius).
- **Client cap 200** kept messages; server history cap 100.

Touched: `shared/protocol.ts` (chat schemas + client/server messages +
welcome.chat), `server/state.ts` (chatLog + addChat/chatHistory),
`server/index.ts` (chat handler, welcome payloads), `client/connection.ts`
(chat log + onChat), `client/ui/ChatPanel.tsx` (new), `Hud.tsx` (CHAT
button + unread badge + panel mount), `App.tsx` (onChat rerender), tests
(protocol round-trips + rejections, state history cap).

Verified in browser: ship messages both directions; zone message from MED
BAY did not reach an open-space user and did reach a co-zone user; ZONE
toggle disabled in open space, enabled inside; Enter sends and clears;
unread badge counts while closed; a fresh join's welcome carried only the
ship-scoped history, in order.

### 2. emoji reactions (emotes) — done

Implemented, typecheck + tests green (239), verified in the browser (both
directions, canvas-instrumented to prove the bubble draws).

Decisions:

- **Six emotes, names on the wire**: `thumbsUp heart laugh party wave
  question` (zod enum; glyphs are a client-side map). Wire stays ASCII and
  the palette is validated like every other enum.
- **Event, not state**: like a wave — server relays to the room with the
  sender id, stores nothing, late joiners see nothing. Sender renders
  locally on send (no echo), matching speaking/screenShare precedent.
- **Room-wide, not zone-gated**: the bubble is drawn on the avatar, and
  anyone who can see the avatar should see it react.
- **Two triggers**: number keys 1-6 (stage keydown, already suppressed
  while typing in inputs and in meeting mode) and a REACT toolbar button
  opening a one-click strip labeled with the key hints.
- **Rendering**: bubble floats above the name pill for 3.2s — overshoot
  pop-in, slow upward drift, fade over the last quarter. A new emote
  replaces the old and restarts the clock.
- **Known limitation**: a player flying a shuttle renders as a ship, so
  their emote doesn't show while airborne. Accepted.

Touched: `shared/protocol.ts` (emoteSchema + messages), `server/index.ts`
(relay), `client/connection.ts` (onEmote), `render/stage.ts` (emote map,
1-6 keys, sendEmote, view plumbing), `render/draw.ts` (EMOTE_GLYPH +
bubble), `ui/Hud.tsx` (REACT strip), `App.tsx` (wiring), protocol tests.

Verified in browser: key 3 delivered `laugh` to a second client; the
second client's `party` drew at its avatar's position (fillText probe);
picker strip shows all six with key hints, sends, and closes on pick.

### 3. locate a teammate — done

Implemented, typecheck + tests green (239), verified in the browser.

Decisions:

- **Purely client-side**: everyone's position is already on the roster, so
  LOCATE needs no protocol change and the target is never notified
  (locating someone is a private act — unlike a wave, which notifies).
- **Guide line, not pathfinding**: a dashed accent line from self to the
  target (marching dashes toward them) plus two counter-phased pulse rings
  at their feet, for 6 s. Gather draws a walkable path; our map is one
  open deck where a straight line reads fine — pathfinding would be
  speculative complexity.
- Line endpoints track both avatars live (self moves, target moves — the
  line follows the smoothed display position). Drawn under the avatars so
  it reads as a floor marking.
- Locating a new person retargets the one line; the target leaving the
  workspace clears it. LOCATE button on every crew panel row next to WAVE.
- Follow ("walk me to them") was considered and skipped: auto-walking the
  avatar through the clamped floors needs pathing, same reason as above.

Touched: `render/stage.ts` (locateTarget + locate() + per-frame
endpoints), `render/draw.ts` (line + rings), `ui/CrewPanel.tsx` (LOCATE
button), `ui/Hud.tsx` + `App.tsx` (prop threading). No shared/server
changes.

Verified in browser: LOCATE on a crewmate parked in MED BAY drew the
dashed line + rings every frame (canvas instrumentation: 85 line draws in
0.7 s, rings at the target's coords), and a pixel count of accent-colored
canvas pixels rose by ~2,000 while active and returned to baseline after
the 6 s expiry.

### 4. all-hands announcement (megaphone) — done

Implemented, typecheck + tests green (241), verified in the browser both
directions.

Decisions:

- **A third chat scope, not a new message type**: `chatScopeSchema` grew
  `announce`. It rides the whole chat pipeline — same validation, same
  ship-wide delivery, same in-memory history (so joiners see recent
  announcements in the log) — and only the client-side presentation
  differs: a prominent top-center banner (accent border, ALL HANDS ·
  NAME) for ~9 s plus a distinct chime (D5-D5-A5 bosun-call triple,
  reusing the wave chime synth). One protocol path instead of two.
- **Anyone can announce**: the app has no roles beyond workspace creator,
  and the member cap (20) bounds abuse. No rate limit yet — deferred
  until misuse exists, same stance as chat.
- **Sender sees their own banner** (the echo drives it) — confirmation the
  announcement went out.
- Banner click dismisses early; a newer announcement replaces it.
- **Bug found during verify**: the composer's open-space fallback forced
  every scope to SHIP (not just ZONE), silently downgrading announcements
  sent from open space. Fixed: only a picked ZONE falls back.

Touched: `shared/protocol.ts` (scope enum), `server/index.ts` (zone is
now the special case; ship + announce share broadcast + history),
`client/chime.ts` (announce chime, shared sequencer), `App.tsx` (banner +
chime on announce-scoped chat), `ui/ChatPanel.tsx` (ALL HANDS scope
button, tag, placeholder, footer), protocol tests.

Verified in browser: a second client's announce raised the banner + the
unread badge on user 1; user 1's ALL HANDS send from open space arrived
at the second client with scope `announce` and showed the sender's own
banner.

### 5. minimap — removed

Implemented (commit 0502c13), verified, then removed by request on
2026-07-07 along with the decor feature.

### 6. map editor / custom offices (list item 12) — done

Implemented by explicit request (owner-only editing), typecheck + tests
green (255), verified live with the owner driving the editor UI and a
non-owner raw-WS client watching the broadcasts.

Decisions:

- **Per-workspace map in postgres**: a nullable `map` jsonb column on
  `workspaces` (NULL = the default ship from map.json, which is now the
  *starting* layout instead of the only one). `ensureSchema` adds the
  column via `ADD COLUMN IF NOT EXISTS` for existing databases. The saved
  jsonb is schema-validated on the way out; an invalid row falls back to
  the default rather than crashing joins (same stance as character jsonb).
- **Owner-only**: only the workspace creator may edit. The welcome grew a
  required `owner` boolean (client gates the EDIT MAP button on it); the
  server re-checks on every `editMap` with a per-connection flag bound at
  join/resume and answers `mapRejected: notCreator` otherwise — verified
  by forging an editMap from the non-owner socket.
- **Whole-map replacement, one message each way**: client sends `editMap`
  with the full MapData (edits are rare; diffing would be speculative);
  server broadcasts `mapChanged` carrying the map plus freshly-read pods
  and items, because the edit may have pruned both — clients replace all
  three from that one message. The editor itself closes on the echo.
- **Shared validation**: `mapEditDenial` (shared/geometry.ts) returns one
  human-readable line or null — zones pairwise disjoint (reusing the
  inclusive-edge overlap rule), spawn on a floor, unique zone ids,
  non-blank names, caps (60 floors / 40 zones / 200 decor), and a ±8000
  coordinate box. The editor disables SAVE on exactly what the server
  would refuse, so `invalidMap` rejections only fire on forgeries/races.
- **The room's map is live state**: `RoomState.map` (null until the first
  join loads it from the db) replaces the old server-global map in every
  handler (pos/ship/claimPod/place/deleteItem). It dies with the reaped
  room and reloads on the next join.
- **Edit consequences are settled server-side**:
  - every player's zone membership is re-derived from the new map, with
    `zoneChanged` broadcasts; A/V re-pairing diffs the *full* co-zone
    pair set before/after (a map edit can move many players at once, so
    the per-mover `diffPairs` didn't fit — new `coZonePairs` helper),
  - pod claims whose zone is gone or demoted to a plain zone are deleted
    (verified: the non-owner's opsA claim vanished with the zone),
  - placed decor items left off-floor are deleted, and the editor prunes
    built-in map decor the same way on save.
- **A vanished floor teleports you home**: clampMove blocks both axes for
  an off-floor avatar, so `Stage.setMap` sends the player to the (always
  valid) new spawn and pushes one pos immediately — verified live.
- **Flight deck is location-bound**: pads/hull constants assume the deck
  plate at its map.json spot, so `hasFlightDeck` gates pad rendering and
  boarding when an edit removes that plate; docking onto a removed deck
  lands at the spawn. Editing the deck's *position* doesn't move the pads
  — accepted limitation, documented here.
- **Editor UI** (client/ui/MapEditor.tsx): full-screen canvas overlay,
  fit-to-layout view (+520 px margin), 20 px grid snap, click-to-select
  (zones over floors), drag to move, corner handles to resize (min 60),
  + FLOOR / + ZONE / + POD / SPAWN placement tools, zone rename input +
  pod toggle, DELETE (keyboard too; the last floor can't go), CANCEL /
  ESC to discard. Movement keys are suppressed while it's open (same
  mechanism as meeting mode).

Touched: `shared/geometry.ts` (MAP_LIMITS + mapEditDenial +
firstZoneOverlap), `shared/protocol.ts` (editMap, mapChanged, mapRejected,
welcome.owner), `server/db.ts` (map column + mapOf/saveMap/deletePodClaim,
WorkspaceRecord.createdBy), `server/state.ts` (RoomState.map),
`server/index.ts` (per-room map, owner flag, editMap handler, coZonePairs),
`client/net/connection.ts` (owner, mapChanged/mapRejected),
`client/render/stage.ts` (setMap + dock guard + pad gating),
`client/render/flightdeck.ts` (hasFlightDeck), `client/render/draw.ts`
(deck gate), `client/ui/MapEditor.tsx` (new), `Hud.tsx` (EDIT MAP button),
`App.tsx` (wiring), geometry + protocol tests, CONTEXT.md.

Verified in browser: owner boarded with EDIT MAP visible; non-owner's
welcome carried `owner: false` and its forged editMap got `notCreator`;
owner deleted pod opsA, added a floor + renamed "TEST LAB" zone, and
dragged MED BAY — the non-owner received one mapChanged (12 floors, opsA
gone, TEST LAB present, claim-pruned empty pods) plus its own
`zoneChanged → null` (it stood in the deleted pod); postgres held the
12-floor map and zero pod claims; a fresh boot welcomed with the edited
map; a second edit
moved the spawn and deleted the plate under the owner — the client
auto-sent one `pos` at the new spawn (teleport); deleting the spawn's
plate without moving the spawn disabled SAVE with "the spawn point must
sit on a floor plate". Test workspace map reset to NULL afterwards.

## verification environment notes

Verified against local postgres + the Clerk dev instance, with the
preview browser as user 1 (fake getUserMedia tracks) and a raw in-page
WebSocket as user 2 (Clerk session JWT minted via the backend API ticket
flow). The preview tool freezes the tab between commands, which starves
the server heartbeat and produces a park/resume churn in the server log —
an artifact of the tooling, not the app (the grace-window resume handled
it every time). Canvas features were proven by instrumenting canvas calls
and sampling pixels, because screenshots consistently captured stale or
reconnecting frames.
