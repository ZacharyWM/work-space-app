// shuttle race rendering (holotable game): the game table prop and the race
// gate loop. Geometry comes from MapData / raceStarted; colors from the theme
import type { GameTable, Point } from "shared";
import { rgba, theme } from "../theme";
import { drawShipSprite } from "./flightdeck";

// standing within this range of a table shows the E hint (the server allows
// a little more slack on the join itself)
export const TABLE_RADIUS = 64;
// flying within this range of the next gate counts as passing it; also the
// drawn ring size
export const GATE_RADIUS = 70;

// rounded-rect path helper (same as draw.ts's local rr)
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// holotables: a console table projecting a slowly turning hologram of a
// shuttle, so the prop reads as "games live here" from across the deck. The
// hologram's tint and label say which game the table hosts: accent for the
// race, danger-red for blasters (shuttle blasters feature)
export function drawGameTables(
  ctx: CanvasRenderingContext2D,
  tables: readonly GameTable[],
  t: number,
): void {
  for (const p of tables) {
    const color = p.game === "blast" ? theme.ui.danger : theme.accent;
    // tabletop
    rr(ctx, p.x - 34, p.y - 14, 68, 28, 9);
    ctx.fillStyle = theme.canvas.decor.panel;
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.4);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // pulsing projection ring on the tabletop
    ctx.strokeStyle = rgba(color, 0.35 + 0.2 * Math.sin(t / 420));
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 22, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
    // hologram shuttle floating above, slowly rotating, slightly bobbing
    ctx.save();
    ctx.globalAlpha = 0.75 + 0.15 * Math.sin(t / 500);
    ctx.translate(p.x, p.y - 26 + 2 * Math.sin(t / 640));
    ctx.scale(0.6, 0.6);
    drawShipSprite(ctx, 0, 0, t / 900, { thrust: false }, t);
    ctx.restore();
    // beam from the tabletop to the hologram
    const beam = ctx.createLinearGradient(p.x, p.y, p.x, p.y - 30);
    beam.addColorStop(0, rgba(color, 0.28));
    beam.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(p.x - 16, p.y);
    ctx.lineTo(p.x + 16, p.y);
    ctx.lineTo(p.x + 26, p.y - 30);
    ctx.lineTo(p.x - 26, p.y - 30);
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 9px ${theme.fonts.mono}`;
    ctx.fillStyle = rgba(color, 0.8);
    const label = p.game === "blast" ? "SHUTTLE BLASTERS" : "SHUTTLE RACE";
    ctx.fillText(label, p.x - ctx.measureText(label).width / 2, p.y + 30);
  }
}

// the gate loop while a race runs. next is the local racer's next gate index
// (-1 while spectating): passed gates dim, the next one pulses and gets a
// marching guide line from the racer's shuttle
export function drawRaceGates(
  ctx: CanvasRenderingContext2D,
  gates: readonly Point[],
  next: number,
  self: Point | null,
  t: number,
): void {
  gates.forEach((g, i) => {
    const passed = next >= 0 && i < next;
    const isNext = i === next;
    const alpha = passed ? 0.15 : isNext ? 0.95 : 0.45;
    if (isNext) {
      ctx.shadowColor = theme.accent;
      ctx.shadowBlur = 22;
    }
    ctx.strokeStyle = rgba(theme.accent, alpha);
    ctx.lineWidth = isNext ? 4 : 2.5;
    ctx.beginPath();
    // the next gate breathes so it reads at a glance
    ctx.arc(g.x, g.y, GATE_RADIUS + (isNext ? 5 * Math.sin(t / 180) : 0), 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // inner tick ring for depth
    ctx.strokeStyle = rgba(theme.accent, alpha * 0.5);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.arc(g.x, g.y, GATE_RADIUS - 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // gate number, centered
    ctx.font = `700 ${isNext ? 22 : 16}px ${theme.fonts.mono}`;
    ctx.fillStyle = rgba(theme.accent, passed ? 0.25 : 0.9);
    const label = String(i + 1);
    ctx.fillText(label, g.x - ctx.measureText(label).width / 2, g.y + 6);
  });
  // marching dashed guide from the racer to their next gate (like locate)
  if (self && next >= 0 && next < gates.length) {
    const g = gates[next]!;
    const d = Math.hypot(g.x - self.x, g.y - self.y);
    if (d > GATE_RADIUS + 60) {
      const ux = (g.x - self.x) / d;
      const uy = (g.y - self.y) / d;
      ctx.strokeStyle = rgba(theme.accent, 0.55);
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 10]);
      ctx.lineDashOffset = -(t / 25) % 22;
      ctx.beginPath();
      ctx.moveTo(self.x + ux * 40, self.y + uy * 40);
      ctx.lineTo(g.x - ux * (GATE_RADIUS + 8), g.y - uy * (GATE_RADIUS + 8));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  }
}
