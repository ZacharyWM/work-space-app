// pure geometry over MapData: floor collision, movement clamp, zone hit-testing (step 1.2)
import type { MapData, Point, Rect, Zone } from "./map";

// point-in-rect with inclusive edges (prototype semantics)
function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// true when the point lies on any floor plate
export function inFloor(map: MapData, x: number, y: number): boolean {
  return map.floors.some((f) => inRect(x, y, f));
}

// per-axis clamp copied from the prototype: x moves first, then y is tested
// against the updated x — blocked axes stop while the free axis slides
export function clampMove(map: MapData, from: Point, to: Point): Point {
  const x = inFloor(map, to.x, from.y) ? to.x : from.x;
  const y = inFloor(map, x, to.y) ? to.y : from.y;
  return { x, y };
}

// one straight-line step of up to `dist` from `from` toward `to`, clamped to
// the floor plates (notes/011 double-click-to-move). clampMove slides along
// blocked edges; a step that moves neither axis returns `from` unchanged, which
// callers treat as "give up". within `dist` of the target, the step lands on it
export function stepToward(map: MapData, from: Point, to: Point, dist: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= dist) return clampMove(map, from, to);
  const s = dist / d;
  return clampMove(map, from, { x: from.x + dx * s, y: from.y + dy * s });
}

// first zone containing the point (edges inclusive); null means open space
export function zoneAt(map: MapData, x: number, y: number): Zone | null {
  return map.zones.find((z) => inRect(x, y, z.rect)) ?? null;
}

// closed rects intersecting: overlapping area OR a shared edge/corner
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

// first pair of zones that overlap or touch, or null when all are disjoint —
// zoneAt edges are inclusive, so even a shared edge makes membership ambiguous
export function firstZoneOverlap(map: MapData): [Zone, Zone] | null {
  for (let i = 0; i < map.zones.length; i++) {
    for (let j = i + 1; j < map.zones.length; j++) {
      const a = map.zones[i]!;
      const b = map.zones[j]!;
      if (rectsIntersect(a.rect, b.rect)) return [a, b];
    }
  }
  return null;
}

// zones must not overlap or touch; throws naming the offending pair
export function validateZonesDisjoint(map: MapData): void {
  const pair = firstZoneOverlap(map);
  if (pair) throw new Error(`zones overlap: "${pair[0].id}" and "${pair[1].id}"`);
}

// bounds for owner-edited maps (notes/010 map editor): keeps a custom layout
// finite, renderable, and inside a sane coordinate box
export const MAP_LIMITS = {
  floors: 60,
  zones: 40,
  decor: 200,
  pads: 12,
  gameTables: 4,
  npcs: 12,
  // world coordinate box every floor, zone, and the spawn must stay inside
  min: -8000,
  max: 8000,
} as const;

// true when the rect lies fully inside the MAP_LIMITS coordinate box
function rectInBounds(r: Rect): boolean {
  return (
    r.x >= MAP_LIMITS.min &&
    r.y >= MAP_LIMITS.min &&
    r.x + r.w <= MAP_LIMITS.max &&
    r.y + r.h <= MAP_LIMITS.max
  );
}

// why an edited map is refused, as a human-readable line; null = acceptable.
// Shared so the editor disables SAVE on exactly what the server would reject
// (notes/010 map editor). The zod schema already ran — this checks semantics
export function mapEditDenial(map: MapData): string | null {
  if (map.floors.length > MAP_LIMITS.floors) return `too many floor plates (max ${MAP_LIMITS.floors})`;
  if (map.zones.length > MAP_LIMITS.zones) return `too many zones (max ${MAP_LIMITS.zones})`;
  if (map.decor.length > MAP_LIMITS.decor) return `too much decor (max ${MAP_LIMITS.decor})`;
  for (const f of map.floors) {
    if (!rectInBounds(f)) return "a floor plate is out of bounds";
  }
  const ids = new Set<string>();
  for (const z of map.zones) {
    if (!rectInBounds(z.rect)) return `zone "${z.name}" is out of bounds`;
    if (z.name.trim() === "") return "every zone needs a name";
    if (ids.has(z.id)) return `duplicate zone id "${z.id}"`;
    ids.add(z.id);
  }
  const overlap = firstZoneOverlap(map);
  if (overlap) return `zones "${overlap[0].name}" and "${overlap[1].name}" overlap`;
  if (!inFloor(map, map.spawn.x, map.spawn.y)) return "the spawn point must sit on a floor plate";
  // the portal has spawn-point semantics: movable, never deletable, always
  // reachable on foot (space link feature)
  if (!inFloor(map, map.spaceLink.x, map.spaceLink.y)) {
    return "the space link must sit on a floor plate";
  }
  // pads must be reachable on foot; on-floor also implies in-bounds (floors
  // are bounds-checked above)
  if (map.pads.length > MAP_LIMITS.pads) return `too many ship pads (max ${MAP_LIMITS.pads})`;
  for (const p of map.pads) {
    if (!inFloor(map, p.x, p.y)) return "every ship pad must sit on a floor plate";
  }
  // holotables must be reachable on foot too (shuttle race feature)
  if (map.gameTables.length > MAP_LIMITS.gameTables) {
    return `too many game tables (max ${MAP_LIMITS.gameTables})`;
  }
  for (const p of map.gameTables) {
    if (!inFloor(map, p.x, p.y)) return "every game table must sit on a floor plate";
  }
  // NPCs wander out from their anchor, so the anchor must be walkable
  // (notes/014 robot pets)
  if (map.npcs.length > MAP_LIMITS.npcs) {
    return `too many NPCs (max ${MAP_LIMITS.npcs})`;
  }
  for (const p of map.npcs) {
    if (!inFloor(map, p.x, p.y)) return "every NPC must sit on a floor plate";
  }
  return null;
}
