// map data schema: floor plates, zones, decor, and spawn point (step 1.2)
import { z } from "zod";

// axis-aligned rectangle; origin top-left, w/h extend right/down
export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

// a 2d point (spawn, positions)
export const pointSchema = z.object({ x: z.number(), y: z.number() });

// walkable floor plate; r is the corner radius (render-only, not collision)
export const floorSchema = rectSchema.extend({ r: z.number().nonnegative() });

// which game a game table hosts (shuttle blasters feature); tables saved
// before the field existed default to the original shuttle race
export const gameTableGameSchema = z.enum(["race", "blast"]);

// a game table (holotable): a point element plus the game it hosts
export const gameTableSchema = pointSchema.extend({
  game: gameTableGameSchema.default("race"),
});

// decor union (step 4.2): each variant carries exactly the geometry the
// prototype's drawDecor hardcoded; colors and inner details live client-side
export const decorItemSchema = z.discriminatedUnion("type", [
  // bridge viewscreen bar with an accent glow strip along its top edge
  rectSchema.extend({ type: z.literal("screen") }),
  // row of `count` consoles starting at x/y, spaced `gap` apart
  pointSchema.extend({
    type: z.literal("consoleStrip"),
    count: z.number().int().positive(),
    gap: z.number().positive(),
  }),
  // square cargo crate with side length s
  pointSchema.extend({ type: z.literal("crate"), s: z.number().positive() }),
  // med-bay bed; pillow is drawn inside the rect
  rectSchema.extend({ type: z.literal("bed") }),
  // med-bay cross, centered on x/y
  pointSchema.extend({ type: z.literal("cross") }),
  // lounge table, circle of radius r centered on x/y
  pointSchema.extend({ type: z.literal("roundTable"), r: z.number().positive() }),
  // seat circle of radius r (bridge chairs r=10, lounge seats r=9)
  pointSchema.extend({ type: z.literal("seat"), r: z.number().positive() }),
  // ops desk; accent status lights are drawn inside the rect
  rectSchema.extend({ type: z.literal("desk") }),
]);

// which body an NPC wears (notes/014 robot pets): a robot dog or a humanoid robot
export const npcKindSchema = z.enum(["dog", "bot"]);

// an NPC: a point element whose x/y anchors its wander (notes/014 robot pets)
export const npcSchema = pointSchema.extend({ kind: npcKindSchema });

// named zone whose rect drives membership and A/V pairing; pod marks the
// claimable personal zones — the only zones that accept decor (notes/009)
export const zoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rect: rectSchema,
  pod: z.boolean().optional(),
});

// the original hardcoded flight-deck pads (pre-pads flightdeck.ts): backfilled
// into maps saved before pads were part of the layout, but only while the
// legacy deck plate is still present to stand them on
const LEGACY_DECK = { x: 1380, y: 800 };
const LEGACY_PADS: z.infer<typeof pointSchema>[] = [
  { x: 1465, y: 975 },
  { x: 1585, y: 975 },
  { x: 1705, y: 975 },
];

export const mapDataSchema = z
  .object({
    floors: z.array(floorSchema).min(1),
    zones: z.array(zoneSchema),
    decor: z.array(decorItemSchema),
    // shuttle launch pads; the array index is the shipPad wire value. Optional
    // on input only: absent means the map predates pads and gets the legacy trio
    pads: z.array(pointSchema).optional(),
    // holotables (game tables): stand at one to join its game's lobby
    // (shuttle race / shuttle blasters). Optional on input only: absent means none
    gameTables: z.array(gameTableSchema).optional(),
    // wandering NPCs (notes/014 robot pets). Optional on input only: absent means none
    npcs: z.array(npcSchema).optional(),
    // the Space Link portal — every Map has exactly one, like the spawn point
    // (space link feature). Optional on input only: absent means the map
    // predates the portal, which lands at the spawn (guaranteed walkable)
    spaceLink: pointSchema.optional(),
    spawn: pointSchema,
  })
  .transform((m) => ({
    ...m,
    pads:
      m.pads ??
      (m.floors.some((f) => f.x === LEGACY_DECK.x && f.y === LEGACY_DECK.y)
        ? [...LEGACY_PADS]
        : []),
    gameTables: m.gameTables ?? [],
    npcs: m.npcs ?? [],
    spaceLink: m.spaceLink ?? { ...m.spawn },
  }));

export type Rect = z.infer<typeof rectSchema>;
export type Point = z.infer<typeof pointSchema>;
export type Floor = z.infer<typeof floorSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type GameTableGame = z.infer<typeof gameTableGameSchema>;
export type GameTable = z.infer<typeof gameTableSchema>;
export type NpcKind = z.infer<typeof npcKindSchema>;
export type Npc = z.infer<typeof npcSchema>;
export type DecorItem = z.infer<typeof decorItemSchema>;
export type MapData = z.infer<typeof mapDataSchema>;

// parses unknown JSON into MapData; throws one readable error listing every issue
export function parseMapData(input: unknown): MapData {
  const result = mapDataSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid map data:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
