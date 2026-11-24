// shuttle blasters rendering (holotable game): the combat arena ring, laser
// bolts, and shuttle explosions. Geometry comes from blastStarted / the
// stage's bolt sim; colors from the theme
import type { BlastArena } from "shared";
import { rgba, theme } from "../theme";

// a laser bolt is drawn as a streak this long behind its position
export const BOLT_LENGTH = 26;
// how long an explosion plays
export const EXPLOSION_MS = 700;

// one simulated laser bolt (the stage owns the sim; this module only draws)
export type Bolt = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  // performance.now ms past which the bolt fizzles (max range)
  until: number;
  // shooter id; the local stage hit-tests only its own bolts
  owner: string;
};

// one shuttle explosion: where it died and when (performance.now ms)
export type Explosion = { x: number; y: number; at: number };

// the arena boundary: a big slow-marching dashed circle so combatants know
// where the fight ends (flight is clamped inside it)
export function drawBlastArena(ctx: CanvasRenderingContext2D, arena: BlastArena, t: number): void {
  const danger = theme.ui.danger;
  ctx.strokeStyle = rgba(danger, 0.4);
  ctx.lineWidth = 3;
  ctx.setLineDash([26, 20]);
  ctx.lineDashOffset = -(t / 40) % 46;
  ctx.beginPath();
  ctx.arc(arena.x, arena.y, arena.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  // inner glow ring for depth
  ctx.strokeStyle = rgba(danger, 0.12);
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(arena.x, arena.y, arena.r - 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = `700 15px ${theme.fonts.mono}`;
  ctx.fillStyle = rgba(danger, 0.55);
  const label = "COMBAT ZONE";
  ctx.fillText(label, arena.x - ctx.measureText(label).width / 2, arena.y - arena.r - 16);
}

// laser bolts: a bright core streak with a glow, drawn along the velocity
export function drawBolts(ctx: CanvasRenderingContext2D, bolts: readonly Bolt[]): void {
  const danger = theme.ui.danger;
  for (const b of bolts) {
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const tx = b.x - (b.vx / sp) * BOLT_LENGTH;
    const ty = b.y - (b.vy / sp) * BOLT_LENGTH;
    ctx.shadowColor = danger;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = rgba(danger, 0.95);
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // white-hot core
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo((tx + b.x) / 2, (ty + b.y) / 2);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineCap = "butt";
  }
}

// shuttle explosions: a flash, an expanding shockwave ring, and a few sparks
export function drawExplosions(
  ctx: CanvasRenderingContext2D,
  explosions: readonly Explosion[],
  t: number,
): void {
  const danger = theme.ui.danger;
  for (const e of explosions) {
    const p = (t - e.at) / EXPLOSION_MS;
    if (p < 0 || p >= 1) continue;
    // central flash, gone by the halfway mark
    if (p < 0.5) {
      ctx.fillStyle = rgba("#FFFFFF", 0.9 * (1 - p * 2));
      ctx.beginPath();
      ctx.arc(e.x, e.y, 14 + 26 * p, 0, Math.PI * 2);
      ctx.fill();
    }
    // shockwave ring expands and fades over the full lifetime
    ctx.strokeStyle = rgba(danger, 0.85 * (1 - p));
    ctx.lineWidth = 3.5 * (1 - p) + 1;
    ctx.beginPath();
    ctx.arc(e.x, e.y, 12 + 74 * p, 0, Math.PI * 2);
    ctx.stroke();
    // sparks fly out on fixed spokes
    ctx.fillStyle = rgba(theme.ui["dot-busy"], 0.9 * (1 - p));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.9;
      const d = 10 + 62 * p;
      ctx.fillRect(e.x + Math.cos(a) * d - 1.5, e.y + Math.sin(a) * d - 1.5, 3, 3);
    }
  }
}
