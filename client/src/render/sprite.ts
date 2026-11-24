// pixel avatar sprites (notes/002): the prototype's buildSprite() ported as-is.
// each frame is 20x30 logical pixels drawn into an offscreen canvas, cached by
// appearance + facing + frame; the fixed colors below are sprite art, not theme.
import type { Character } from "shared";

// which way an avatar faces; drives which art variant renders
export type Facing = "up" | "down" | "left" | "right";

// darken a hex color by factor f (sprite shading, prototype shade())
function shade(hex: string, f: number): string {
  const h = hex.replace("#", "");
  const x = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(x, 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

// bounded cache: distinct outfits are few, so wholesale clear is fine (prototype)
const cache = new Map<string, HTMLCanvasElement>();
const CACHE_MAX = 160;

// frame: 0/1 = walk cycle, 2 = idle
export function buildSprite(ch: Character, dir: Facing, frame: number): HTMLCanvasElement {
  const key = [ch.skin, ch.hair, ch.shirt, ch.pants, ch.hat, ch.helmet ? 1 : 0, dir, frame].join("|");
  const cached = cache.get(key);
  if (cached) return cached;
  if (cache.size > CACHE_MAX) cache.clear();
  const cv = document.createElement("canvas");
  cv.width = 20;
  cv.height = 30;
  const g = cv.getContext("2d")!; // 2d context never fails on a fresh canvas
  // left is right art mirrored
  if (dir === "left") {
    g.translate(20, 0);
    g.scale(-1, 1);
  }
  const d = dir === "left" ? "right" : dir;
  // plot one run of pixels in sprite space (origin at the body's center column)
  const P = (gx: number, gy: number, w: number, h: number, col: string): void => {
    g.fillStyle = col;
    g.fillRect(gx + 10, gy + 6, w, h);
  };
  const { skin, shirt, pants } = ch;
  const shirtD = shade(shirt, 0.72);
  const pantsD = shade(pants, 0.72);
  const shoe = "#232B3E";
  const shoeD = "#181F30";
  const hair = ch.hair !== "none" ? ch.hair : null;
  const hairD = hair ? shade(hair, 0.75) : null;
  const f = frame;

  // hips
  P(-4, 17, 8, 1, pants);
  P(-4, 18, 8, 1, pantsD);
  // legs + shoes
  if (d === "right") {
    const o = f === 0 ? 1 : f === 1 ? -1 : 0;
    P(-3 - o, 19, 3, 3, pantsD);
    P(-3 - o, 22, 3, 2, shoeD);
    P(0 + o, 19, 3, 3, pants);
    P(0 + o, 22, 3, 2, shoe);
  } else {
    const lL = f === 0 ? 1 : 0;
    const rL = f === 1 ? 1 : 0;
    P(-4, 19, 3, 3 - lL, pants);
    P(-4, 22 - lL, 3, 2, shoe);
    P(1, 19, 3, 3 - rL, pants);
    P(1, 22 - rL, 3, 2, shoe);
  }
  // torso
  P(-4, 10, 8, 7, shirt);
  P(-4, 16, 8, 1, shirtD);
  if (d === "right") {
    P(-4, 10, 2, 7, shirtD);
    const o = f === 0 ? -1 : f === 1 ? 1 : 0;
    P(-1 + o, 11, 3, 4, shirtD);
    P(0 + o, 15, 2, 2, skin);
  } else {
    const aL = f === 0 ? 1 : 0;
    const aR = f === 1 ? 1 : 0;
    P(-6, 11 + aL, 2, 4, shirt);
    P(-6, 15 + aL, 2, 2, skin);
    P(4, 11 + aR, 2, 4, shirt);
    P(4, 15 + aR, 2, 2, skin);
  }
  // head
  P(-4, 2, 8, 1, skin);
  P(-5, 3, 10, 6, skin);
  P(-4, 9, 8, 1, shade(skin, 0.88));
  // face
  if (d === "down") {
    P(-3, 6, 2, 2, "#1B2233");
    P(1, 6, 2, 2, "#1B2233");
    P(-2, 6, 1, 1, "#F4F8FF");
    P(2, 6, 1, 1, "#F4F8FF");
    P(-5, 8, 1, 1, "rgba(255,130,130,.4)");
    P(4, 8, 1, 1, "rgba(255,130,130,.4)");
  } else if (d === "right") {
    P(2, 6, 2, 2, "#1B2233");
    P(3, 6, 1, 1, "#F4F8FF");
  }
  // hair
  if (hair && hairD) {
    if (d === "up") {
      P(-4, 1, 8, 1, hair);
      P(-5, 2, 10, 6, hair);
      P(-4, 8, 8, 1, hairD);
    } else if (d === "down") {
      P(-4, 1, 8, 1, hair);
      P(-5, 2, 10, 2, hair);
      P(-5, 4, 3, 1, hair);
      P(2, 4, 3, 1, hair);
      P(-5, 4, 1, 3, hair);
      P(4, 4, 1, 3, hair);
    } else {
      P(-4, 1, 8, 1, hair);
      P(-5, 2, 10, 2, hair);
      P(-5, 4, 4, 3, hair);
      P(3, 4, 2, 1, hair);
    }
  }
  // hats
  if (ch.hat === "cap") {
    const cap = "#E8524A";
    const capD = shade(cap, 0.7);
    P(-4, 0, 8, 1, cap);
    P(-5, 1, 10, 3, cap);
    P(-1, 0, 2, 1, capD);
    if (d === "down") P(-6, 4, 12, 1, capD);
    else if (d === "right") P(1, 4, 6, 1, capD);
  } else if (ch.hat === "beanie") {
    const bn = "#F2A93B";
    P(-4, 0, 8, 1, bn);
    P(-5, 1, 10, 3, bn);
    P(-5, 4, 10, 1, shade(bn, 0.75));
    P(-1, -2, 2, 2, "#FBD08A");
  } else if (ch.hat === "antenna") {
    P(0, -4, 1, 4, "#9FB4D6");
    P(-1, -6, 2, 2, "#4EE1FF");
    P(-1, -6, 1, 1, "#BFF4FF");
  }
  // space helmet: neck ring + scanline glass dome with edge highlights
  if (ch.helmet) {
    P(-3, 10, 6, 1, "#9FB4D6");
    P(-3, 11, 6, 1, "#7E93B5");
    const r = 8.2;
    const cyc = 5.2;
    for (let gy = -3; gy <= 11; gy++) {
      const dyy = gy + 0.5 - cyc;
      if (Math.abs(dyy) >= r) continue;
      const wi = Math.max(1, Math.round(Math.sqrt(r * r - dyy * dyy)));
      P(-wi, gy, wi * 2, 1, "rgba(190,225,255,.13)");
      P(-wi, gy, 1, 1, "rgba(225,242,255,.85)");
      P(wi - 1, gy, 1, 1, "rgba(225,242,255,.85)");
    }
    P(-4, -1, 3, 1, "rgba(255,255,255,.7)");
    P(-5, 0, 1, 2, "rgba(255,255,255,.55)");
  }
  cache.set(key, cv);
  return cv;
}
