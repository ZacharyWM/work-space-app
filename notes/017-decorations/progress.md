# progress — decorations anyone can place

## status

Implemented, plus per-prop sizing and stacking (2026-08-03); shared + go tests
green (299 vitest, go ok); verified in the browser against the local server and
postgres. Not deployed.

## what shipped

- `shared/src/items.ts` — 25 kinds (`ITEM_KINDS`), `placedItemSchema`,
  `MAX_ITEMS_PER_WORKSPACE = 300`, and the two pure rules both sides run:
  `placementDenialAt` (on a floor plate, not in someone else's claimed pod)
  and `removalDenialAt` (the pod half only).
- `client/src/render/items.ts` — the art. Logical-pixel painters baked into one
  cached offscreen canvas per kind, blitted at `ITEM_SCALE` 1.6 with the
  avatars' drop shadow. `box()` draws the 3/4 top+front face, `blob()` cuts
  corners for foliage/cushions. Live details on top of the sprite: the lamp's
  warm floor pool and the server rack's blinking LEDs. Rugs are flat (`isFlat`):
  they draw under everything and cast nothing.
- Protocol: client `placeItem / moveItem / scaleItem / deleteItem`; server
  `itemPlaced / itemMoved / itemScaled / itemDeleted / itemRejected{offFloor|
  notYourPod|full|gone}`. `welcome` and `mapChanged` both carry `items`.
- Server: `workspace_items` table + `itemsOf/itemByID/placeItem/moveItem/
  scaleItem/deleteItem/deleteItems`; handlers re-run the shared rules against
  the live pod claims; a map edit prunes props whose deck vanished and the
  pruned set rides `mapChanged`.
- Client: `conn.items`, the y-sorted draw layer (props sort with avatars and
  NPCs, so a person in front of a bookshelf covers it), stage build mode, the
  DECOR tray, and the pick popup with its armed CLEAR→SURE?.
- Sizing: every prop carries a `scale` (0.5x–2.5x, `ITEM_SCALE_*` +
  `clampItemScale` in shared). The tray's SIZE slider is the size the next prop
  is stamped at — the ghost shows it — and the pick popup's slider resizes the
  prop already down. `itemSize`/`drawItem` take the size, so hit-testing, the
  selection frame, the drop shadow and the lamp's floor pool all scale with it.

- Stacking: every prop carries a `depth` nudge (±80 world px in 20px steps,
  `ITEM_DEPTH_*` + `clampItemDepth` in shared). `drawScene` sorts standing props
  by `y + depth` and the stage hit-tests on the same key, so the pick follows
  what is visibly on top; rugs keep their placement order and sort by `depth`
  alone. The pick popup's STACK BACK / FRONT buttons send `raiseItem`.

## decisions made while building

1. **Props are a separate layer from map `decor`.** The Map Editor replaces the
   whole map blob on save; props living in it would be wiped by any edit.
2. **Nothing is optimistic.** Every client, the actor included, renders from
   the server broadcast — the same stance as pod claims.
3. **A move is judged twice**: the spot it leaves must be one the mover may
   clear, the spot it lands on one they may place in.
4. **Click vs pan share the primary button.** `CLICK_SLOP` = 4px decides. This
   is what let build mode keep drag-pan instead of stealing the button.
5. **Unknown kinds are skipped, not fatal** (`itemsOf`), so a kind leaving the
   library can never break a welcome.
6. **The 300 cap is enforced inside the INSERT** (`WHERE (SELECT count(*)…) <
   300`), so racing placements resolve in postgres like the other caps.
7. The dev database still had the v1 `workspace_items` table (composite
   `(workspace_id, id)` primary key); `CREATE TABLE IF NOT EXISTS` is a no-op
   there. Every query is scoped by `workspace_id`, so both shapes work.
8. **A slider drag is one write, not one per step.** The canvas follows the
   thumb from a local preview the stage holds; the `scaleItem` goes out on
   release, and the preview retires the moment the server echoes it back.
   Arrow keys commit per press — they are already discrete.
9. **The size bounds are 0.5x–2.5x.** Below half a prop stops reading as
   itself; above 2.5x the biggest one (a rug, 176x112 world px) already fills
   a whole pod. `clampItemScale` runs in the decoder, so nothing forged or
   float-noisy reaches the db.
10. **Sizing is a move-grade permission, not a delete-grade one**: the same
    `removalDenialAt` check the drag uses, so someone else's claimed pod is
    the only thing that refuses it. Stacking takes the same check.
11. **Stacking nudges the sort key, it does not layer.** An absolute layer
    number ("bring to front") would lift a prop out of the y-sort entirely, so
    a monitor sent to front would draw over an avatar standing in front of it
    from anywhere on deck. Biasing `y` by a bounded ±80px fixes the
    prop-on-a-table case and leaves people occluding props by position.

## verified in the browser

Stacking (2026-08-03): a monitor at (580,600) standing on a meeting table at
(580,640) drew behind the table. Picking it and clicking FRONT three times
stored `depth 60` and flipped the draw order — a `drawImage` tap showed the
monitor's sprite blitted after its table, while the untouched pair beside it
still drew table-last. BACK clamped at -80 on the seventh click and disabled
itself there; four FRONTs restored 0.

Sizing (2026-08-03): the tray's slider at 250% drew a 2.5x ghost and stamped a
plant stored as `scale 2.5`; picking it and working its popup slider — arrow
keys and a thumb drag — resized it live and stored 1.3 then 0.9, quantized
exactly; the size survived a reboard through the welcome. The `ALTER TABLE …
ADD COLUMN IF NOT EXISTS scale` left the six pre-existing props at 1.

Placed props from the tray (each click stamps one, tray stays armed); dragged a
couch to a new spot; picked it and cleared it with CLEAR→SURE?; all six props
survived a reboard; a prop hovered over another account's claimed pod ghosts
red and the click places nothing. A second member on a raw socket got
`itemRejected notYourPod` inside the claimed pod, `itemPlaced` on open deck, and
`itemRejected offFloor` off the hull — and their prop appeared live in the
first client without a reload.

## known gaps

- No rotation: a desk always faces the camera.
- Props don't block movement — you can stand on the couch.
- The tray has no search or scroll memory; 25 kinds fit, more would want it.
