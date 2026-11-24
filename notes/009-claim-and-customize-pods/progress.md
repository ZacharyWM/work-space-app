# progress — claim and customize pods

## status

Implemented, tests green (225), verified in the browser. Not deployed.

**Update 2026-07-07**: the decor half of this feature (item library, DECOR
palette, placement/removal, `workspace_items` persistence) was removed by
request. Pod claiming — the `pod` map flag, `pod_claims` table,
claim/release protocol and HUD buttons, owner labels — remains. The
decisions below describe the feature as originally built; the decor parts
no longer exist in the code.

## interpretation of the plan

The plan's two statements — "PODs are the only zones that can be customized"
and "anyone should be able to drag and drop from the library into the space
ship" (title: "…and customize common areas") — are reconciled with one rule:

- **Open Space** (not inside any Zone): anyone places items, anyone deletes
  them. This is the "common areas" customization.
- **Pods** (the 10 ops pods): only the claimant places/deletes items inside.
  An unclaimed pod takes no items — claim first.
- **Non-pod zones** (bridge, med bay, cargo, flight deck, lounge): locked, no
  decor. This is the literal "PODs are the only zones that can be customized".
- Everywhere, an item's anchor must sit on a floor plate.

## decisions

1. **Pods are map data, not naming convention**: `zoneSchema` gained an
   optional `pod: boolean`; map.json flags the 10 ops pods. No id-prefix
   matching anywhere.
2. **Claims are account-level and persistent**: new `pod_claims` table keyed
   `(workspace_id, zone_id)` with a second unique on `(workspace_id, user_id)`
   — one owner per pod AND one pod per account per workspace, both enforced by
   postgres so racing claims resolve there (constraint name → typed result).
   Claims survive logout; the owner's display name renders at the pod's bottom
   edge (`◈ NAME`) from the welcome payload, resolved via `users` join.
3. **Claiming requires standing in the pod** (server-checked via the session's
   zoneId). The HUD shows a contextual CLAIM POD button in an unclaimed pod,
   and RELEASE POD (two-click SURE? confirm) in your own. Releasing is allowed
   so a mis-claim isn't permanent; a released pod's items stay (the next
   claimant — or anyone, while it's unclaimed — may remove them).
4. **Items persist in `workspace_items`** (id, kind, x, y, placed_by), capped
   at `MAX_ITEMS_PER_WORKSPACE = 300` with the same guardrail-inside-the-insert
   stance as the other caps. Kind is validated against the shared library on
   the way out (rows whose kind left the library are skipped, not crashed on).
5. **Shared rules module** (`shared/src/items.ts`): `placementDenialAt` /
   `removalDenialAt` are pure functions used by the client for instant
   feedback and by the server as the enforcement — one source of truth.
6. **Delete friction**: DECOR panel open = decor mode; a plain click on the
   canvas picks an item (dashed accent frame), a popup shows its label with
   DELETE → SURE? (self-disarming), matching the app's armed-confirm pattern.
   Drag-pan still works in decor mode; only near-stationary clicks pick.
7. **Item library** (14 kinds, all drawn procedurally per ADR 0002, colors in
   `theme.json canvas.items`): chair, desk, rug, plant, lamp, bookshelf, sofa,
   coffee maker, rubber duck, sleeping ship cat, trophy, lava lamp, alien
   plant (it watches you), arcade cabinet (marching invader). Animated details
   ride the rAF timestamp like the built-in decor.
8. **Protocol**: client `claimPod / releasePod / placeItem / deleteItem`;
   server `podClaimed / podReleased / itemPlaced / itemDeleted` (broadcast to
   everyone including the actor — the echo carries the server-assigned id) and
   one `decorRejected { reason }` to the actor alone. `welcome` now carries
   `pods` + `items`.
9. **Removing (banning) a member frees their pod claim** in the same statement
   as the ban, and the room is told live via `podReleased` — a name that can
   never rejoin must not squat on a pod. Workspace deletion cascades both new
   tables.
10. **Known limitation**: a mid-session rename doesn't refresh the pod label
    for others (the claim broadcast carries the name at claim time; welcomes
    always re-resolve from the db). Accepted — self-heals on the next join.

## touched

- shared: `map.ts` (pod flag), `items.ts` (new: library + rules + schemas),
  `protocol.ts`, `index.ts`, tests (`items.test.ts` new, `protocol.test.ts`
  extended)
- server: `db.ts` (two tables, claim/release/podsOf/place/itemsOf/itemById/
  deleteItem, ban frees pod), `index.ts` (four handlers, welcome payloads,
  per-connection workspaceId)
- client: `connection.ts` (pods/items maps + handlers), `render/items.ts`
  (new: drawers + palette previews), `draw.ts` (items layer + pod owner
  labels), `stage.ts` (screenToWorld, decor mode, click pick),
  `ui/DecorPanel.tsx` (new: drag-and-drop palette), `ui/Hud.tsx` (DECOR +
  CLAIM/RELEASE buttons), `App.tsx` (wiring, delete popup, notice toast)
- `map.json` (pod flags), `theme.json` (items palette), `CONTEXT.md` (Pod +
  Decor Item terms)
