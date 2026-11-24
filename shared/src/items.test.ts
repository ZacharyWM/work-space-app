// decor placement/removal rule tests (notes/017): the deck is communal — every
// zone takes props — except a pod somebody else has claimed. Exercised on a
// tiny synthetic map, like the geometry tests
import { describe, expect, it } from "vitest";
import {
  clampItemDepth,
  clampItemScale,
  ITEM_DEPTH_MAX,
  ITEM_DEPTH_STEP,
  ITEM_KINDS,
  ITEM_SCALE_MAX,
  ITEM_SCALE_MIN,
  itemKindSchema,
  normalizeItemColor,
  placedItemSchema,
  placementDenialAt,
  removalDenialAt,
} from "./items";
import type { MapData } from "./map";

// one floor plate holding a pod, a plain zone, and open space; anything past
// x=300 or y=100 lies off the floor entirely
const map: MapData = {
  floors: [{ x: 0, y: 0, w: 300, h: 100, r: 0 }],
  zones: [
    { id: "podA", name: "POD A", pod: true, rect: { x: 0, y: 0, w: 100, h: 100 } },
    { id: "lounge", name: "LOUNGE", rect: { x: 150, y: 0, w: 100, h: 100 } },
  ],
  decor: [],
  pads: [],
  gameTables: [],
  npcs: [],
  spaceLink: { x: 280, y: 50 },
  spawn: { x: 280, y: 50 },
};

// podA claimed by u1 throughout; u2 is everyone else
const owners = new Map([["podA", "u1"]]);

describe("placementDenialAt", () => {
  it("allows open space for anyone", () => {
    expect(placementDenialAt(map, 280, 50, owners, "u1")).toBeNull();
    expect(placementDenialAt(map, 280, 50, owners, "u2")).toBeNull();
  });

  it("refuses points off every floor plate", () => {
    expect(placementDenialAt(map, 5, 500, owners, "u1")).toBe("offFloor");
  });

  it("allows plain zones for anyone", () => {
    expect(placementDenialAt(map, 200, 50, owners, "u1")).toBeNull();
    expect(placementDenialAt(map, 200, 50, owners, "u2")).toBeNull();
  });

  it("allows a claimed pod for its owner only", () => {
    expect(placementDenialAt(map, 50, 50, owners, "u1")).toBeNull();
    expect(placementDenialAt(map, 50, 50, owners, "u2")).toBe("notYourPod");
  });

  it("allows an unclaimed pod for anyone", () => {
    expect(placementDenialAt(map, 50, 50, new Map(), "u2")).toBeNull();
  });

  it("refuses an off-floor point before the pod check", () => {
    // the pod rect extends past the plate; the floor rule decides first
    expect(placementDenialAt(map, 50, 400, owners, "u2")).toBe("offFloor");
  });
});

describe("removalDenialAt", () => {
  it("lets anyone remove from open space and plain zones", () => {
    expect(removalDenialAt(map, 280, 50, owners, "u2")).toBeNull();
    expect(removalDenialAt(map, 200, 50, owners, "u2")).toBeNull();
  });

  it("protects a claimed pod from everyone but its owner", () => {
    expect(removalDenialAt(map, 50, 50, owners, "u1")).toBeNull();
    expect(removalDenialAt(map, 50, 50, owners, "u2")).toBe("notYourPod");
  });

  it("leaves orphaned props in an unclaimed pod removable", () => {
    expect(removalDenialAt(map, 50, 50, new Map(), "u2")).toBeNull();
  });

  it("ignores the floor rule — a prop stranded off-deck can still be cleared", () => {
    expect(removalDenialAt(map, 5, 500, owners, "u2")).toBeNull();
  });
});

describe("the library", () => {
  it("has no duplicate kinds", () => {
    expect(new Set(ITEM_KINDS).size).toBe(ITEM_KINDS.length);
  });

  it("validates kinds against the library", () => {
    expect(itemKindSchema.safeParse("desk").success).toBe(true);
    expect(itemKindSchema.safeParse("hologram").success).toBe(false);
  });

  it("requires an id, a known kind, and a position on a placed item", () => {
    expect(placedItemSchema.safeParse({ id: "i1", kind: "plant", x: 10, y: 20 }).success).toBe(true);
    expect(placedItemSchema.safeParse({ id: "", kind: "plant", x: 10, y: 20 }).success).toBe(false);
    expect(placedItemSchema.safeParse({ id: "i1", kind: "sofa", x: 10, y: 20 }).success).toBe(false);
    expect(placedItemSchema.safeParse({ id: "i1", kind: "plant", x: 10 }).success).toBe(false);
  });

  it("sizes an item that carries no scale at the authored size", () => {
    const parsed = placedItemSchema.parse({ id: "i1", kind: "plant", x: 10, y: 20 });
    expect(parsed.scale).toBe(1);
  });

  it("sorts an item that carries no depth by where it stands", () => {
    const parsed = placedItemSchema.parse({ id: "i1", kind: "plant", x: 10, y: 20 });
    expect(parsed.depth).toBe(0);
  });

  it("paints an item that carries no color in the color its art was drawn in", () => {
    const parsed = placedItemSchema.parse({ id: "i1", kind: "plant", x: 10, y: 20 });
    expect(parsed.color).toBeNull();
  });

  it("keeps a placed item's color only when it is a canonical hex", () => {
    const at = (color: unknown) => placedItemSchema.safeParse({ id: "i1", kind: "plant", x: 1, y: 2, color });
    expect(at("#3d6b8e").success).toBe(true);
    expect(at(null).success).toBe(true);
    // the db and the wire carry one form only; anything else is the client's
    // job to normalize before it sends
    expect(at("#3D6B8E").success).toBe(false);
    expect(at("#3d6").success).toBe(false);
    expect(at("red").success).toBe(false);
  });

  it("folds what a color input can produce to the one canonical form", () => {
    expect(normalizeItemColor("#3D6B8E")).toBe("#3d6b8e");
    expect(normalizeItemColor("  #3d6b8e  ")).toBe("#3d6b8e");
    // #rgb is the same color with every digit doubled
    expect(normalizeItemColor("#F0A")).toBe("#ff00aa");
  });

  it("treats anything it cannot parse as the authored color, not an error", () => {
    // a forged value from a client reaches the server as one of these
    for (const bad of [null, undefined, "", "red", "#12345", "#gggggg", 42, {}]) {
      expect(normalizeItemColor(bad)).toBeNull();
    }
  });

  it("refuses a placed item nudged past the stacking bound", () => {
    const item = { id: "i1", kind: "plant", x: 10, y: 20 };
    expect(placedItemSchema.safeParse({ ...item, depth: -ITEM_DEPTH_MAX }).success).toBe(true);
    expect(placedItemSchema.safeParse({ ...item, depth: ITEM_DEPTH_MAX + 1 }).success).toBe(false);
  });

  it("refuses a placed item sized outside the slider's range", () => {
    const item = { id: "i1", kind: "plant", x: 10, y: 20 };
    expect(placedItemSchema.safeParse({ ...item, scale: ITEM_SCALE_MAX }).success).toBe(true);
    expect(placedItemSchema.safeParse({ ...item, scale: ITEM_SCALE_MAX + 0.1 }).success).toBe(false);
    expect(placedItemSchema.safeParse({ ...item, scale: 0 }).success).toBe(false);
  });
});

describe("clampItemScale", () => {
  it("bounds a size to the slider's range", () => {
    expect(clampItemScale(99)).toBe(ITEM_SCALE_MAX);
    expect(clampItemScale(0)).toBe(ITEM_SCALE_MIN);
    expect(clampItemScale(-4)).toBe(ITEM_SCALE_MIN);
  });

  it("quantizes away slider float noise", () => {
    expect(clampItemScale(0.1 + 0.2)).toBe(0.5); // below the floor, and exact
    expect(clampItemScale(1.7000000000000002)).toBe(1.7);
  });

  it("falls back to the authored size on a value that isn't a number", () => {
    expect(clampItemScale(Number.NaN)).toBe(1);
    expect(clampItemScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("clampItemDepth", () => {
  it("bounds a nudge to the stacking range", () => {
    expect(clampItemDepth(4000)).toBe(ITEM_DEPTH_MAX);
    expect(clampItemDepth(-4000)).toBe(-ITEM_DEPTH_MAX);
    expect(clampItemDepth(ITEM_DEPTH_STEP)).toBe(ITEM_DEPTH_STEP);
  });

  it("quantizes to whole world pixels", () => {
    expect(clampItemDepth(20.4)).toBe(20);
    expect(clampItemDepth(-19.6)).toBe(-20);
  });

  it("falls back to no nudge on a value that isn't a number", () => {
    expect(clampItemDepth(Number.NaN)).toBe(0);
    expect(clampItemDepth(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
