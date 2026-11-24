// decor rendering (step 4.2): one draw function per decor union tag; geometry
// comes from map.json, colors from theme.json, glow pulses from time + accent —
// all constants copied from the prototype's drawDecor
import type { DecorItem } from "shared";
import { rgba, theme } from "../theme";

const colors = theme.canvas.decor;

// narrows the union to the variant matching one tag
type ByTag<T extends DecorItem["type"]> = Extract<DecorItem, { type: T }>;

// one drawer per union tag; t is the rAF timestamp for the glow pulses
const drawers: {
  [K in DecorItem["type"]]: (ctx: CanvasRenderingContext2D, item: ByTag<K>, t: number) => void;
} = {
  // viewscreen bar with a pulsing accent strip along its top edge
  screen(ctx, s, t) {
    ctx.fillStyle = colors.screen;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = rgba(theme.accent, 0.25 + 0.08 * Math.sin(t / 600));
    ctx.fillRect(s.x, s.y, s.w, 3);
  },
  // row of consoles, each a 42x16 panel with a small accent indicator
  consoleStrip(ctx, s) {
    for (let i = 0; i < s.count; i++) {
      const x = s.x + i * s.gap;
      ctx.fillStyle = colors.panel;
      ctx.fillRect(x, s.y, 42, 16);
      ctx.fillStyle = rgba(theme.accent, 0.5);
      ctx.fillRect(x + 4, s.y + 3, 14, 3);
    }
  },
  // cargo crate: filled square with an amber outline
  crate(ctx, s) {
    ctx.fillStyle = colors.crate;
    ctx.strokeStyle = colors.crateStroke;
    ctx.lineWidth = 1.5;
    ctx.fillRect(s.x, s.y, s.s, s.s);
    ctx.strokeRect(s.x, s.y, s.s, s.s);
  },
  // med-bay bed with a lighter pillow band at its head
  bed(ctx, s) {
    ctx.fillStyle = colors.bed;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = colors.bedPillow;
    ctx.fillRect(s.x + 4, s.y + 4, s.w - 8, 16);
  },
  // med-bay cross: two 14x4 bars centered on x/y
  cross(ctx, s) {
    ctx.fillStyle = colors.cross;
    ctx.fillRect(s.x - 7, s.y - 2, 14, 4);
    ctx.fillRect(s.x - 2, s.y - 7, 4, 14);
  },
  // lounge table: filled circle with an accent-tinted rim
  roundTable(ctx, s) {
    ctx.fillStyle = colors.panel;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(theme.accent, 0.25);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  },
  // plain seat circle (bridge chairs and lounge seats)
  seat(ctx, s) {
    ctx.fillStyle = colors.seat;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  },
  // ops desk with two pulsing accent status lights, phase keyed by desk x
  desk(ctx, s, t) {
    ctx.fillStyle = colors.desk;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = colors.deskStroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = rgba(theme.accent, 0.4 + 0.12 * Math.sin(t / 500 + s.x));
    ctx.fillRect(s.x + 7, s.y + 5, 20, 4);
    ctx.fillRect(s.x + 35, s.y + 5, 20, 4);
  },
};

// draws every decor item; called between the floor plates and zone overlays
export function drawDecor(ctx: CanvasRenderingContext2D, decor: readonly DecorItem[], t: number): void {
  for (const item of decor) {
    // the record is keyed by the union tag, so the drawer matches the item;
    // TS can't prove the correlation across the indexed access, hence the cast
    (drawers[item.type] as (c: CanvasRenderingContext2D, i: DecorItem, t: number) => void)(ctx, item, t);
  }
}
