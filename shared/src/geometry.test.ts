// geometry tests against the real map.json (step 1.2 verify)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clampMove, inFloor, MAP_LIMITS, mapEditDenial, stepToward, validateZonesDisjoint, zoneAt } from "./geometry";
import { parseMapData, type MapData } from "./map";

// the real ship layout; geometry cases below reference its plates and zones
const map: MapData = parseMapData(
  JSON.parse(readFileSync(new URL("../../map.json", import.meta.url), "utf8")),
);

describe("inFloor", () => {
  it("accepts points inside a plate and on its edges", () => {
    expect(inFloor(map, 330, 800)).toBe(true); // spawn, on the airlock plate
    expect(inFloor(map, 120, 440)).toBe(true); // med plate top-left corner (inclusive)
    expect(inFloor(map, 380, 720)).toBe(true); // med plate bottom-right corner
  });

  it("rejects points in open space", () => {
    expect(inFloor(map, 0, 0)).toBe(false);
    expect(inFloor(map, 119, 440)).toBe(false); // 1px left of the med plate
    expect(inFloor(map, 500, 200)).toBe(false); // above the main deck, beside the bridge plate
  });
});

describe("clampMove", () => {
  // med plate: x 120..380, y 440..720
  it("blocks the x axis at a plate edge while y keeps moving", () => {
    expect(clampMove(map, { x: 130, y: 500 }, { x: 110, y: 520 })).toEqual({ x: 130, y: 520 });
  });

  it("blocks the y axis at a plate edge while x keeps moving", () => {
    expect(clampMove(map, { x: 130, y: 450 }, { x: 150, y: 430 })).toEqual({ x: 150, y: 450 });
  });

  it("stays put when both axes are blocked", () => {
    expect(clampMove(map, { x: 130, y: 450 }, { x: 110, y: 430 })).toEqual({ x: 130, y: 450 });
  });

  it("tests y against the updated x (prototype order)", () => {
    // from the bridge plate into the neck plate (x 720..880, y 340..470):
    // y 360 is invalid at x 700 but valid once x has moved to 730
    expect(clampMove(map, { x: 700, y: 300 }, { x: 730, y: 360 })).toEqual({ x: 730, y: 360 });
  });

  it("passes an unobstructed move through", () => {
    expect(clampMove(map, { x: 330, y: 800 }, { x: 335, y: 795 })).toEqual({ x: 335, y: 795 });
  });
});

describe("stepToward (notes/011 double-click-to-move)", () => {
  // med plate: x 120..380, y 440..720
  it("takes a distance-limited step along the straight line to the target", () => {
    // 3-4-5 triangle: a 5px step from (200,500) toward (230,540) lands at (203,504)
    expect(stepToward(map, { x: 200, y: 500 }, { x: 230, y: 540 }, 5)).toEqual({ x: 203, y: 504 });
  });

  it("lands exactly on a target closer than the step distance", () => {
    expect(stepToward(map, { x: 200, y: 500 }, { x: 202, y: 503 }, 5)).toEqual({ x: 202, y: 503 });
  });

  it("slides along a plate edge when one axis is blocked", () => {
    // x is blocked at the med plate's left edge (120); y still advances
    const p = stepToward(map, { x: 125, y: 500 }, { x: 25, y: 600 }, 10);
    expect(p.x).toBe(125);
    expect(p.y).toBeCloseTo(500 + 10 / Math.hypot(100, 100) * 100, 5);
  });

  it("returns the start unchanged when both axes are blocked", () => {
    // straight into the plate's top-left corner from inside: both axes clamp
    expect(stepToward(map, { x: 120, y: 440 }, { x: 20, y: 340 }, 10)).toEqual({ x: 120, y: 440 });
  });
});

describe("zoneAt", () => {
  it("finds the zone containing a point", () => {
    expect(zoneAt(map, 800, 200)?.id).toBe("bridge");
    expect(zoneAt(map, 500, 600)?.id).toBe("opsA");
  });

  it("includes zone boundaries", () => {
    // bridge rect: x 600..1000, y 90..310
    expect(zoneAt(map, 600, 90)?.id).toBe("bridge"); // top-left corner
    expect(zoneAt(map, 1000, 310)?.id).toBe("bridge"); // bottom-right corner
    expect(zoneAt(map, 600, 200)?.id).toBe("bridge"); // left edge
  });

  it("returns null in open space", () => {
    expect(zoneAt(map, 330, 800)).toBeNull(); // spawn is outside every zone
    expect(zoneAt(map, 1001, 200)).toBeNull(); // 1px right of the bridge
  });
});

describe("validateZonesDisjoint", () => {
  // minimal valid map with the given zones
  const mapWith = (zones: MapData["zones"]): MapData => ({
    floors: [{ x: 0, y: 0, w: 100, h: 100, r: 0 }],
    zones,
    decor: [],
    pads: [],
    gameTables: [],
    npcs: [],
    spaceLink: { x: 0, y: 0 },
    spawn: { x: 0, y: 0 },
  });

  it("accepts the real map's zones", () => {
    expect(() => validateZonesDisjoint(map)).not.toThrow();
  });

  it("rejects overlapping zones, naming the pair", () => {
    const overlapping = mapWith([
      { id: "a", name: "A", rect: { x: 0, y: 0, w: 20, h: 20 } },
      { id: "b", name: "B", rect: { x: 10, y: 10, w: 20, h: 20 } },
    ]);
    expect(() => validateZonesDisjoint(overlapping)).toThrow(/"a" and "b"/);
  });

  it("rejects zones sharing an edge (ambiguous for inclusive zoneAt)", () => {
    const touching = mapWith([
      { id: "a", name: "A", rect: { x: 0, y: 0, w: 20, h: 20 } },
      { id: "b", name: "B", rect: { x: 20, y: 0, w: 20, h: 20 } },
    ]);
    expect(() => validateZonesDisjoint(touching)).toThrow(/"a" and "b"/);
  });
});

describe("mapEditDenial (notes/010 map editor)", () => {
  // a small valid layout the cases below break one rule at a time
  const base: MapData = {
    floors: [{ x: 0, y: 0, w: 400, h: 300, r: 12 }],
    zones: [
      { id: "a", name: "A", rect: { x: 20, y: 20, w: 100, h: 100 } },
      { id: "b", name: "B", pod: true, rect: { x: 200, y: 20, w: 100, h: 100 } },
    ],
    decor: [],
    pads: [],
    gameTables: [],
    npcs: [],
    spaceLink: { x: 350, y: 250 },
    spawn: { x: 50, y: 250 },
  };

  it("accepts the real map and the base layout", () => {
    expect(mapEditDenial(map)).toBeNull();
    expect(mapEditDenial(base)).toBeNull();
  });

  it("rejects overlapping zones, naming them", () => {
    const bad = {
      ...base,
      zones: [base.zones[0]!, { id: "b", name: "B", rect: { x: 60, y: 60, w: 100, h: 100 } }],
    };
    expect(mapEditDenial(bad)).toMatch(/"A" and "B" overlap/);
  });

  it("rejects a spawn point off every floor plate", () => {
    expect(mapEditDenial({ ...base, spawn: { x: -50, y: -50 } })).toMatch(/spawn/);
  });

  it("rejects a space link off every floor plate (space link feature)", () => {
    expect(mapEditDenial({ ...base, spaceLink: { x: -50, y: -50 } })).toMatch(/space link/);
  });

  it("rejects duplicate zone ids", () => {
    const bad = {
      ...base,
      zones: [base.zones[0]!, { id: "a", name: "A2", rect: { x: 200, y: 20, w: 100, h: 100 } }],
    };
    expect(mapEditDenial(bad)).toMatch(/duplicate zone id/);
  });

  it("rejects a blank zone name", () => {
    const bad = {
      ...base,
      zones: [{ id: "a", name: "   ", rect: { x: 20, y: 20, w: 100, h: 100 } }],
    };
    expect(mapEditDenial(bad)).toMatch(/name/);
  });

  it("rejects geometry outside the coordinate box", () => {
    const far = MAP_LIMITS.max + 100;
    expect(
      mapEditDenial({ ...base, floors: [...base.floors, { x: far, y: 0, w: 100, h: 100, r: 0 }] }),
    ).toMatch(/out of bounds/);
    expect(
      mapEditDenial({
        ...base,
        zones: [{ id: "a", name: "A", rect: { x: MAP_LIMITS.min - 200, y: 0, w: 100, h: 100 } }],
      }),
    ).toMatch(/out of bounds/);
  });

  it("rejects layouts past the element caps", () => {
    const floors = Array.from({ length: MAP_LIMITS.floors + 1 }, (_, i) => ({
      x: i * 10,
      y: 0,
      w: 5,
      h: 5,
      r: 0,
    }));
    expect(mapEditDenial({ ...base, floors: [...base.floors, ...floors] })).toMatch(/too many floor/);
  });

  it("accepts a pad on a floor plate, rejects one off it (ship pads)", () => {
    expect(mapEditDenial({ ...base, pads: [{ x: 150, y: 250 }] })).toBeNull();
    expect(mapEditDenial({ ...base, pads: [{ x: 700, y: 700 }] })).toMatch(/floor plate/);
  });

  it("rejects layouts past the pad cap (ship pads)", () => {
    const pads = Array.from({ length: MAP_LIMITS.pads + 1 }, (_, i) => ({ x: 10 + i, y: 250 }));
    expect(mapEditDenial({ ...base, pads })).toMatch(/too many ship pads/);
  });

  it("accepts a game table on a floor plate, rejects one off it (shuttle race)", () => {
    expect(mapEditDenial({ ...base, gameTables: [{ x: 150, y: 250, game: "race" }] })).toBeNull();
    expect(mapEditDenial({ ...base, gameTables: [{ x: 150, y: 250, game: "blast" }] })).toBeNull();
    expect(mapEditDenial({ ...base, gameTables: [{ x: 700, y: 700, game: "race" }] })).toMatch(
      /floor plate/,
    );
  });

  it("rejects layouts past the game-table cap (shuttle race)", () => {
    const gameTables = Array.from({ length: MAP_LIMITS.gameTables + 1 }, (_, i) => ({
      x: 10 + i,
      y: 250,
      game: "race" as const,
    }));
    expect(mapEditDenial({ ...base, gameTables })).toMatch(/too many game tables/);
  });

  it("accepts an NPC on a floor plate, rejects one off it (notes/014 robot pets)", () => {
    expect(mapEditDenial({ ...base, npcs: [{ x: 150, y: 250, kind: "dog" }] })).toBeNull();
    expect(mapEditDenial({ ...base, npcs: [{ x: 150, y: 250, kind: "bot" }] })).toBeNull();
    expect(mapEditDenial({ ...base, npcs: [{ x: 700, y: 700, kind: "dog" }] })).toMatch(
      /floor plate/,
    );
  });

  it("rejects layouts past the NPC cap (notes/014 robot pets)", () => {
    const npcs = Array.from({ length: MAP_LIMITS.npcs + 1 }, (_, i) => ({
      x: 10 + i,
      y: 250,
      kind: "dog" as const,
    }));
    expect(mapEditDenial({ ...base, npcs })).toMatch(/too many NPCs/);
  });
});
