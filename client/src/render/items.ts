// decor item art (notes/017): pixel-art props authored in the same logical-pixel
// space as the avatar sprites (sprite.ts) and blitted at the same 1.6x
// nearest-neighbor scale, so a plant and a person read as one world. Procedural,
// no image assets (ADR 0002) — every prop is fillRect runs baked into a cached
// offscreen canvas, with the few living details (lamp pool, rack LEDs) drawn
// live on top from the rAF clock
import type { ItemKind } from "shared";

// world px per logical sprite pixel — the avatars' SPRITE_SCALE (draw.ts)
export const ITEM_SCALE = 1.6;

// prop palette: warm woods, fabrics and foliage against the cold hull. These
// are sprite art (like sprite.ts's fixed colors), not theme values
const P = {
  outline: "#20192B",
  woodTop: "#C08A4E",
  wood: "#9A6A38",
  woodDark: "#6F4824",
  metalTop: "#A7B2C4",
  metal: "#78849A",
  metalDark: "#525C70",
  fabricTop: "#5E8CBB",
  fabric: "#3F6690",
  fabricDark: "#2C4A6B",
  cushionTop: "#CD8460",
  cushion: "#AC6440",
  leafLight: "#7BC46B",
  leaf: "#54A356",
  leafDark: "#3A7942",
  potTop: "#D07A4C",
  pot: "#AF5F38",
  potDark: "#84462A",
  cream: "#EDE0C8",
  creamDark: "#C6B79A",
  rugRed: "#9E4A46",
  rugRedDark: "#8A3E3C",
  rugBlue: "#3D6B8E",
  rugBlueDark: "#325B79",
  rugTrim: "#E0C9A4",
  screen: "#141C33",
  screenLit: "#7FE3FF",
  lampGlow: "#FFD79A",
  glass: "#8FD3E8",
  water: "#5FB6D9",
  amber: "#E8A33D",
  gold: "#E3B44A",
  furLight: "#B9A48C",
  fur: "#8E7A63",
  furDark: "#5F5142",
  ink: "#3F6690",
  inkRed: "#C0553F",
  book: ["#C0553F", "#3F7FA8", "#C79A3F", "#6E5FA8"] as const,
  // drinkware: glazed ceramic, poured drinks, and the glass they sit in
  porcelain: "#F2EFE6",
  porcelainDark: "#CFC8B8",
  ceramic: "#7FA9C4",
  ceramicMid: "#A6C6DA",
  ceramicDark: "#5E85A0",
  beerGold: "#E8A93D",
  beerLight: "#F2C56A",
  beerFoam: "#F6ECD2",
  coffeeDark: "#5A2E1B",
  tea: "#B4653A",
  wine: "#8E2B45",
  wineLight: "#B03E5C",
  glassPale: "#BCE9F5",
  glassLit: "#E4F5FB",
  steel: "#D6DEE9",
  canLight: "#D9705C",
  // the newer desks: chrome legs, a glass slab, a green leather inlay
  chrome: "#C3CCDA",
  glassSlab: "#9FBED4",
  glassSlabDark: "#7A98B0",
  leather: "#3C6B4E",
  // flowers, and the soil and moss they grow out of
  petalPink: "#E48AA8",
  petalRed: "#D9534F",
  petalYellow: "#EFC94C",
  petalPurple: "#9B6FC7",
  petalWhite: "#F3EDE0",
  sunCenter: "#7A4A22",
  sunMid: "#96603A",
  soil: "#4A3524",
  moss: "#4E8F4A",
  steam: "#C9D6DE",
};

// ground shadow under a prop, matching the avatars' (draw.ts drawAvatar)
const SHADOW = "rgba(0,0,0,.35)";

// --- color overrides -------------------------------------------------------
// A prop carries one hex (shared placedItemSchema.color) and its art declares
// which of its shades that hex replaces. The other two shades of the ramp are
// derived, so the crew picks one color and the pixel shading survives.

// the three shades a tintable prop paints its recolorable part in. A painter
// uses only the ones its art actually has — a flat one-color prop reads .base
// alone — and everything outside the slot (outlines, screens, foliage) stays
// fixed, which is what keeps a recolored prop still looking like this library
export type ItemTint = { light: string; base: string; dark: string };

// how far the derived shades sit from the picked color, in HSL lightness. These
// match the gaps already in the palette: wood -> woodTop is about +0.12 and
// wood -> woodDark about -0.12, and the fabric and metal ramps agree
const TINT_LIGHT = 0.13;
const TINT_DARK = -0.12;

// #rrggbb -> the same color with its HSL lightness shifted by dl and clamped.
// Hue and saturation are untouched, so a shade stays the same color
function shade(hex: string, dl: number): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  // achromatic input has no hue to preserve, so shift the gray directly
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l2 = Math.min(1, Math.max(0, l + dl));
  // back to rgb
  const c = (1 - Math.abs(2 * l2 - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l2 - c / 2;
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const hex2 = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex2(r1)}${hex2(g1)}${hex2(b1)}`;
}

// the ramp for a prop whose art paints its slot in one flat color: the two
// shades it never reads are derived, so no invented palette entries are needed
function triple(base: string): ItemTint {
  return { light: shade(base, TINT_LIGHT), base, dark: shade(base, TINT_DARK) };
}

// never read — the ramp handed to an art with no tintable slot
const NO_TINT: ItemTint = { light: P.outline, base: P.outline, dark: P.outline };

// the ramps the library's tintable props are authored in. Naming them once
// keeps the uncolored art exactly what it always was: a prop with no override
// paints from these same constants
const WOOD: ItemTint = { light: P.woodTop, base: P.wood, dark: P.woodDark };
const METAL: ItemTint = { light: P.metalTop, base: P.metal, dark: P.metalDark };
const FABRIC: ItemTint = { light: P.fabricTop, base: P.fabric, dark: P.fabricDark };
const CUSHION: ItemTint = { ...triple(P.cushion), light: P.cushionTop };
const POT: ItemTint = { light: P.potTop, base: P.pot, dark: P.potDark };
const CERAMIC: ItemTint = { light: P.ceramicMid, base: P.ceramic, dark: P.ceramicDark };
const CREAM: ItemTint = { light: P.petalWhite, base: P.cream, dark: P.creamDark };
const PORCELAIN: ItemTint = { light: P.petalWhite, base: P.porcelain, dark: P.porcelainDark };
const GLASS_SLAB: ItemTint = { light: P.glassLit, base: P.glassSlab, dark: P.glassSlabDark };
const RUG: ItemTint = { light: P.rugTrim, base: P.rugRed, dark: P.rugRedDark };

// the twelve colors the picker offers as one click, before the wheel. Drawn
// from the palette the ship is already painted in, so the common case lands on
// something that belongs here. Lowercased because that is the one form the
// schema, the wire and the db accept (shared normalizeItemColor) — the palette
// itself is written in caps
export const ITEM_SWATCHES: readonly string[] = [
  P.wood,
  P.woodDark,
  P.cream,
  P.metal,
  P.metalDark,
  P.fabric,
  P.rugBlue,
  P.leaf,
  P.leather,
  P.amber,
  P.inkRed,
  P.petalPurple,
].map((hex) => hex.toLowerCase());

// filled rect in logical pixels
function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

// rect with a 1px dark border, the pixel-art way: dark rect one pixel larger
// underneath, fill on top
function plate(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  px(g, x - 1, y - 1, w + 2, h + 2, P.outline);
  px(g, x, y, w, h, c);
}

// a rect with its four corner pixels cut, the cheapest pixel-art round shape —
// foliage, cushions and bowls read as blobs instead of blocks
function blobFill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  px(g, x + 1, y, w - 2, 1, c);
  px(g, x, y + 1, w, h - 2, c);
  px(g, x + 1, y + h - 1, w - 2, 1, c);
}

// blobFill with the 1px dark border
function blob(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  blobFill(g, x - 1, y - 1, w + 2, h + 2, P.outline);
  blobFill(g, x, y, w, h, c);
}

// a 3/4 box: top face (depth d) above a front face (height h), outlined as one
// silhouette so the two faces read as a single solid
function box(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  d: number,
  h: number,
  top: string,
  front: string,
): void {
  px(g, x - 1, y - 1, w + 2, d + h + 2, P.outline);
  px(g, x, y, w, d, top);
  px(g, x, y + d, w, h, front);
}

// a group of overlapping blobs painted as one mass: outline every lobe first,
// then fill them, so the overlaps don't draw dark seams through the middle of
// the foliage. Every canopy in the library is built this way
function cluster(
  g: CanvasRenderingContext2D,
  lobes: readonly (readonly [number, number, number, number])[],
  fills: readonly string[],
): void {
  for (const [x, y, w, h] of lobes) blobFill(g, x - 1, y - 1, w + 2, h + 2, P.outline);
  lobes.forEach(([x, y, w, h], i) => blobFill(g, x, y, w, h, fills[i]!));
}

// per-kind art: the logical-pixel footprint, the painter that fills it, and —
// for the props the crew may recolor — the ramp its slot is authored in.
// (0,0) is the box's top-left; the bottom edge is where the prop meets the deck.
// An art with no tint ignores the ramp it is handed and always paints the same
type Art = {
  label: string;
  w: number;
  h: number;
  tint?: ItemTint;
  paint: (g: CanvasRenderingContext2D, c: ItemTint) => void;
};

export const ITEM_ART: Record<ItemKind, Art> = {
  // --- work ---------------------------------------------------------------
  // wood slab on two legs, with a mug and a stack of paper on top
  desk: {
    label: "DESK",
    w: 34,
    h: 20,
    tint: WOOD,
    paint(g, c) {
      px(g, 3, 16, 4, 4, c.dark); // legs
      px(g, 27, 16, 4, 4, c.dark);
      box(g, 1, 8, 32, 5, 5, c.light, c.base);
      px(g, 5, 15, 24, 1, c.dark); // drawer seam on the front face
      plate(g, 6, 4, 7, 5, P.cream); // paper stack
      px(g, 7, 5, 5, 1, P.creamDark);
      plate(g, 23, 3, 5, 6, P.metalTop); // mug
      px(g, 28, 5, 2, 2, P.metal); // handle
    },
  },
  // corner desk: a main run with a return stepped forward and lower, so the
  // two slabs read as one L rather than two desks pushed together
  deskL: {
    label: "L-DESK",
    w: 46,
    h: 22,
    tint: WOOD,
    paint(g, c) {
      px(g, 4, 15, 4, 7, c.dark); // legs of the main run
      px(g, 22, 15, 4, 7, c.dark);
      box(g, 1, 6, 29, 5, 5, c.light, c.base);
      px(g, 4, 14, 21, 1, c.dark); // drawer seam
      box(g, 27, 12, 18, 5, 5, c.light, c.base); // the return
      px(g, 29, 20, 14, 1, c.dark);
      plate(g, 6, 2, 7, 4, P.cream); // paper stack
      px(g, 7, 3, 5, 1, P.creamDark);
      plate(g, 17, 1, 6, 5, P.metalDark); // small screen
      px(g, 18, 2, 4, 3, P.screen);
      px(g, 19, 3, 2, 1, P.screenLit);
      plate(g, 34, 13, 4, 4, P.porcelain); // mug on the return
      px(g, 35, 13, 2, 1, P.coffeeDark);
    },
  },
  // sit-stand desk raised to standing height, laptop docked on top
  standingDesk: {
    label: "STANDING DESK",
    w: 32,
    h: 28,
    tint: WOOD,
    paint(g, c) {
      px(g, 6, 13, 3, 13, P.metalDark); // columns
      px(g, 23, 13, 3, 13, P.metalDark);
      px(g, 5, 17, 5, 1, P.metal); // telescoping seam
      px(g, 22, 17, 5, 1, P.metal);
      plate(g, 3, 26, 9, 2, P.metal); // feet
      plate(g, 20, 26, 9, 2, P.metal);
      box(g, 1, 8, 30, 5, 4, c.light, c.base);
      px(g, 26, 13, 4, 2, P.amber); // height switch
      plate(g, 11, 2, 11, 6, P.metalTop); // laptop
      px(g, 12, 3, 9, 4, P.screen);
      px(g, 13, 4, 5, 1, P.screenLit);
      px(g, 13, 6, 3, 1, P.amber);
    },
  },
  // executive desk: dark wood slab over two drawer pedestals, leather inlay
  execDesk: {
    label: "EXEC DESK",
    w: 40,
    h: 24,
    tint: WOOD,
    paint(g, c) {
      box(g, 1, 4, 38, 6, 4, c.light, c.base);
      plate(g, 3, 14, 11, 10, c.dark); // pedestals
      plate(g, 26, 14, 11, 10, c.dark);
      for (let i = 0; i < 3; i++) {
        px(g, 4, 17 + i * 3, 9, 1, c.light); // drawer seams
        px(g, 27, 17 + i * 3, 9, 1, c.light);
      }
      px(g, 7, 15, 3, 1, P.gold); // pulls
      px(g, 30, 15, 3, 1, P.gold);
      px(g, 8, 6, 24, 3, P.leather); // leather inlay on the top face
      px(g, 9, 6, 22, 1, P.gold);
      plate(g, 3, 0, 6, 4, P.cream); // paper tray
      px(g, 4, 1, 4, 1, P.creamDark);
      plate(g, 31, 0, 4, 4, P.gold); // banker's lamp
    },
  },
  // minimal glass desk on chrome legs, with a thin screen
  glassDesk: {
    label: "GLASS DESK",
    w: 30,
    h: 20,
    tint: GLASS_SLAB,
    paint(g, c) {
      px(g, 4, 11, 2, 9, P.chrome); // legs
      px(g, 24, 11, 2, 9, P.chrome);
      px(g, 3, 19, 4, 1, P.metalDark);
      px(g, 23, 19, 4, 1, P.metalDark);
      box(g, 1, 8, 28, 4, 2, c.base, c.dark);
      px(g, 4, 9, 11, 1, c.light); // reflection streaks
      px(g, 17, 9, 5, 1, c.light);
      plate(g, 9, 4, 12, 4, P.metalDark);
      px(g, 10, 5, 10, 2, P.screen);
      px(g, 11, 5, 4, 1, P.screenLit);
    },
  },
  // two-person bench desk with a fabric privacy divider down the middle
  benchDesk: {
    label: "BENCH DESK",
    w: 46,
    h: 20,
    tint: WOOD,
    paint(g, c) {
      px(g, 4, 15, 4, 5, P.metalDark);
      px(g, 38, 15, 4, 5, P.metalDark);
      box(g, 1, 8, 44, 5, 4, c.light, c.base);
      px(g, 3, 16, 40, 1, c.dark);
      plate(g, 18, 1, 10, 7, P.fabric); // divider
      px(g, 19, 2, 8, 2, P.fabricTop);
      plate(g, 6, 4, 6, 4, P.cream); // a station each side
      plate(g, 33, 4, 6, 4, P.cream);
      px(g, 14, 6, 3, 2, P.metalTop);
      px(g, 30, 6, 3, 2, P.metalTop);
    },
  },
  // swivel chair: blue fabric back over a warm cushion seat on a metal star base
  chair: {
    label: "CHAIR",
    w: 14,
    h: 20,
    tint: FABRIC,
    paint(g, c) {
      blob(g, 3, 0, 8, 9, c.base); // backrest, narrower than the seat
      px(g, 4, 1, 6, 2, c.light);
      box(g, 1, 9, 12, 3, 3, P.cushionTop, P.cushion); // seat
      px(g, 6, 15, 2, 2, P.metalDark); // post
      plate(g, 2, 17, 10, 2, P.metal); // star base
      px(g, 3, 18, 8, 1, P.metalDark);
    },
  },
  // monitor on a stand, screen lit with a few code lines
  monitor: {
    label: "MONITOR",
    w: 18,
    h: 20,
    paint(g) {
      plate(g, 1, 0, 16, 12, P.metalDark);
      px(g, 2, 1, 14, 9, P.screen);
      px(g, 3, 2, 6, 1, P.screenLit);
      px(g, 3, 4, 9, 1, P.screenLit);
      px(g, 3, 6, 4, 1, P.amber);
      px(g, 7, 13, 4, 3, P.metal); // neck
      box(g, 4, 16, 10, 2, 2, P.metalTop, P.metal); // foot
    },
  },
  // three stocked shelves in a wood case
  bookshelf: {
    label: "BOOKSHELF",
    w: 22,
    h: 26,
    tint: WOOD,
    paint(g, c) {
      box(g, 1, 0, 20, 3, 21, c.light, c.dark);
      for (let row = 0; row < 3; row++) {
        const y = 5 + row * 6;
        px(g, 3, y + 4, 16, 1, c.base); // shelf lip
        for (let i = 0; i < 5; i++) {
          const c = P.book[(i + row * 2) % P.book.length]!;
          px(g, 3 + i * 3, y + (i % 2), 2, 4 - (i % 2), c);
        }
      }
    },
  },
  // whiteboard on castors, scrawled on in two colors
  whiteboard: {
    label: "WHITEBOARD",
    w: 26,
    h: 24,
    paint(g) {
      plate(g, 1, 0, 24, 16, P.metalTop);
      px(g, 2, 1, 22, 14, P.cream);
      px(g, 4, 3, 10, 1, P.ink); // scrawl
      px(g, 4, 5, 14, 1, P.ink);
      px(g, 4, 7, 7, 1, P.inkRed);
      px(g, 14, 9, 7, 4, P.ink);
      px(g, 15, 10, 5, 2, P.cream);
      px(g, 4, 16, 2, 6, P.metal); // legs
      px(g, 20, 16, 2, 6, P.metal);
      px(g, 3, 22, 4, 2, P.metalDark); // castors
      px(g, 19, 22, 4, 2, P.metalDark);
    },
  },
  // filing cabinet: three drawers with pull handles
  cabinet: {
    label: "CABINET",
    w: 18,
    h: 22,
    tint: METAL,
    paint(g, c) {
      box(g, 1, 0, 16, 3, 17, c.light, c.base);
      for (let i = 0; i < 3; i++) {
        const y = 5 + i * 5;
        px(g, 2, y + 4, 14, 1, c.dark); // drawer seam
        px(g, 7, y + 1, 4, 2, c.dark); // handle
      }
      px(g, 2, 20, 14, 1, P.outline);
    },
  },
  // round meeting table, wide enough for a lobby to gather around
  meetingTable: {
    label: "MEETING TABLE",
    w: 44,
    h: 22,
    tint: WOOD,
    paint(g, c) {
      px(g, 9, 16, 4, 5, c.dark); // legs
      px(g, 31, 16, 4, 5, c.dark);
      blob(g, 0, 2, 44, 12, c.light); // top face
      px(g, 2, 12, 40, 4, c.base); // front edge
      px(g, 3, 15, 38, 1, c.dark);
      blob(g, 17, 5, 10, 5, c.base); // center inlay
    },
  },
  // --- comfort ------------------------------------------------------------
  // two-seat couch: back, arms, and a pair of warm cushions
  couch: {
    label: "COUCH",
    w: 34,
    h: 22,
    tint: CUSHION,
    paint(g, c) {
      plate(g, 2, 0, 30, 9, c.base); // back
      px(g, 4, 1, 26, 2, c.light);
      box(g, 1, 9, 32, 5, 4, c.light, c.base); // seat
      plate(g, 0, 6, 4, 10, c.base); // arms
      plate(g, 30, 6, 4, 10, c.base);
      px(g, 17, 10, 1, 4, c.base); // cushion split
      px(g, 5, 19, 3, 2, P.woodDark); // feet
      px(g, 26, 19, 3, 2, P.woodDark);
    },
  },
  // beanbag: one slumped fabric blob with a highlight
  beanbag: {
    label: "BEANBAG",
    w: 22,
    h: 16,
    tint: FABRIC,
    paint(g, c) {
      blob(g, 0, 3, 22, 13, c.base);
      blobFill(g, 3, 4, 12, 5, c.light);
      px(g, 6, 10, 10, 1, c.dark); // seam
    },
  },
  // small round side table on a single pedestal
  sideTable: {
    label: "SIDE TABLE",
    w: 16,
    h: 16,
    tint: WOOD,
    paint(g, c) {
      px(g, 6, 8, 4, 5, c.dark); // pedestal
      plate(g, 4, 13, 8, 2, c.dark); // foot
      blob(g, 0, 2, 16, 7, c.light); // top face
      px(g, 1, 8, 14, 2, c.base); // edge
    },
  },
  // area rug: flat on the deck (no height), woven field with a trim border. The
  // blue colorway this used to ship a second kind for is now just a color
  rug: {
    label: "RUG",
    w: 44,
    h: 28,
    tint: RUG,
    paint(g, c) {
      plate(g, 0, 0, 44, 28, c.base);
      px(g, 2, 2, 40, 1, P.rugTrim);
      px(g, 2, 25, 40, 1, P.rugTrim);
      px(g, 2, 2, 1, 24, P.rugTrim);
      px(g, 41, 2, 1, 24, P.rugTrim);
      for (let i = 0; i < 6; i++) px(g, 6 + i * 6, 6, 4, 16, c.dark); // weave stripes
      px(g, 18, 11, 8, 6, P.rugTrim); // center motif
      px(g, 20, 13, 4, 2, c.base);
    },
  },
  // floor lamp: cream shade over a thin pole; the light pool is drawn live
  lamp: {
    label: "LAMP",
    w: 14,
    h: 28,
    tint: CREAM,
    paint(g, c) {
      plate(g, 1, 1, 12, 7, c.base);
      px(g, 2, 2, 10, 2, c.dark);
      px(g, 3, 8, 8, 1, P.lampGlow); // lit underside
      px(g, 6, 9, 2, 15, P.metalDark); // pole
      box(g, 3, 24, 8, 2, 2, P.metalTop, P.metal); // base
    },
  },
  // coffee machine: carafe on a warmer plate, brew light on
  coffee: {
    label: "COFFEE MACHINE",
    w: 16,
    h: 22,
    paint(g) {
      box(g, 1, 0, 14, 3, 17, P.metalTop, P.metal);
      px(g, 3, 5, 10, 6, P.metalDark); // brew head recess
      px(g, 4, 11, 8, 5, P.woodDark); // carafe
      px(g, 5, 12, 6, 3, P.coffeeDark); // coffee
      px(g, 12, 12, 2, 2, P.metalDark); // handle
      px(g, 3, 3, 3, 1, P.inkRed); // brew light
      px(g, 2, 17, 12, 2, P.metalDark); // warmer plate
    },
  },
  // water cooler: blue bottle over a white body with a spout
  cooler: {
    label: "WATER COOLER",
    w: 14,
    h: 26,
    paint(g) {
      blob(g, 2, 0, 10, 9, P.glass); // bottle
      blobFill(g, 3, 2, 5, 4, "#BCE9F5"); // highlight
      px(g, 5, 8, 4, 2, P.metalDark); // neck
      box(g, 1, 10, 12, 3, 13, P.cream, P.creamDark); // body
      px(g, 5, 15, 4, 3, P.water); // sight glass
      px(g, 6, 18, 2, 2, P.metalDark); // spout
      px(g, 2, 24, 10, 1, P.outline);
    },
  },
  // --- drinks -------------------------------------------------------------
  // Every one of these is drawn oversized against real-world proportion: a
  // to-scale mug would be six logical px, which is invisible on the deck. They
  // are sized to read on their own and to sit on a desk via the depth nudge.
  // Handle loops are painted in the vessel's own light color rather than the
  // outline — a dark ring disappears against the deck plates.
  mug: {
    label: "COFFEE MUG",
    w: 12,
    h: 12,
    tint: PORCELAIN,
    paint(g, c) {
      px(g, 3, 0, 1, 3, P.steam); // steam
      px(g, 5, 0, 1, 4, P.steam);
      px(g, 7, 1, 1, 3, P.steam);
      px(g, 8, 5, 2, 1, c.base); // handle, behind the body
      px(g, 10, 6, 1, 3, c.base);
      px(g, 8, 9, 2, 1, c.base);
      plate(g, 1, 4, 8, 8, c.base);
      px(g, 2, 4, 6, 1, P.coffeeDark); // coffee surface
      px(g, 2, 8, 6, 2, P.rugBlue); // band
      px(g, 2, 5, 1, 3, c.dark); // shading
    },
  },
  beerMug: {
    label: "BEER MUG",
    w: 14,
    h: 14,
    paint(g) {
      blobFill(g, 1, 0, 9, 4, P.outline); // foam head, spilling over the rim
      blobFill(g, 1, 1, 9, 3, P.beerFoam);
      px(g, 10, 5, 2, 1, P.beerLight); // handle
      px(g, 12, 6, 1, 3, P.beerLight);
      px(g, 10, 9, 2, 1, P.beerLight);
      plate(g, 1, 3, 9, 11, P.beerGold);
      px(g, 2, 3, 7, 2, P.beerFoam);
      px(g, 2, 6, 2, 7, P.beerLight); // glass facets
      px(g, 7, 6, 1, 7, P.beerLight);
      px(g, 5, 7, 2, 1, P.beerFoam); // bubbles
      px(g, 4, 10, 2, 1, P.beerFoam);
    },
  },
  teaCup: {
    label: "TEA CUP",
    w: 14,
    h: 12,
    tint: PORCELAIN,
    paint(g, c) {
      px(g, 8, 0, 2, 3, P.petalWhite); // bag tag on its string
      px(g, 8, 3, 1, 2, P.creamDark);
      px(g, 10, 4, 2, 1, c.base); // handle
      px(g, 12, 5, 1, 1, c.base);
      px(g, 10, 6, 2, 1, c.base);
      plate(g, 2, 3, 8, 6, c.base);
      px(g, 3, 3, 6, 1, P.tea); // tea surface
      px(g, 3, 4, 1, 4, c.dark); // shading
      px(g, 4, 8, 5, 1, c.dark); // foot
      plate(g, 0, 10, 14, 2, c.base); // saucer
      px(g, 1, 11, 12, 1, c.dark);
    },
  },
  teapot: {
    label: "TEAPOT",
    w: 19,
    h: 14,
    tint: CERAMIC,
    paint(g, c) {
      plate(g, 6, 0, 5, 2, c.base); // lid
      px(g, 8, 0, 1, 1, c.dark); // knob
      blob(g, 2, 2, 13, 11, c.base);
      blobFill(g, 4, 4, 5, 3, c.light); // highlight
      px(g, 4, 10, 9, 1, c.dark);
      // handle and spout draw after the body so their outlines separate them
      plate(g, 0, 5, 3, 5, c.dark);
      plate(g, 14, 5, 4, 2, c.base);
      plate(g, 16, 2, 2, 4, c.base);
    },
  },
  wineGlass: {
    label: "WINE GLASS",
    w: 11,
    h: 18,
    tint: { ...triple(P.wine), light: P.wineLight },
    paint(g, c) {
      blob(g, 1, 0, 9, 8, P.glassPale);
      blobFill(g, 2, 2, 7, 6, c.base);
      px(g, 2, 1, 2, 2, P.glassLit);
      px(g, 3, 3, 2, 1, c.light); // meniscus glint
      plate(g, 4, 8, 3, 6, P.glassPale); // stem
      px(g, 5, 9, 1, 4, P.glassLit);
      plate(g, 2, 14, 7, 2, P.glassPale); // foot
      px(g, 3, 15, 5, 1, P.glassLit);
    },
  },
  waterBottle: {
    label: "WATER BOTTLE",
    w: 9,
    h: 17,
    tint: triple(P.rugBlue),
    paint(g, c) {
      plate(g, 3, 0, 3, 2, P.metalDark); // cap
      plate(g, 1, 2, 7, 15, P.metalTop);
      px(g, 2, 3, 2, 12, P.steel); // brushed highlight
      px(g, 2, 6, 6, 3, c.base); // wrap label
      px(g, 3, 7, 4, 1, P.glass);
      px(g, 2, 15, 6, 1, P.metalDark);
    },
  },
  sodaCan: {
    label: "SODA CAN",
    w: 9,
    h: 13,
    tint: { ...triple(P.inkRed), light: P.canLight },
    paint(g, c) {
      plate(g, 1, 1, 7, 12, c.base);
      px(g, 2, 0, 5, 1, P.metalTop); // lid
      px(g, 4, 0, 2, 1, P.metalDark); // tab
      px(g, 2, 4, 5, 3, P.cream); // label band
      px(g, 3, 5, 3, 1, c.base);
      px(g, 2, 2, 1, 9, c.light);
      px(g, 2, 9, 5, 1, P.amber);
    },
  },
  // --- green --------------------------------------------------------------
  // potted plant: terracotta pot under a three-lobed canopy
  plant: {
    label: "PLANT",
    w: 18,
    h: 24,
    tint: POT,
    paint(g, c) {
      px(g, 8, 10, 2, 7, P.leafDark); // stem
      cluster(
        g,
        [
          [1, 4, 8, 8],
          [9, 5, 8, 8],
          [4, 0, 10, 10],
        ],
        [P.leafDark, P.leafDark, P.leaf],
      );
      blobFill(g, 6, 2, 4, 3, P.leafLight); // highlight
      box(g, 3, 16, 12, 3, 4, c.light, c.base); // pot
      px(g, 4, 20, 10, 2, c.dark);
      px(g, 5, 22, 8, 1, P.outline);
    },
  },
  // bonsai: the pads cap the branch ends and leave the trunk's midsection bare,
  // so the lean reads — the whole point of the silhouette
  bonsai: {
    label: "BONSAI",
    w: 26,
    h: 22,
    tint: POT,
    paint(g, c) {
      px(g, 11, 8, 4, 8, P.woodDark); // trunk, lit down one side
      px(g, 11, 8, 1, 8, P.wood);
      px(g, 13, 5, 3, 4, P.woodDark);
      px(g, 6, 10, 6, 2, P.woodDark); // branches
      px(g, 15, 9, 6, 2, P.woodDark);
      cluster(
        g,
        [
          [0, 6, 11, 5],
          [16, 5, 10, 5],
          [8, 0, 14, 6],
        ],
        [P.leafDark, P.leafDark, P.leaf],
      );
      blobFill(g, 11, 1, 7, 3, P.leafLight);
      blobFill(g, 2, 7, 5, 2, P.leaf);
      blobFill(g, 18, 6, 5, 2, P.leaf);
      px(g, 4, 15, 18, 1, P.moss); // moss on the soil
      box(g, 3, 16, 20, 2, 3, c.light, c.dark); // shallow glazed tray
      px(g, 5, 21, 16, 1, P.outline);
      px(g, 4, 19, 1, 2, c.base); // tray feet
      px(g, 21, 19, 1, 2, c.base);
    },
  },
  // cut flowers in a glazed vase
  flowerVase: {
    label: "FLOWER VASE",
    w: 17,
    h: 23,
    tint: CERAMIC,
    paint(g, c) {
      px(g, 7, 8, 1, 7, P.leafDark); // stems
      px(g, 5, 9, 1, 6, P.leafDark);
      px(g, 10, 7, 1, 8, P.leafDark);
      px(g, 3, 11, 2, 1, P.leaf); // leaves
      px(g, 11, 12, 2, 1, P.leaf);
      cluster(
        g,
        [
          [2, 6, 5, 4],
          [7, 3, 6, 5],
          [9, 9, 5, 4],
        ],
        [P.petalPink, P.petalRed, P.petalYellow],
      );
      px(g, 9, 5, 2, 2, P.petalYellow); // bloom centers
      px(g, 3, 7, 2, 1, P.petalWhite);
      plate(g, 4, 14, 9, 9, c.base); // vase
      px(g, 5, 15, 2, 7, c.light);
      px(g, 5, 20, 7, 1, c.dark);
    },
  },
  // barrel cactus with two arms and a single bloom
  cactus: {
    label: "CACTUS",
    w: 15,
    h: 21,
    tint: POT,
    paint(g, c) {
      plate(g, 5, 3, 4, 12, P.leaf);
      px(g, 6, 4, 1, 10, P.leafLight); // ribs
      px(g, 8, 5, 1, 9, P.leafDark);
      plate(g, 2, 8, 3, 3, P.leaf); // left arm
      px(g, 2, 6, 2, 3, P.leaf);
      plate(g, 10, 6, 3, 3, P.leaf); // right arm
      px(g, 11, 4, 2, 3, P.leaf);
      blobFill(g, 5, 1, 4, 3, P.petalPink); // bloom
      px(g, 6, 2, 2, 1, P.petalYellow);
      for (const [x, y] of [
        [4, 6],
        [9, 9],
        [4, 12],
        [9, 12],
      ] as const) {
        px(g, x, y, 1, 1, P.creamDark); // spines
      }
      box(g, 2, 15, 11, 2, 4, c.light, c.base);
      px(g, 3, 19, 9, 1, c.dark);
    },
  },
  // orchid: blooms stepping down an arching cane out of a cream pot
  orchid: {
    label: "ORCHID",
    w: 16,
    h: 26,
    tint: CREAM,
    paint(g, c) {
      box(g, 4, 21, 9, 2, 3, c.base, c.dark); // pot
      px(g, 5, 25, 7, 1, P.outline);
      blobFill(g, 1, 18, 7, 3, P.leaf); // strap leaves
      blobFill(g, 8, 18, 7, 3, P.leafDark);
      px(g, 9, 15, 2, 6, P.leafDark); // the cane, drawn before the blooms
      px(g, 7, 10, 2, 6, P.leafDark);
      px(g, 5, 5, 2, 6, P.leafDark);
      blob(g, 10, 15, 5, 4, P.petalPink); // unopened bud
      blob(g, 4, 9, 9, 6, P.petalWhite);
      px(g, 7, 11, 3, 3, P.petalPurple); // lip
      px(g, 8, 10, 1, 1, P.petalYellow);
      blob(g, 0, 1, 10, 7, P.petalWhite);
      px(g, 4, 3, 3, 3, P.petalPurple);
      px(g, 5, 2, 1, 1, P.petalYellow);
    },
  },
  // snake plant: upright blades, which read in pixels where fern fronds don't
  snakePlant: {
    label: "SNAKE PLANT",
    w: 17,
    h: 27,
    tint: CREAM,
    paint(g, c) {
      const blades = [
        [2, 9, 13],
        [5, 4, 18],
        [8, 1, 21],
        [11, 3, 19],
        [13, 8, 14],
      ] as const;
      blades.forEach(([x, y, h], i) => {
        plate(g, x, y, 3, h, i % 2 ? P.leaf : P.leafDark);
        px(g, x + 1, y + 2, 1, h - 4, P.leafLight); // pale centre stripe
        if (i % 2 === 0) px(g, x, y + 1, 1, h - 2, P.petalYellow); // yellow margin
      });
      box(g, 3, 21, 11, 2, 4, c.base, c.dark);
      px(g, 4, 26, 9, 1, P.outline);
    },
  },
  // three rosettes in a wooden tray — the desk-sized green option
  succulents: {
    label: "SUCCULENT TRAY",
    w: 24,
    h: 14,
    tint: WOOD,
    paint(g, c) {
      box(g, 1, 9, 22, 2, 4, c.light, c.dark);
      px(g, 2, 13, 20, 1, P.outline);
      // the pots stand on the tray's top face, so they draw after it
      (
        [
          [2, 2],
          [9, 1],
          [16, 2],
        ] as const
      ).forEach(([x, y], i) => {
        px(g, x + 1, y + 5, 4, 4, i === 1 ? P.creamDark : P.potTop);
        blob(g, x, y, 6, 5, i === 1 ? P.leafLight : P.leaf);
        blobFill(g, x + 2, y + 1, 2, 2, P.leafDark);
      });
    },
  },
  // monstera: three split leaves on their own stems, the tallest prop here
  monstera: {
    label: "MONSTERA",
    w: 28,
    h: 31,
    tint: CREAM,
    paint(g, c) {
      px(g, 13, 17, 2, 9, P.leafDark); // stems
      px(g, 10, 14, 2, 6, P.leafDark);
      px(g, 16, 12, 2, 7, P.leafDark);
      cluster(
        g,
        [
          [1, 10, 12, 9],
          [14, 7, 13, 10],
          [6, 0, 14, 10],
        ],
        [P.leafDark, P.leaf, P.leaf],
      );
      // the splits, cut in from each leaf's outer edge
      px(g, 1, 13, 5, 1, P.outline);
      px(g, 1, 16, 4, 1, P.outline);
      px(g, 22, 10, 5, 1, P.outline);
      px(g, 23, 14, 4, 1, P.outline);
      px(g, 6, 3, 5, 1, P.outline);
      px(g, 15, 6, 5, 1, P.outline);
      blobFill(g, 9, 2, 5, 3, P.leafLight);
      box(g, 8, 26, 12, 2, 4, c.base, c.dark);
      px(g, 9, 30, 10, 1, P.outline);
    },
  },
  sunflower: {
    label: "SUNFLOWER",
    w: 17,
    h: 29,
    tint: POT,
    paint(g, c) {
      px(g, 8, 12, 2, 14, P.leafDark); // stalk
      px(g, 4, 17, 4, 2, P.leaf); // leaves
      px(g, 10, 20, 4, 2, P.leaf);
      blob(g, 2, 1, 13, 11, P.petalYellow);
      for (const [x, y] of [
        [4, 3],
        [11, 3],
        [2, 7],
        [13, 7],
        [7, 1],
        [7, 10],
      ] as const) {
        px(g, x, y, 2, 1, P.amber); // petal separations
      }
      blobFill(g, 5, 4, 7, 5, P.sunCenter); // seed head
      px(g, 6, 5, 3, 2, P.sunMid);
      box(g, 4, 25, 10, 2, 3, c.light, c.base);
      px(g, 5, 29, 8, 1, P.outline);
    },
  },
  // window box of mixed blooms — wide and low, for edging a pod
  flowerBox: {
    label: "FLOWER BOX",
    w: 28,
    h: 13,
    tint: WOOD,
    paint(g, c) {
      box(g, 1, 6, 26, 2, 6, c.light, c.base);
      px(g, 2, 7, 24, 1, P.soil);
      px(g, 3, 11, 22, 1, c.dark);
      for (const [x, petal] of [
        [3, P.petalRed],
        [8, P.petalYellow],
        [13, P.petalWhite],
        [18, P.petalPink],
        [23, P.petalPurple],
      ] as const) {
        px(g, x + 1, 4, 1, 3, P.leafDark); // stem
        blob(g, x, 1, 4, 4, petal);
        px(g, x + 1, 2, 2, 1, P.petalYellow); // center
      }
      px(g, 5, 5, 3, 1, P.leaf); // foliage between the blooms
      px(g, 16, 5, 3, 1, P.leaf);
      px(g, 21, 5, 3, 1, P.leaf);
    },
  },
  // --- ship-native --------------------------------------------------------
  // cargo crate: braced wood box with an amber stencil stripe
  crate: {
    label: "CRATE",
    w: 20,
    h: 18,
    tint: WOOD,
    paint(g, c) {
      box(g, 1, 0, 18, 4, 13, c.light, c.base);
      px(g, 2, 5, 16, 1, c.dark); // brace
      px(g, 2, 15, 16, 1, c.dark);
      px(g, 9, 5, 2, 11, c.dark);
      px(g, 3, 8, 5, 2, P.amber); // stencil
      px(g, 12, 11, 4, 2, P.amber);
    },
  },
  // wall locker: two doors, vent slots, a small handle
  locker: {
    label: "LOCKER",
    w: 16,
    h: 26,
    tint: METAL,
    paint(g, c) {
      box(g, 1, 0, 14, 3, 21, c.light, c.base);
      px(g, 8, 4, 1, 19, c.dark); // door seam
      for (let i = 0; i < 3; i++) {
        px(g, 3, 6 + i * 2, 4, 1, c.dark); // vents
        px(g, 10, 6 + i * 2, 4, 1, c.dark);
      }
      px(g, 6, 14, 2, 3, P.amber); // handles
      px(g, 9, 14, 2, 3, P.amber);
      px(g, 2, 23, 12, 1, P.outline);
    },
  },
  // server rack: dark cabinet whose status LEDs blink live in drawItem
  rack: {
    label: "SERVER RACK",
    w: 18,
    h: 26,
    paint(g) {
      box(g, 1, 0, 16, 3, 21, P.metalDark, "#2B3346");
      for (let i = 0; i < 4; i++) {
        px(g, 3, 5 + i * 4, 12, 3, "#1B2233"); // blades
        px(g, 4, 6 + i * 4, 6, 1, P.metal);
      }
      px(g, 2, 23, 14, 1, P.outline);
    },
  },
  // hydroponic tank: glass cylinder of lit water with a sprout inside
  tank: {
    label: "HYDRO TANK",
    w: 16,
    h: 24,
    paint(g) {
      box(g, 1, 0, 14, 3, 3, P.metalTop, P.metal); // cap
      plate(g, 2, 4, 12, 15, P.water);
      px(g, 3, 5, 3, 13, P.glass); // glass highlight
      px(g, 8, 10, 2, 8, P.leafDark); // sprout
      blobFill(g, 6, 6, 7, 5, P.leaf);
      blobFill(g, 7, 7, 3, 2, P.leafLight);
      box(g, 1, 19, 14, 2, 2, P.metalTop, P.metal); // base
    },
  },
  // --- character ----------------------------------------------------------
  // arcade cabinet: marquee, lit screen with an invader, control panel
  arcade: {
    label: "ARCADE",
    w: 20,
    h: 28,
    tint: triple(P.fabricDark),
    paint(g, c) {
      plate(g, 1, 0, 18, 26, c.base); // body
      px(g, 3, 1, 14, 4, P.cushion); // marquee
      px(g, 4, 2, 12, 1, P.cream);
      plate(g, 3, 6, 14, 10, P.screen);
      px(g, 7, 9, 6, 2, P.screenLit); // invader
      px(g, 6, 11, 8, 1, P.screenLit);
      px(g, 7, 12, 2, 1, P.screenLit);
      px(g, 11, 12, 2, 1, P.screenLit);
      box(g, 2, 17, 16, 3, 3, P.metalTop, P.metal); // control panel
      px(g, 5, 18, 2, 2, P.rugRed); // buttons
      px(g, 13, 18, 2, 2, P.leaf);
      px(g, 2, 24, 16, 2, P.metalDark); // kick plate
    },
  },
  // jukebox: domed chrome top over a warm lit front
  jukebox: {
    label: "JUKEBOX",
    w: 18,
    h: 26,
    tint: triple(P.woodDark),
    paint(g, c) {
      blob(g, 1, 0, 16, 10, P.metalTop); // dome
      blobFill(g, 3, 2, 12, 5, P.amber);
      px(g, 5, 3, 8, 2, P.gold);
      plate(g, 1, 10, 16, 14, c.base); // body
      px(g, 3, 12, 12, 5, P.screen); // record window
      px(g, 7, 13, 4, 3, P.cream);
      px(g, 4, 19, 10, 2, P.amber); // lit strip
      px(g, 2, 23, 14, 1, P.outline);
    },
  },
  // trophy: gold cup with handles on a wood plinth
  trophy: {
    label: "TROPHY",
    w: 14,
    h: 18,
    paint(g) {
      blob(g, 3, 0, 8, 7, P.gold);
      px(g, 4, 1, 3, 2, "#F5D98A"); // shine
      px(g, 1, 2, 2, 3, P.gold); // handles
      px(g, 11, 2, 2, 3, P.gold);
      px(g, 6, 7, 2, 4, P.gold); // stem
      box(g, 3, 11, 8, 2, 4, P.woodTop, P.woodDark); // plinth
    },
  },
  // rubber duck: the debugging companion
  duck: {
    label: "RUBBER DUCK",
    w: 14,
    h: 12,
    paint(g) {
      blob(g, 0, 4, 11, 8, "#E8C25A"); // body
      blob(g, 6, 0, 7, 6, "#E8C25A"); // head
      px(g, 12, 2, 2, 2, "#D9822B"); // bill
      px(g, 9, 2, 1, 1, P.outline); // eye
      px(g, 2, 7, 4, 2, "#D9AE3F"); // wing
    },
  },
  // ship cat: curled up and asleep, tail wrapped around
  cat: {
    label: "SHIP CAT",
    w: 20,
    h: 12,
    tint: { light: P.furLight, base: P.fur, dark: P.furDark },
    paint(g, c) {
      blob(g, 0, 2, 15, 10, c.base); // curled body
      blobFill(g, 2, 4, 7, 3, c.light); // flank highlight
      px(g, 11, 3, 1, 8, c.dark); // seam: the head reads as its own mass
      blob(g, 12, 0, 8, 9, c.base); // head
      px(g, 12, 0, 2, 2, c.dark); // ears
      px(g, 17, 0, 2, 2, c.dark);
      blobFill(g, 14, 5, 5, 3, c.light); // muzzle
      px(g, 14, 4, 2, 1, c.dark); // closed eyes
      px(g, 17, 4, 2, 1, c.dark);
      px(g, 16, 6, 1, 1, c.dark); // nose
      px(g, 1, 8, 9, 2, c.light); // tail curled in front
      px(g, 9, 9, 3, 1, c.light);
    },
  },
};

// whether the crew may recolor this kind — true exactly when its art declares
// which of its shades a color override replaces. The tray dims the rest
export function itemIsColorable(kind: ItemKind): boolean {
  return ITEM_ART[kind].tint !== undefined;
}

// the ramp a prop paints its slot in: the authored one when it carries no
// override, otherwise the picked color with its highlight and shadow derived
function tintOf(kind: ItemKind, color: string | null): ItemTint {
  const authored = ITEM_ART[kind].tint;
  if (authored === undefined) return NO_TINT;
  if (color === null) return authored;
  return { light: shade(color, TINT_LIGHT), base: color, dark: shade(color, TINT_DARK) };
}

// built sprites, keyed by kind and color. The uncolored set is small and fixed,
// but the colored ones are unbounded — a workspace may hold MAX_ITEMS_PER_
// WORKSPACE props in as many distinct colors, and a picker drag mints one per
// step — so this evicts oldest-first once it outgrows a deck's worth
const CACHE_MAX = 400;
const cache = new Map<string, HTMLCanvasElement>();

// bakes one kind's art, in one color, into an offscreen canvas at logical-pixel
// size. color null is the art as drawn
function buildItem(kind: ItemKind, color: string | null): HTMLCanvasElement {
  const key = `${kind}|${color ?? ""}`;
  const hit = cache.get(key);
  if (hit) {
    // touch it: re-inserting moves it to the end of the Map's insertion order,
    // which is what makes the eviction below least-recently-used
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const art = ITEM_ART[kind];
  const cv = document.createElement("canvas");
  // +2 for the 1px outline the painters draw outside the footprint
  cv.width = art.w + 2;
  cv.height = art.h + 2;
  const g = cv.getContext("2d")!; // 2d context never fails on a fresh canvas
  g.translate(1, 1);
  art.paint(g, tintOf(kind, color));
  cache.set(key, cv);
  if (cache.size > CACHE_MAX) {
    // Map iterates in insertion order, so the first key is the coldest
    const coldest = cache.keys().next().value;
    if (coldest !== undefined) cache.delete(coldest);
  }
  return cv;
}

// the baked sprite as a data url, for the tray's <img> previews — the cached
// canvas can only live in one DOM spot, so the tray renders copies. Keyed and
// bounded like the canvases, since the armed tile previews the color the next
// prop stamps at and a picker drag walks through a lot of them
const previewUrls = new Map<string, string>();
export function itemPreviewUrl(kind: ItemKind, color: string | null = null): string {
  const key = `${kind}|${color ?? ""}`;
  let url = previewUrls.get(key);
  if (url === undefined) {
    url = buildItem(kind, color).toDataURL();
    previewUrls.set(key, url);
    if (previewUrls.size > CACHE_MAX) {
      const coldest = previewUrls.keys().next().value;
      if (coldest !== undefined) previewUrls.delete(coldest);
    }
  }
  return url;
}

// the label the tray shows under each preview
export function itemLabel(kind: ItemKind): string {
  return ITEM_ART[kind].label;
}

// world-space size of a prop at the size it was placed at; drives hit-testing
// and the selection frame
export function itemSize(kind: ItemKind, scale: number): { w: number; h: number } {
  const art = ITEM_ART[kind];
  return { w: art.w * ITEM_SCALE * scale, h: art.h * ITEM_SCALE * scale };
}

// the rug lies flat on the deck: it draws under everything and casts no shadow
export function isFlat(kind: ItemKind): boolean {
  return kind === "rug";
}

// draws one prop with its base centered on (x, y) — the deck contact point,
// like an avatar's feet. scale is the prop's own size (the size slider's
// value), color its override (null = the color the art was drawn in), alpha
// ghosts the placement preview
export function drawItem(
  ctx: CanvasRenderingContext2D,
  kind: ItemKind,
  x: number,
  y: number,
  t: number,
  scale: number,
  color: string | null = null,
  alpha = 1,
): void {
  const art = ITEM_ART[kind];
  // one logical sprite pixel in world px at this prop's size — every offset
  // below is in these units, so the whole sprite scales as one
  const u = ITEM_SCALE * scale;
  const w = art.w * u;
  const h = art.h * u;
  ctx.globalAlpha = alpha;
  // the lamp casts a breathing warm pool on the deck, under its own sprite
  if (kind === "lamp") {
    const r = 46 * scale;
    const glow = ctx.createRadialGradient(x, y - 4 * scale, 2, x, y - 4 * scale, r);
    glow.addColorStop(0, `rgba(255,215,154,${0.18 + 0.04 * Math.sin(t / 900 + x)})`);
    glow.addColorStop(1, "rgba(255,215,154,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y - 4 * scale, r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!isFlat(kind)) {
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    ctx.ellipse(x, y - 1, w * 0.36, w * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.drawImage(buildItem(kind, color), x - w / 2 - u, y - h - u, w + 2 * u, h + 2 * u);
  // the rack's status LEDs blink on their own clock, phase keyed by position
  if (kind === "rack") {
    for (let i = 0; i < 4; i++) {
      const on = Math.sin(t / (280 + i * 90) + x + i) > 0;
      ctx.fillStyle = on ? "#7BE38A" : "#2E4C3A";
      ctx.fillRect(x + 3 * u, y - h + (7 + i * 4) * u, 2 * u, u);
    }
  }
  ctx.globalAlpha = 1;
}
