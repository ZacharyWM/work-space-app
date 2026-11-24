// decor items (notes/017): the prop library anyone aboard may place, and the
// pure rules deciding where placing and removing are allowed — shared so the
// client pre-checks exactly what the server enforces
import { z } from "zod";
import { inFloor, zoneAt } from "./geometry";
import type { MapData } from "./map";

// every placeable kind, grouped as the tray lists them: work, comfort, drinks,
// green, ship-native, character. The client draws each procedurally (ADR 0002);
// the server only validates the tag
export const ITEM_KINDS = [
  // work
  "desk",
  "deskL",
  "standingDesk",
  "execDesk",
  "glassDesk",
  "benchDesk",
  "chair",
  "monitor",
  "bookshelf",
  "whiteboard",
  "cabinet",
  "meetingTable",
  // comfort
  "couch",
  "beanbag",
  "sideTable",
  // one rug — the blue colorway it used to ship as is now just a color on this
  // one, and rows written as "rugBlue" are migrated to it server-side
  "rug",
  "lamp",
  "coffee",
  "cooler",
  // drinks — small enough to stand on a desk, using the depth nudge
  "mug",
  "beerMug",
  "teaCup",
  "teapot",
  "wineGlass",
  "waterBottle",
  "sodaCan",
  // green
  "plant",
  "bonsai",
  "flowerVase",
  "cactus",
  "orchid",
  "snakePlant",
  "succulents",
  "monstera",
  "sunflower",
  "flowerBox",
  // ship-native
  "crate",
  "locker",
  "rack",
  "tank",
  // character
  "arcade",
  "jukebox",
  "trophy",
  "duck",
  "cat",
] as const;

export const itemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof itemKindSchema>;

// how far a prop may be sized up or down from its authored art, and the step
// the size slider moves in. The floor keeps a prop readable, the ceiling keeps
// the biggest one (a rug) roughly inside a single pod
export const ITEM_SCALE_MIN = 0.5;
export const ITEM_SCALE_MAX = 2.5;
export const ITEM_SCALE_STEP = 0.1;
export const ITEM_SCALE_DEFAULT = 1;

// bound a requested size and quantize it, so float noise from a slider (and a
// forged value from a client) can't reach the db. The server re-runs this
export function clampItemScale(scale: number): number {
  if (!Number.isFinite(scale)) return ITEM_SCALE_DEFAULT;
  const bounded = Math.min(ITEM_SCALE_MAX, Math.max(ITEM_SCALE_MIN, scale));
  return Math.round(bounded * 100) / 100;
}

// draw-order nudge, in world px. Props are drawn back-to-front by the deck
// point they stand on, so a monitor placed on a meeting table — its contact
// point above the table's — is covered by the table. depth biases that sort
// key alone and never where the prop draws: nudge the monitor forward and it
// beats the table, while a crewmate walking in front of the table still
// covers both. Bounded so a nudged prop can't jump a room's worth of depth,
// and stepped on the placement grid so the two buttons feel like the drag snap
export const ITEM_DEPTH_STEP = 20;
export const ITEM_DEPTH_MAX = 80;
export const ITEM_DEPTH_DEFAULT = 0;

// bound and quantize a requested nudge; the server re-runs this
export function clampItemDepth(depth: number): number {
  if (!Number.isFinite(depth)) return ITEM_DEPTH_DEFAULT;
  return Math.round(Math.min(ITEM_DEPTH_MAX, Math.max(-ITEM_DEPTH_MAX, depth)));
}

// a prop's color override: one #rrggbb, or null for the color it was authored
// in. Only the kinds whose art declares a tintable slot use it (see the client's
// ITEM_ART); the rest carry it harmlessly. The client derives the highlight and
// shadow shades from this one value, so a single hex is the whole override
export const itemColorSchema = z.string().regex(/^#[0-9a-f]{6}$/);

// accept what a color input can produce — any case, and the #rgb shorthand —
// and fold it to the one canonical form the db stores. null (and anything
// unparseable, including a forged value from a client) means "authored color".
// The server re-runs this
export function normalizeItemColor(color: unknown): string | null {
  if (typeof color !== "string") return null;
  const hex = color.trim().toLowerCase();
  // #rgb is the same color as #rrggbb with every digit doubled
  const long = /^#[0-9a-f]{3}$/.test(hex) ? `#${[...hex.slice(1)].map((d) => d + d).join("")}` : hex;
  return itemColorSchema.safeParse(long).success ? long : null;
}

// one placed item as it rides the welcome / itemPlaced messages and the db row:
// server-assigned id, the kind, the deck point the prop stands on, the size it
// was placed at, its draw-order nudge, and its color override. Every field but
// the first four defaults, so a row written before that field existed — and an
// older server's welcome — still parses
export const placedItemSchema = z.object({
  id: z.string().min(1),
  kind: itemKindSchema,
  x: z.number(),
  y: z.number(),
  scale: z.number().min(ITEM_SCALE_MIN).max(ITEM_SCALE_MAX).default(ITEM_SCALE_DEFAULT),
  depth: z.number().min(-ITEM_DEPTH_MAX).max(ITEM_DEPTH_MAX).default(ITEM_DEPTH_DEFAULT),
  color: itemColorSchema.nullable().default(null),
});
export type PlacedItem = z.infer<typeof placedItemSchema>;

// how many props one workspace may hold; the server enforces it inside the
// insert so racing placements can't slip past
export const MAX_ITEMS_PER_WORKSPACE = 300;

// why placing at a point is refused; null = allowed
export type PlacementDenial = "offFloor" | "notYourPod";

// placement rule: props stand on the deck, anywhere on it — open space and
// every zone — except inside a pod somebody else has claimed. podOwners maps
// pod zone id -> owning clerk user id
export function placementDenialAt(
  map: MapData,
  x: number,
  y: number,
  podOwners: ReadonlyMap<string, string>,
  userId: string,
): PlacementDenial | null {
  if (!inFloor(map, x, y)) return "offFloor";
  return removalDenialAt(map, x, y, podOwners, userId);
}

// removal (and move-from) rule: only a pod claimed by someone else protects
// its props — open space, other zones, and unclaimed pods are communal
export function removalDenialAt(
  map: MapData,
  x: number,
  y: number,
  podOwners: ReadonlyMap<string, string>,
  userId: string,
): "notYourPod" | null {
  const zone = zoneAt(map, x, y);
  if (!zone?.pod) return null;
  const owner = podOwners.get(zone.id);
  return owner !== undefined && owner !== userId ? "notYourPod" : null;
}
