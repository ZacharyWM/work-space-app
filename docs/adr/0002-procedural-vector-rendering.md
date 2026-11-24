# 2. Procedural vector rendering, no image assets

Date: 2026-07-02

## Status

Accepted

## Context

The preliminary plan proposed a gather.town-style tile pipeline: a grid map of
logical tile IDs plus per-theme sprite sheets (tileset.png, avatars.png). The
approved design prototype, however, uses no images at all: floor plates are
rounded rectangles, decor (consoles, crates, med-bay beds, lounge table) is
drawn vector shapes, and avatars are colored circles with name labels. The two
approaches produce categorically different aesthetics; building the tile
pipeline would not reproduce the approved look. A tile pipeline also requires
sourcing or producing pixel art, which nobody on the project wants to own.

## Decision

Render the map procedurally on Canvas 2D from shape data. The map file defines
floor plates, zone rectangles, and decor as typed primitives; no sprite or
tileset images exist. A theme contributes palette, fonts, and UI colors (CSS
variables) — data, not assets.

## Consequences

- The app matches the approved prototype's look exactly and is
  resolution-independent (crisp at any zoom).
- No art pipeline, no asset sourcing, no sprite-sheet tooling.
- "Themes are pure data" weakens: adding a genuinely new kind of decor prop
  means writing a new draw function, not dropping in a PNG. Palette/font/UI
  swaps remain data-only.
- If sprite-based art is ever wanted, the map schema's shape data does not
  translate; that would be a rework, not a swap.
