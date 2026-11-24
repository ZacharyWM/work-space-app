// space link rendering (workspace linking): the portal element every Map has
// exactly one of. Geometry comes from MapData.spaceLink; the purple is the
// theme's accent-option violet so the portal reads as its own kind of thing —
// neither a zone (accent) nor a hazard (danger)
import type { Point } from "shared";
import { rgba, theme } from "../theme";

// standing within this range of the portal shows the E hint (the server
// allows a little more slack on the traversal itself, like the game tables)
export const SPACE_LINK_RADIUS = 64;

// the portal's tint (theme accentOptions violet)
const PORTAL_COLOR = "#8A7DFF";

// a floor-mounted gate: a pulsing pad ring, two counter-rotating dashed
// rings, a swirling vortex glow above, and the feature's label
export function drawSpaceLink(ctx: CanvasRenderingContext2D, p: Point, t: number): void {
  // pad ring on the deck
  ctx.strokeStyle = rgba(PORTAL_COLOR, 0.35 + 0.15 * Math.sin(t / 520));
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, 30, 12, 0, 0, Math.PI * 2);
  ctx.stroke();
  // counter-rotating dashed rings sell the "gate is live" motion
  for (const [r, dir, alpha] of [
    [22, 1, 0.55],
    [15, -1, 0.4],
  ] as const) {
    ctx.strokeStyle = rgba(PORTAL_COLOR, alpha);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 7]);
    ctx.lineDashOffset = ((dir * t) / 40) % 13;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  // the vortex: a soft violet glow floating above the pad, gently breathing
  const bob = 2 * Math.sin(t / 640);
  const glow = ctx.createRadialGradient(p.x, p.y - 34 + bob, 2, p.x, p.y - 34 + bob, 26);
  glow.addColorStop(0, rgba(PORTAL_COLOR, 0.55 + 0.12 * Math.sin(t / 300)));
  glow.addColorStop(0.6, rgba(PORTAL_COLOR, 0.18));
  glow.addColorStop(1, rgba(PORTAL_COLOR, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(p.x, p.y - 34 + bob, 26, 0, Math.PI * 2);
  ctx.fill();
  // orbiting sparks around the vortex
  for (let i = 0; i < 3; i++) {
    const a = t / 700 + (i * Math.PI * 2) / 3;
    ctx.fillStyle = rgba(PORTAL_COLOR, 0.8);
    ctx.beginPath();
    ctx.arc(p.x + 20 * Math.cos(a), p.y - 34 + bob + 9 * Math.sin(a), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // beam from the pad up into the vortex
  const beam = ctx.createLinearGradient(p.x, p.y, p.x, p.y - 30);
  beam.addColorStop(0, rgba(PORTAL_COLOR, 0.22));
  beam.addColorStop(1, rgba(PORTAL_COLOR, 0));
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(p.x - 14, p.y);
  ctx.lineTo(p.x + 14, p.y);
  ctx.lineTo(p.x + 22, p.y - 30);
  ctx.lineTo(p.x - 22, p.y - 30);
  ctx.closePath();
  ctx.fill();
  // label, same treatment as the holotables
  ctx.font = `600 9px ${theme.fonts.mono}`;
  ctx.fillStyle = rgba(PORTAL_COLOR, 0.8);
  const label = "SPACE LINK";
  ctx.fillText(label, p.x - ctx.measureText(label).width / 2, p.y + 26);
}
