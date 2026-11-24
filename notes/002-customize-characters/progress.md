# Implementation Progress

Tracks [plan.md](plan.md): character customization ported from the updated
prototype (notes/ClaudeDesignPrototype/Spaceship Virtual Office.dc.html).

## Character customization — done (2026-07-03)

- `shared/src/character.ts`: the prototype's SKIN/HAIR/SHIRT/PANTS/HAT option
  lists as const arrays, `characterSchema` built from them with `z.enum` (a
  character can only be made of palette values — the server rejects
  out-of-palette junk for free), `DEFAULT_CHARACTER`.
- Protocol: `character` field on `playerSchema` and the `join` message, plus a
  `character` client→server message relayed to the room as
  `{ type: "character", id, character }` — same store-and-relay shape as
  `mediaState`/`speaking`. Scope call: the plan only asked for localStorage,
  but customization in a multiplayer room must cross the wire or nobody else
  sees it; the prototype never hit this because its crew were local bots.
- Server: `RoomState.join` takes the character from the join input,
  `updateCharacter` stores live edits, park/resume keeps the worn outfit.
- Client rendering: `render/sprite.ts` is the prototype's `buildSprite()`
  ported as-is — 20x30-px frames drawn into cached offscreen canvases keyed by
  appearance+facing+frame; left = mirrored right. `drawAvatar` now draws the
  sprite (scale 1.6, walk frames at 150ms, idle frame standing) instead of the
  hue circle, with the prototype's shifted ring/label offsets;
  `imageSmoothingEnabled = false` for hard pixel edges.
- Facing/moving aren't on the wire: the local player derives them from the
  movement keys (horizontal wins diagonals, prototype rule); remotes derive
  them from how the eased display position travels each frame (> 20 px/s
  counts as walking, facing holds its last value at rest).
- `ui/CrewLocker.tsx`: the prototype's CREW LOCKER modal — animated preview
  mannequin (turns through the four facings, walk cycle running), swatch rows
  from the shared palettes, hat buttons, helmet toggle. Every pick applies
  instantly: saved to localStorage (`client/src/character.ts`, load validates
  with the schema and falls back to the default), written onto the self roster
  entry (canvas reads it next frame), sent to the room. Opened from a SUIT
  button in the hud toolbar (prototype position, `--accent-faint` added to the
  theme variables for its fill).
- `hue` is now dead weight: still assigned by the server and carried by the
  protocol, but nothing renders it since the circle avatar is gone. Left in
  place deliberately — removing a wire field is its own change.

Verified: `npm run typecheck` green in all three workspaces, `npm test`
110/110 (new: character schema round-trips + rejections, updateCharacter,
outfit survives park/resume). In the browser: boarded, opened the locker,
picked purple skin + antenna + helmet — localStorage holds the outfit, the
world sprite updates live. A second (raw WebSocket) client joined wearing a
cap and appeared correctly, then hot-swapped to beanie + pink shirt via the
`character` message and the change rendered immediately without a rejoin.
