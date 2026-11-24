// outside-the-ship scenery: sun, planets, moon, and slow shuttle/saucer flybys —
// all drawn in screen space with light camera parallax, between the starfield
// and the world transform; colors and numbers copied from the prototype's
// drawSpace()/updateFlybys()/drawFlyby()
import type { Camera } from "./draw";

// how many craft cruise past at once (prototype spaceTraffic default)
const MAX_FLYBYS = 3;
// parallax anchor: the prototype measured camera offsets from this world point
const ANCHOR = { x: 800, y: 540 };

// one craft crossing the screen; ph staggers the vertical bob
type Flyby = {
  kind: "shuttle" | "saucer";
  x: number;
  y: number;
  vx: number; // px/s, sign = travel direction
  ph: number;
};

export class SpaceLayer {
  private flybys: Flyby[] = [];
  private seeded = false;
  private lastT = 0;
  private nextFly = 0;

  draw(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, cam: Camera): void {
    const ox = cam.x - ANCHOR.x;
    const oy = cam.y - ANCHOR.y;

    // sun-like star (upper right, soft glow halo around a warm core)
    const sx = W * 0.8 - ox * 0.04;
    const sy = H * 0.2 - oy * 0.04;
    let g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 140);
    g.addColorStop(0, "rgba(255,214,150,.26)");
    g.addColorStop(0.4, "rgba(255,180,100,.08)");
    g.addColorStop(1, "rgba(255,180,100,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, 140, 0, Math.PI * 2);
    ctx.fill();
    g = ctx.createRadialGradient(sx - 7, sy - 7, 4, sx, sy, 33);
    g.addColorStop(0, "#FFF3DC");
    g.addColorStop(0.55, "#FFD9A0");
    g.addColorStop(1, "#E8A45C");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, 31 + 1.8 * Math.sin(t / 2400), 0, Math.PI * 2);
    ctx.fill();

    // ringed planet (lower left); back ring half, sphere, then front ring half
    ctx.save();
    ctx.translate(W * 0.16 - ox * 0.08, H * 0.68 - oy * 0.08);
    ctx.rotate(-0.3);
    ctx.strokeStyle = "rgba(196,182,255,.3)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(0, 0, 64, 17, 0, Math.PI, Math.PI * 2);
    ctx.stroke();
    const pg = ctx.createRadialGradient(13, -13, 3, 0, 0, 40);
    pg.addColorStop(0, "#8E84C4");
    pg.addColorStop(0.6, "#5B5486");
    pg.addColorStop(1, "#332E52");
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(0, 0, 37, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(212,200,255,.45)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(0, 0, 64, 17, 0, 0, Math.PI);
    ctx.stroke();
    ctx.restore();

    // banded planet (upper left): clipped cloud bands + day/night shading
    ctx.save();
    ctx.translate(W * 0.28 - ox * 0.06, H * 0.13 - oy * 0.06);
    ctx.beginPath();
    ctx.arc(0, 0, 27, 0, Math.PI * 2);
    ctx.fillStyle = "#2E5866";
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = "rgba(140,220,230,.28)";
    ctx.fillRect(-28, -16, 56, 5);
    ctx.fillRect(-28, -2, 56, 7);
    ctx.fillRect(-28, 14, 56, 4);
    const sg = ctx.createRadialGradient(11, -11, 3, 0, 0, 30);
    sg.addColorStop(0, "rgba(255,240,210,.14)");
    sg.addColorStop(0.6, "rgba(0,0,0,0)");
    sg.addColorStop(1, "rgba(0,0,10,.5)");
    ctx.fillStyle = sg;
    ctx.fillRect(-28, -28, 56, 56);
    ctx.restore();

    // small cratered moon (lower right)
    ctx.save();
    ctx.translate(W * 0.7 - ox * 0.1, H * 0.84 - oy * 0.1);
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, Math.PI * 2);
    ctx.fillStyle = "#6E7890";
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = "rgba(20,26,44,.5)";
    ctx.beginPath();
    ctx.arc(-6, 2, 4.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(6, -6, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(4, 8, 2.6, 0, Math.PI * 2);
    ctx.fill();
    const mg = ctx.createRadialGradient(6, -6, 2, 0, 0, 19);
    mg.addColorStop(0, "rgba(255,240,210,.15)");
    mg.addColorStop(1, "rgba(0,0,10,.45)");
    ctx.fillStyle = mg;
    ctx.fillRect(-19, -19, 38, 38);
    ctx.restore();

    this.updateFlybys(W, H, t);
    for (const f of this.flybys) drawFlyby(ctx, f, t);
  }

  private updateFlybys(W: number, H: number, t: number): void {
    // dt clamped like the stage so a backgrounded tab doesn't teleport craft
    const dt = Math.min(0.05, (t - (this.lastT || t)) / 1000);
    this.lastT = t;
    // fresh craft enter off-screen; saucers drift slower than shuttles
    const mk = (x?: number): Flyby => {
      const kind = Math.random() < 0.5 ? "shuttle" : "saucer";
      const ltr = Math.random() < 0.5;
      const sp = kind === "saucer" ? 17 + Math.random() * 9 : 25 + Math.random() * 13;
      return {
        kind,
        x: x ?? (ltr ? -70 : W + 70),
        y: H * (0.06 + Math.random() * 0.5),
        vx: ltr ? sp : -sp,
        ph: Math.random() * 6.28,
      };
    };
    // first frame: scatter the full fleet across the screen so it isn't empty
    if (!this.seeded) {
      this.seeded = true;
      for (let i = 0; i < MAX_FLYBYS; i++) this.flybys.push(mk(W * (0.1 + Math.random() * 0.8)));
    }
    // trickle replacements in with a random gap between launches
    if (this.flybys.length < MAX_FLYBYS && t > this.nextFly) {
      this.flybys.push(mk());
      this.nextFly = t + 600 + Math.random() * 2400;
    }
    for (const f of this.flybys) f.x += f.vx * dt;
    // drop craft once fully off either edge
    this.flybys = this.flybys.filter((f) => f.x > -90 && f.x < W + 90);
  }
}

function drawFlyby(ctx: CanvasRenderingContext2D, f: Flyby, t: number): void {
  // gentle vertical bob; sprite faces +x and is mirrored for leftward travel
  const y = f.y + 2.5 * Math.sin(t / 1100 + f.ph);
  ctx.save();
  ctx.translate(f.x, y);
  if (f.vx < 0) ctx.scale(-1, 1);
  if (f.kind === "shuttle") {
    // flickering engine trail behind the hull
    const tg = ctx.createLinearGradient(-46, 0, -17, 0);
    tg.addColorStop(0, "rgba(120,200,255,0)");
    tg.addColorStop(1, `rgba(120,200,255,${(0.22 + 0.08 * Math.sin(t / 90)).toFixed(3)})`);
    ctx.fillStyle = tg;
    ctx.fillRect(-46, -2, 29, 4);
    // hull: lit top half, shaded belly, tail fin
    ctx.fillStyle = "#8C9BB8";
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(6, -6);
    ctx.lineTo(-14, -6);
    ctx.lineTo(-16, 0);
    ctx.lineTo(-14, 6);
    ctx.lineTo(6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#5E6D8C";
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(6, 6);
    ctx.lineTo(-14, 6);
    ctx.lineTo(-16, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#6B7A96";
    ctx.beginPath();
    ctx.moveTo(-7, -6);
    ctx.lineTo(-13, -12);
    ctx.lineTo(-15, -6);
    ctx.closePath();
    ctx.fill();
    // porthole row + engine nozzle glow
    ctx.fillStyle = "rgba(160,230,255,.9)";
    for (let i = 0; i < 3; i++) ctx.fillRect(-6 + i * 7, -3.5, 3, 3);
    ctx.fillStyle = "rgba(140,210,255,.9)";
    ctx.fillRect(-18, -2, 3, 4);
  } else {
    // saucer: glass dome over a little green pilot, metal disc, chasing lights
    ctx.fillStyle = "rgba(170,235,255,.25)";
    ctx.beginPath();
    ctx.arc(0, -5, 9, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(200,240,255,.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, -5, 9, Math.PI, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#7FD97F";
    ctx.beginPath();
    ctx.arc(0, -7, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0A0F1C";
    ctx.fillRect(-2.5, -8, 2, 2);
    ctx.fillRect(0.5, -8, 2, 2);
    const bg = ctx.createLinearGradient(0, -6, 0, 5);
    bg.addColorStop(0, "#AEBDD8");
    bg.addColorStop(1, "#5E6D8C");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.ellipse(0, -1, 20, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = Math.floor(t / 450) % 3 === i ? "#7FE3FF" : "rgba(127,227,255,.25)";
      ctx.beginPath();
      ctx.arc(-10 + i * 10, 2, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
