# Progress

## Done

Double-click-to-move is implemented and working.

- `stepToward(map, from, to, dist)` added to `shared/src/geometry.ts`: one
  straight-line step of up to `dist` toward a target, clamped to the floor
  plates via the existing `clampMove` (so blocked axes stop while the free
  axis slides along plate edges). Within `dist` of the target it lands
  exactly on it. Unit tests in `shared/src/geometry.test.ts` (4 cases
  against the real map.json).
- `client/src/render/stage.ts`: a `dblclick` listener on the canvas converts
  screen to world coords by inverting the draw transform (center on camera,
  scale by zoom), rejects points where `inFloor` is false, and stores a
  `moveTarget`. Each frame with no movement keys held, `autoWalk` steps
  toward it at the existing walk SPEED (255 px/s); facing and the walk
  animation are derived from the actual per-frame travel, and the camera
  follow resumes like keyboard walking. Position sends reuse the existing
  throttled `sendPos` path untouched.

## Decisions

- **No pathfinding.** The walk is a straight line; `clampMove` slides along
  plate edges, and a step that moves neither axis cancels the walk (target
  unreachable from here). Matches the plan's scope; pathfinding around the
  L-shaped hull can be a follow-up if straight-line feels bad in practice.
- **Keyboard wins.** Any held movement key cancels the auto-walk instantly.
- **Cancellation points.** The target is also cleared when meeting mode
  takes the keys (`setKeysEnabled(false)`), when boarding a shuttle, and
  when an owner map edit replaces the layout (`setMap`) — the old
  destination may no longer exist.
- **Clicks in open space, while flying, or under meeting mode are ignored**
  (no target set, no error).
- **No destination marker** was added — the plan asked only for movement.
- `.claude/launch.json`: the `server` config gained `"autoPort": true` so a
  preview server can start when port 3000 is occupied (it was held by
  another project's dev server during verification).

## Verified

- `npm run typecheck` clean across workspaces; `vitest run` 248/248 passing.
- End-to-end in the preview browser (clerk ticket sign-in, ws port rewrite):
  double-click on floor walks the avatar to the exact point (sub-pixel
  arrival observed in outgoing pos messages), double-click on open space is
  ignored, and a movement key mid-walk cancels the walk.
