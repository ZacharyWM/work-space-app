// flight deck: deck dressing constants, shuttle sprite, pad + tip drawing
// (notes/003) — sprite numbers and colors copied from the prototype; pads now
// live in MapData (ship pads feature), so shuttles launch from wherever the
// owner placed them and overfly the hull freely
import type { MapData, Point } from "shared";
import { rgba, theme } from "../theme";

const ship = theme.canvas.ship;

// the original flight-deck floor plate; only anchors the bay-door dressing —
// pads and flight no longer depend on it (ship pads feature)
export const FDECK = { x: 1380, y: 800, w: 400, h: 330 };

// boarding requires standing within this range of a pad center
export const PAD_BOARD_RADIUS = 64;
// docking requires flying within this range of the pad flown from; looser
// than boarding so a moving shuttle can land without pixel-perfect braking
export const PAD_DOCK_RADIUS = 90;
// docking puts the pilot back on foot this far below the pad center
export const DOCK_EXIT_DY = 52;

// true while the map still carries the legacy deck plate; gates only the
// bay-door dressing, which is drawn relative to FDECK (notes/010 map editor)
export function hasFlightDeck(map: MapData): boolean {
  return map.floors.some((f) => f.x === FDECK.x && f.y === FDECK.y);
}

// rounded-rect path helper (same as draw.ts's local rr)
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// one shuttle, drawn nose toward heading a; thrust adds the engine flame,
// pilot tints the canopy dot with the pilot's shirt color (prototype numbers)
export function drawShipSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  a: number,
  opts: { thrust: boolean; pilot?: string },
  t: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.scale(1.5, 1.5);
  if (opts.thrust) {
    const tg = ctx.createLinearGradient(-42, 0, -16, 0);
    tg.addColorStop(0, rgba(ship.thrustTail, 0));
    tg.addColorStop(1, rgba(ship.thrustHead, 0.55 + 0.2 * Math.sin(t / 60)));
    ctx.fillStyle = tg;
    ctx.fillRect(-42, -3, 26, 6);
  }
  // wings
  ctx.fillStyle = ship.wing;
  ctx.beginPath();
  ctx.moveTo(-4, -6);
  ctx.lineTo(-15, -15);
  ctx.lineTo(-16, -5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-4, 6);
  ctx.lineTo(-15, 15);
  ctx.lineTo(-16, 5);
  ctx.closePath();
  ctx.fill();
  // hull, lit top half over shaded bottom half
  ctx.fillStyle = ship.hullTop;
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(7, -6);
  ctx.lineTo(-13, -6);
  ctx.lineTo(-16, 0);
  ctx.lineTo(-13, 6);
  ctx.lineTo(7, 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = ship.hullBottom;
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(7, 6);
  ctx.lineTo(-13, 6);
  ctx.lineTo(-16, 0);
  ctx.closePath();
  ctx.fill();
  // canopy + pilot dot
  ctx.fillStyle = ship.canopy;
  ctx.beginPath();
  ctx.arc(6, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  if (opts.pilot) {
    ctx.fillStyle = opts.pilot;
    ctx.beginPath();
    ctx.arc(6, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // tail nav light
  ctx.fillStyle = ship.nav;
  ctx.fillRect(-18, -2, 3, 4);
  ctx.restore();
}

// pulsing interaction hint pill anchored above a world point (prototype drawTip)
export function drawTip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, t: number): void {
  ctx.font = `600 11px ${theme.fonts.mono}`;
  const w = ctx.measureText(text).width;
  rr(ctx, x - w / 2 - 9, y - 14, w + 18, 22, 10);
  ctx.fillStyle = "rgba(6,9,16,.88)";
  ctx.fill();
  ctx.strokeStyle = rgba(theme.accent, 0.55 + 0.35 * Math.sin(t / 260));
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = theme.accent;
  ctx.fillText(text, x - w / 2, y + 1);
}

// bay-door markings on the legacy deck plate; pure dressing now that pads are
// map data — call only while hasFlightDeck holds
export function drawFlightDeck(ctx: CanvasRenderingContext2D, t: number): void {
  const fd = FDECK;
  // amber guide lights along the bay threshold
  ctx.fillStyle = ship.bayLight;
  for (let i = 0; i < 8; i++) ctx.fillRect(fd.x + 42 + i * 42, fd.y + fd.h - 30, 24, 9);
  // pulsing dashed door line just outside the hull
  ctx.strokeStyle = rgba(theme.accent, 0.35 + 0.15 * Math.sin(t / 480));
  ctx.lineWidth = 3;
  ctx.setLineDash([16, 10]);
  ctx.beginPath();
  ctx.moveTo(fd.x + 30, fd.y + fd.h + 6);
  ctx.lineTo(fd.x + fd.w - 30, fd.y + fd.h + 6);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `600 10px ${theme.fonts.mono}`;
  ctx.fillStyle = ship.bayLabel;
  ctx.fillText("BAY DOOR · OPEN TO SPACE", fd.x + 30, fd.y + fd.h + 24);
}

// pad circles/labels and every parked shuttle, wherever the map put them; pads
// whose index is in takenPads are empty — someone is out flying that shuttle
export function drawShipPads(
  ctx: CanvasRenderingContext2D,
  t: number,
  pads: readonly Point[],
  takenPads: ReadonlySet<number>,
): void {
  pads.forEach((pad, i) => {
    ctx.strokeStyle = ship.padStroke;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(pad.x, pad.y, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `600 9px ${theme.fonts.mono}`;
    ctx.fillStyle = ship.padLabel;
    ctx.fillText(`PAD ${i + 1}`, pad.x - 13, pad.y + 52);
    if (!takenPads.has(i)) drawShipSprite(ctx, pad.x, pad.y, -Math.PI / 2, { thrust: false }, t);
  });
}
