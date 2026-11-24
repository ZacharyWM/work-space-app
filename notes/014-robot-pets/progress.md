# Progress

## Done

NPCs are implemented and verified end to end: the map editor grew an NPC
category with two kinds — robot dogs and humanoid robots — and placed NPCs
wander the ship on their own. They say nothing and do nothing else, per the
plan. Canonical term added to CONTEXT.md (NPC).

### Decisions

- **NPCs are map elements.** A new `npcs` array in MapData (`{x, y, kind}`,
  kind `"dog" | "bot"`), placed/moved/deleted in the Map Editor like ship
  pads and game tables: point elements, move but never resize. Optional on
  input (pre-feature maps parse unchanged, defaulting to none), so the field
  rides the existing editMap / mapChanged / welcome wire and the postgres
  map column with no protocol or schema changes.
- **The wander is client-side only.** NPCs are decor with legs: nothing
  about their movement rides the wire, the server only validates and relays
  the anchors, and each client simulates its own stroll (so two people see
  the same NPCs in slightly different spots — accepted, since NPCs carry no
  zone/AV/game meaning). This avoided a server tick loop and position
  broadcasts for a purely decorative feature.
- **Wander behavior.** An NPC picks a random walkable point within 240px of
  its map anchor, walks there at 90px/s (well under the player's 255) using
  the shared `stepToward`/`clampMove` floor clamp — so NPCs can only stand
  where players can — then idles 1.5–5s and repeats. Blocked walks (no
  pathfinding) are abandoned for another idle.
- **Validation mirrors pads/tables.** Max 12 NPCs; every NPC anchor must sit
  on a floor plate. Enforced in the shared `mapEditDenial` and its Go twin,
  so the editor disables SAVE on exactly what the server would reject.
- **Rendering.** The humanoid robot reuses the player pixel-sprite builder
  (`buildSprite`) with fixed off-palette metal tones and the antenna hat —
  walk animation for free. The robot dog is new side-view pixel art (visor
  eye, blinking antenna tail, scissoring legs) that mirrors for left/right
  travel. Both y-sort into the avatar draw pass so overlap reads correctly.
  No name pills — NPCs are ambient, not people.

### Shared (`shared/src/`)

- `map.ts`: `npcKindSchema` (`"dog" | "bot"`), `npcSchema` (point + kind),
  `npcs` array on mapDataSchema (optional on input, defaults `[]`), new
  `Npc` / `NpcKind` exports.
- `geometry.ts`: `MAP_LIMITS.npcs = 12`; `mapEditDenial` rejects too many
  NPCs and off-floor anchors.

### Server (`server/`)

- `mapdata.go`: `Npc` struct + `npcs` field on MapData (wire pointer tells
  absent from empty; absent defaults to none), kind validated on parse
  (unknown/missing kinds refused), `maxNpcs = 12` + on-floor checks in
  `mapEditDenial`. Nothing else server-side — NPCs are opaque to rooms,
  zones, and games.

### Client (`client/src/`)

- `render/npcs.ts` (new): `NpcLayer` owns the per-NPC wander sims (re-anchors
  on `setMap`), `drawNpc` renders both kinds.
- `render/draw.ts`: `drawScene` takes an `npcs` array and y-sorts them into
  the avatar pass.
- `render/stage.ts`: owns an `NpcLayer`, steps it each rAF tick, resets it on
  owner map edits.
- `ui/MapEditor.tsx`: `+ NPC DOG` / `+ NPC ROBOT` placement tools, NPC
  select/move/delete (point element, dashed ring selection, `NPC · DOG` /
  `NPC · ROBOT` labels), NPCs included in the editor view bounds.

### Tests

- `shared/src/map.test.ts`: npcs default to empty on pre-feature maps; both
  kinds parse; unknown and missing kinds are refused.
- `shared/src/geometry.test.ts`: on-floor accept/reject, NPC cap.
- `server/mapdata_test.go`: `TestParseMapDataNpcs` mirrors all of the above
  against the Go twin.
- All green: 219 vitest tests, `go test ./...`, `npm run typecheck`.

### Verified in the browser

Signed in via the Clerk ticket flow, boarded `default`, opened the map
editor: placed one dog and one robot on the spawn plate, SAVE enabled
(denial null), server logged the edit and broadcast `mapChanged` with both
NPCs. Live scene: pumped ~20s of simulated frames — the dog strolled
(467,775) → (392,693) → (296,586), idled ~5s, resumed; the robot strolled
independently; the player avatar stayed put. All positions stayed within the
wander radius and on walkable floor. Then reselected and deleted both NPCs
in the editor and saved, exercising delete and restoring the workspace map
to its pre-test state.

## Not done / future ideas

- NPC positions are not synced across clients (deliberate, see decisions).
- No interactions: NPCs ignore players, zones, pads, and games.
- Only the shared default-map spawn area was used for verification; NPCs on
  custom maps follow the same floor rules by construction.
