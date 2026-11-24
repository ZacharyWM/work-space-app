// schema tests for map.ts, incl. parsing the real repo-root map.json (step 1.2 verify)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMapData } from "./map";

// the real map shipped at the repo root
const mapJson: unknown = JSON.parse(
  readFileSync(new URL("../../map.json", import.meta.url), "utf8"),
);

describe("parseMapData", () => {
  it("parses the repo-root map.json", () => {
    const map = parseMapData(mapJson);
    // 9 original plates + the flight-deck corridor and deck (notes/003)
    expect(map.floors).toHaveLength(11);
    expect(map.zones.map((z) => z.id)).toEqual([
      "bridge",
      "med",
      "opsA",
      "opsB",
      "opsC",
      "opsD",
      "opsE",
      "opsF",
      "opsG",
      "opsH",
      "opsI",
      "opsJ",
      "cargo",
      "flight",
      "lounge",
    ]);
    // default map ships with no decor props; rooms start empty
    expect(map.decor).toHaveLength(0);
    expect(map.spawn).toEqual({ x: 330, y: 800 });
    // the three flight-deck launch pads, now map data (ship pads feature)
    expect(map.pads).toEqual([
      { x: 1465, y: 975 },
      { x: 1585, y: 975 },
      { x: 1705, y: 975 },
    ]);
    // the lounge holotables: one race, one blasters (holotable games)
    expect(map.gameTables).toEqual([
      { x: 820, y: 1060, game: "race" },
      { x: 680, y: 1060, game: "blast" },
    ]);
  });

  it("defaults gameTables to empty on a map that predates them (shuttle race)", () => {
    const old = {
      floors: [{ x: 0, y: 0, w: 100, h: 100, r: 0 }],
      zones: [],
      decor: [],
      pads: [],
      spawn: { x: 50, y: 50 },
    };
    expect(parseMapData(old).gameTables).toEqual([]);
  });

  it("defaults the space link to the spawn on a map that predates it (space link)", () => {
    const old = {
      floors: [{ x: 0, y: 0, w: 100, h: 100, r: 0 }],
      zones: [],
      decor: [],
      pads: [],
      spawn: { x: 50, y: 50 },
    };
    // the spawn is the one point guaranteed walkable on every saved map
    expect(parseMapData(old).spaceLink).toEqual({ x: 50, y: 50 });
    // an authored portal survives as written
    expect(parseMapData({ ...old, spaceLink: { x: 20, y: 30 } }).spaceLink).toEqual({ x: 20, y: 30 });
  });

  it("defaults a game table's game to race, rejects unknown games (shuttle blasters)", () => {
    const withTable = (table: unknown) => ({
      floors: [{ x: 0, y: 0, w: 100, h: 100, r: 0 }],
      zones: [],
      decor: [],
      pads: [],
      gameTables: [table],
      spawn: { x: 50, y: 50 },
    });
    // a table saved before the game field existed hosts the original race
    expect(parseMapData(withTable({ x: 50, y: 60 })).gameTables).toEqual([
      { x: 50, y: 60, game: "race" },
    ]);
    expect(parseMapData(withTable({ x: 50, y: 60, game: "blast" })).gameTables).toEqual([
      { x: 50, y: 60, game: "blast" },
    ]);
    expect(() => parseMapData(withTable({ x: 50, y: 60, game: "chess" }))).toThrow(
      /invalid map data/,
    );
  });

  it("defaults npcs to empty on a map that predates them, rejects unknown kinds (notes/014)", () => {
    const withNpcs = (npcs?: unknown[]) => ({
      floors: [{ x: 0, y: 0, w: 100, h: 100, r: 0 }],
      zones: [],
      decor: [],
      pads: [],
      ...(npcs ? { npcs } : {}),
      spawn: { x: 50, y: 50 },
    });
    expect(parseMapData(withNpcs()).npcs).toEqual([]);
    expect(parseMapData(withNpcs([{ x: 10, y: 20, kind: "dog" }])).npcs).toEqual([
      { x: 10, y: 20, kind: "dog" },
    ]);
    expect(parseMapData(withNpcs([{ x: 10, y: 20, kind: "bot" }])).npcs).toEqual([
      { x: 10, y: 20, kind: "bot" },
    ]);
    expect(() => parseMapData(withNpcs([{ x: 10, y: 20, kind: "cat" }]))).toThrow(
      /invalid map data/,
    );
    expect(() => parseMapData(withNpcs([{ x: 10, y: 20 }]))).toThrow(/invalid map data/);
  });

  it("backfills the legacy pads into a pre-pads map that kept the deck plate", () => {
    const legacy = {
      floors: [{ x: 1380, y: 800, w: 400, h: 330, r: 18 }],
      zones: [],
      decor: [],
      spawn: { x: 1400, y: 820 },
    };
    expect(parseMapData(legacy).pads).toHaveLength(3);
    // no deck plate: nothing to stand the legacy pads on, so none appear
    const noDeck = { ...legacy, floors: [{ x: 0, y: 0, w: 100, h: 100, r: 0 }], spawn: { x: 50, y: 50 } };
    expect(parseMapData(noDeck).pads).toEqual([]);
    // an explicit empty pads array is a deliberate choice, never backfilled
    expect(parseMapData({ ...legacy, pads: [] }).pads).toEqual([]);
  });

  it("rejects a map with a missing spawn point", () => {
    expect(() => parseMapData({ floors: [{ x: 0, y: 0, w: 1, h: 1, r: 0 }], zones: [], decor: [] }))
      .toThrow(/invalid map data/);
  });

  it("rejects a floor with non-positive dimensions", () => {
    expect(() =>
      parseMapData({
        floors: [{ x: 0, y: 0, w: 0, h: 10, r: 0 }],
        zones: [],
        decor: [],
        spawn: { x: 0, y: 0 },
      }),
    ).toThrow(/invalid map data/);
  });

  it("rejects a decor item with an unknown type tag", () => {
    expect(() =>
      parseMapData({
        floors: [{ x: 0, y: 0, w: 10, h: 10, r: 0 }],
        zones: [],
        decor: [{ type: "hologram", x: 0, y: 0 }],
        spawn: { x: 0, y: 0 },
      }),
    ).toThrow(/invalid map data/);
  });

  it("rejects a decor item missing its variant geometry", () => {
    expect(() =>
      parseMapData({
        floors: [{ x: 0, y: 0, w: 10, h: 10, r: 0 }],
        zones: [],
        decor: [{ type: "crate", x: 0, y: 0 }], // no side length s
        spawn: { x: 0, y: 0 },
      }),
    ).toThrow(/invalid map data/);
  });
});
