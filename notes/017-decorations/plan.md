# 017 — decorations anyone can place

Anyone aboard — not just the workspace creator — can place decorations, desks,
plants and other props anywhere on the map, gather.town style.

## decisions (from the scoping conversation)

- **This existed before.** `a425323` shipped a 14-kind decor library; `b68bdcf`
  deleted it the next morning ("removed by request", notes/009 progress). The
  stated problem with v1 was that **the items looked bad**: warm wood/fabric
  furniture drawn in mixed perspective with ground shadows, dropped into a cold
  top-down vector hull. So v2 is a fresh design, and the art carried the risk.
- **Art direction**: pixel art in 3/4 view, authored in the same logical-pixel
  space as the avatar sprites (`sprite.ts`) and blitted at the same 1.6x
  nearest-neighbor scale. The avatars were already the gather.town-looking part
  of this app; the props match them rather than the flat vector props in
  `map.json`. Still procedural, so ADR 0002 holds — no image assets.
- **Placement**: anywhere on a Floor Plate, every zone included. The one
  exception is a Pod somebody else has claimed.
- **Removal / move**: same rule — communal everywhere except someone else's
  claimed Pod. Clearing needs an armed DELETE→SURE? confirm.
- **Build UX**: a DECOR tray arms a kind, a ghost follows the cursor on a 20px
  snap (the map editor's grid), each click stamps one and stays armed. With
  nothing armed, dragging a prop moves it and clicking one picks it for
  clearing. Drag-pan still works — a pointer that travels more than 4px is a
  pan, not a click.
- **No collision, no rotation, no interaction.** Props are decorative.
- **Storage**: `workspace_items`, capped at 300 per workspace, guarded inside
  the insert. Separate from the Map's own `decor` (which the Map Editor
  replaces wholesale) so an editor save can't wipe everyone's props.

## rejected

- Restoring v1 from git and porting it (the art was the thing that failed).
- Drag-and-drop from the tray (fights drag-pan on a pannable canvas).
- Locking non-pod zones, as v1 did — most of the ship refused props and just
  showed a toast.
