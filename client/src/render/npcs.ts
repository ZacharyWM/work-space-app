// NPCs (notes/014 robot pets): robot dogs and humanoid robots that wander the
// ship. The wander is simulated client-side only — NPCs are decor with legs,
// so nothing rides the wire and each client sees its own stroll. Movement uses
// the shared floor clamp, so NPCs walk exactly where players can.
import { inFloor, stepToward, type Character, type MapData, type Npc, type Point } from "shared";
import { rgba, theme } from "../theme";
import { buildSprite, type Facing } from "./sprite";

// stroll speed, well under the player's 255 so NPCs read as ambient
const NPC_SPEED = 90; // px/s
// how far from its map anchor an NPC will pick wander targets
const WANDER_RADIUS = 240;
// idle pause between strolls
const PAUSE_MIN_MS = 1500;
const PAUSE_MAX_MS = 5000;
// random on-floor target samples before giving up until the next pause
const TARGET_TRIES = 12;

// what one NPC looks like this frame; y-sorted into the avatar draw pass
export type NpcView = { x: number; y: number; kind: Npc["kind"]; dir: Facing; moving: boolean };

// the humanoid robot reuses the player sprite in fixed metal tones; the cast is
// safe — buildSprite shades any hex, only real players are palette-validated
const BOT_CHARACTER = {
  skin: "#B8C4D8",
  hair: "none",
  shirt: "#7E93B5",
  pants: "#3E4A5F",
  hat: "antenna",
  helmet: false,
} as unknown as Character;

// one NPC's wander state: current position, facing, target, and idle timer
type Sim = {
  home: Point; // the map anchor targets are picked around
  kind: Npc["kind"];
  x: number;
  y: number;
  dir: Facing;
  target: Point | null; // null = idling until pauseUntil
  pauseUntil: number;
};

// owns every NPC's wander across frames; the stage steps it each tick
export class NpcLayer {
  private map: MapData;
  private sims: Sim[] = [];

  constructor(map: MapData) {
    this.map = map;
    this.setMap(map);
  }

  // a map edit replaces the layout: re-anchor everyone at their new spots
  setMap(map: MapData): void {
    this.map = map;
    this.sims = map.npcs.map((n) => ({
      home: { x: n.x, y: n.y },
      kind: n.kind,
      x: n.x,
      y: n.y,
      dir: "down" as Facing,
      target: null,
      pauseUntil: 0,
    }));
  }

  // advance every wander one frame and return the draw states
  step(dt: number, t: number): NpcView[] {
    return this.sims.map((s) => {
      if (s.target === null) {
        // idling; when the pause runs out, try to pick a new on-floor target
        if (t >= s.pauseUntil) {
          s.target = this.pickTarget(s);
          if (s.target === null) s.pauseUntil = t + PAUSE_MIN_MS;
        }
        return this.viewOf(s, false);
      }
      const next = stepToward(this.map, { x: s.x, y: s.y }, s.target, NPC_SPEED * dt);
      const mx = next.x - s.x;
      const my = next.y - s.y;
      // blocked on both axes (no pathfinding): abandon the stroll and idle
      if (!mx && !my) {
        s.target = null;
        s.pauseUntil = t + this.pauseMs();
        return this.viewOf(s, false);
      }
      s.x = next.x;
      s.y = next.y;
      // dogs are side-view art, so only horizontal travel turns them; the
      // humanoid faces the dominant axis like players do
      if (s.kind === "dog") {
        if (mx) s.dir = mx > 0 ? "right" : "left";
      } else {
        s.dir = Math.abs(mx) > Math.abs(my) ? (mx > 0 ? "right" : "left") : my > 0 ? "down" : "up";
      }
      if (next.x === s.target.x && next.y === s.target.y) {
        s.target = null;
        s.pauseUntil = t + this.pauseMs();
      }
      return this.viewOf(s, s.target !== null);
    });
  }

  private viewOf(s: Sim, moving: boolean): NpcView {
    return { x: s.x, y: s.y, kind: s.kind, dir: s.dir, moving };
  }

  private pauseMs(): number {
    return PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
  }

  // a random walkable point within the wander radius of the anchor, or null
  // when the samples all miss the floor (e.g. the anchor's plate shrank)
  private pickTarget(s: Sim): Point | null {
    for (let i = 0; i < TARGET_TRIES; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = WANDER_RADIUS * Math.sqrt(Math.random()); // area-uniform
      const x = s.home.x + Math.cos(a) * r;
      const y = s.home.y + Math.sin(a) * r;
      if (inFloor(this.map, x, y)) return { x, y };
    }
    return null;
  }
}

// draw one NPC; called inside the world transform, y-sorted with the avatars
export function drawNpc(ctx: CanvasRenderingContext2D, n: NpcView, t: number): void {
  if (n.kind === "dog") drawDog(ctx, n, t);
  else drawBot(ctx, n, t);
}

// humanoid robot: the player sprite in metal tones at player scale
const BOT_SCALE = 1.6;
// walk cycle alternates its two frames at this rate (matches drawAvatar)
const WALK_FRAME_MS = 150;

function drawBot(ctx: CanvasRenderingContext2D, n: NpcView, t: number): void {
  const u = BOT_SCALE;
  const feet = n.y + 14;
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.ellipse(n.x, feet + 1, 10, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  const frame = n.moving ? Math.floor(t / WALK_FRAME_MS) % 2 : 2;
  const spr = buildSprite(BOT_CHARACTER, n.dir, frame);
  ctx.drawImage(spr, n.x - 10 * u, feet - 30 * u, 20 * u, 30 * u);
}

// robot dog sprite art colors (fixed art, not theme)
const DOG_BODY = "#9FB4D6";
const DOG_DARK = "#5C6B84";
const DOG_JOINT = "#3B4557";

// robot dog: side-view pixel quadruped with a glowing visor eye and an
// antenna tail; legs scissor while it trots
function drawDog(ctx: CanvasRenderingContext2D, n: NpcView, t: number): void {
  const feet = n.y + 14;
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.beginPath();
  ctx.ellipse(n.x, feet + 1, 12, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(n.x, feet);
  if (n.dir === "left") ctx.scale(-1, 1); // right-facing art, mirrored
  // pixel plot in dog space: origin at the feet center, +x toward the nose
  const P = (x: number, y: number, w: number, h: number, col: string): void => {
    ctx.fillStyle = col;
    ctx.fillRect(x * 2, y * 2, w * 2, h * 2);
  };
  // legs: front and back pairs scissor while trotting, planted while idle
  const swing = n.moving ? Math.round(Math.sin(t / 90) * 1.5) : 0;
  P(3 + swing, -5, 2, 5, DOG_JOINT); // front near
  P(-6 - swing, -5, 2, 5, DOG_JOINT); // back near
  P(1 - swing, -5, 2, 4, DOG_DARK); // front far
  P(-4 + swing, -5, 2, 4, DOG_DARK); // back far
  // body: metal slab with a darker belly line
  P(-7, -10, 13, 5, DOG_BODY);
  P(-7, -6, 13, 1, DOG_DARK);
  // shoulder panel seams
  P(-3, -10, 1, 5, DOG_DARK);
  // head: forward box with a snout and a glowing visor eye
  P(4, -13, 5, 4, DOG_BODY);
  P(8, -12, 2, 2, DOG_DARK); // snout
  P(5, -12, 3, 1, rgba(theme.accent, 0.9)); // visor
  // ear sensor
  P(4, -14, 1, 1, DOG_JOINT);
  // antenna tail with a blinking tip
  P(-8, -12, 1, 3, DOG_JOINT);
  P(-9, -13, 1, 1, rgba(theme.accent, 0.5 + 0.4 * Math.sin(t / 300)));
  ctx.restore();
}
