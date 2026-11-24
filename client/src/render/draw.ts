// pure canvas drawing for the ship scene: starfield, floor plates, zones, airlock, avatars
// (steps 1.6 + 2.2) — all colors and numbers copied from the prototype's draw()/drawAvatar()
import type { Character, Emote, ItemKind, MapData, PlacedItem, PlayerStatus, Point } from "shared";
// all colors and fonts come from theme.json via the theme module (step 4.1)
import type { BlastArena } from "shared";
import { rgba, theme } from "../theme";
import { drawBlastArena, drawBolts, drawExplosions, type Bolt, type Explosion } from "./blast";
import { drawDecor } from "./decor";
import { drawItem, isFlat, itemSize } from "./items";
import { drawFlightDeck, drawShipPads, drawShipSprite, drawTip, hasFlightDeck } from "./flightdeck";
import { drawNpc, type NpcView } from "./npcs";
import { drawGameTables, drawRaceGates } from "./race";
import { drawSpaceLink } from "./spacelink";
import type { SpaceLayer } from "./space";
import { buildSprite, type Facing } from "./sprite";

// one parallax star: p = parallax factor, tw/ph = twinkle speed/phase
export type Star = { x: number; y: number; r: number; p: number; tw: number; ph: number };

// what drawAvatar needs: smoothed position, identity, local-player flag,
// speaking state (ring renders only while the player is inside a zone),
// mic state (off shows the red shoulder dot, step 4.3), the sprite inputs —
// appearance, facing, and whether the walk cycle runs (notes/002) — plus the
// presence status dot and the wave-locator ring progress (notes/004)
export type AvatarEntity = {
  x: number;
  y: number;
  name: string;
  me: boolean;
  speaking: boolean;
  inZone: boolean;
  micOn: boolean;
  character: Character;
  dir: Facing;
  moving: boolean;
  status: PlayerStatus;
  // the home workspace's name while this person is a Visitor; badges them
  // above the name pill (space link feature)
  visitingFrom: string | null;
  // wave-ring progress in [0,1) while this player recently waved at the local
  // player; null otherwise (notes/004)
  wave: number | null;
  // live emote bubble: which glyph + lifetime progress in [0,1) (notes/010)
  emote: { emote: Emote; age01: number } | null;
};

// emote names -> rendered glyphs; order-independent, names ride the wire (notes/010)
export const EMOTE_GLYPH: Record<Emote, string> = {
  thumbsUp: "👍",
  heart: "❤️",
  laugh: "😂",
  party: "🎉",
  wave: "👋",
  question: "❓",
};

// build mode overlay (notes/017): the armed kind's ghost under the cursor —
// ok=false paints it red where the deck refuses it — plus the picked prop,
// framed while its delete popup is open
export type DecorView = {
  // scale and color are what the tray's slider and picker are set to (or the
  // dragged prop's own)
  ghost: {
    kind: ItemKind;
    x: number;
    y: number;
    scale: number;
    color: string | null;
    ok: boolean;
  } | null;
  selected: PlacedItem | null;
};

// camera in world coords; z = current zoom
export type Camera = { x: number; y: number; z: number };

// a shuttle in flight: position, heading, pilot identity (label + canopy tint),
// and whether the engine flame shows (notes/003)
export type ShipEntity = {
  x: number;
  y: number;
  a: number;
  name: string;
  me: boolean;
  thrust: boolean;
  pilot: string; // pilot's shirt color, shown in the canopy
};

// per-frame flight-deck state the stage computes (notes/003)
export type FlightView = {
  takenPads: ReadonlySet<number>; // pads whose shuttle is out flying
  ships: ShipEntity[]; // every airborne shuttle, self included
  tip: { x: number; y: number; text: string } | null; // E-key interaction hint
};

// 140 stars scattered over a fixed field, wrapped to the viewport at draw time
export function makeStars(): Star[] {
  return Array.from({ length: 140 }, () => ({
    x: Math.random() * 2400,
    y: Math.random() * 1500,
    r: Math.random() * 1.4 + 0.4,
    p: 0.08 + Math.random() * 0.22,
    tw: 0.5 + Math.random() * 2,
    ph: Math.random() * 6.28,
  }));
}

// rounded-rect path helper
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  opts: {
    w: number; // css pixels
    h: number;
    dpr: number;
    t: number; // rAF timestamp, ms
    map: MapData;
    cam: Camera;
    stars: Star[];
    space: SpaceLayer; // outside-the-ship scenery + flyby state (owned by the stage)
    entities: AvatarEntity[];
    npcs: NpcView[]; // wandering NPCs, y-sorted in with the avatars (notes/014)
    items: readonly PlacedItem[]; // placed decor props (notes/017)
    // build mode overlay: the ghost that follows the cursor while a kind is
    // armed, and the frame around the picked prop. null when not building
    decor: DecorView | null;
    zoneCounts: ReadonlyMap<string, number>; // occupants per zone id
    flight: FlightView; // shuttles + pads + interaction tip (notes/003)
    podNames: ReadonlyMap<string, string>; // claimed pod zone id -> owner display name (notes/009)
    // claimed pod zone id -> owner's live status, or "offline" when the owner
    // isn't aboard; drives the pod's color so it reads as their presence (notes/009)
    podStatus: ReadonlyMap<string, PlayerStatus | "offline">;
    // locate guide line from self to a crewmate, world coords (notes/010)
    locate: { x1: number; y1: number; x2: number; y2: number } | null;
    // the running race's gate loop; next/self drive the local racer's
    // highlight + guide line, next -1 while spectating (shuttle race feature)
    race: { gates: readonly Point[]; next: number; self: Point | null } | null;
    // the blasters match: the arena ring while one runs, plus the live laser
    // bolts and explosions (drawn even for spectators) (shuttle blasters feature)
    blast: { arena: BlastArena | null; bolts: readonly Bolt[]; explosions: readonly Explosion[] };
  },
): void {
  const { w: W, h: H, dpr, t, map, cam: c, stars, space, entities, zoneCounts, flight } = opts;
  if (!W || !H) return;

  // screen space: background, two faint radial washes, parallax stars
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // sprites must scale with hard pixel edges (notes/002)
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(W * 0.2, H * 0.15, 0, W * 0.2, H * 0.15, W * 0.5);
  g.addColorStop(0, rgba(theme.accent, 0.05));
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W * 0.85, H * 0.9, 0, W * 0.85, H * 0.9, W * 0.45);
  g.addColorStop(0, "rgba(138,110,255,.05)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = theme.canvas.star;
  for (const s of stars) {
    // shift by a fraction of the camera, then wrap into the viewport
    const px = (((s.x - c.x * s.p) % W) + W) % W;
    const py = (((s.y - c.y * s.p) % H) + H) % H;
    ctx.globalAlpha = 0.2 + 0.4 * (0.5 + 0.5 * Math.sin((t / 900) * s.tw + s.ph));
    ctx.fillRect(px, py, s.r, s.r);
  }
  ctx.globalAlpha = 1;

  // planets, sun, moon, and passing craft sit behind the ship (prototype order)
  space.draw(ctx, W, H, t, c);

  // world space: center on the camera, scale by zoom
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(c.z, c.z);
  ctx.translate(-c.x, -c.y);

  // floors, three passes: outer hull plate, inner deck, clipped grid lines
  for (const f of map.floors) {
    rr(ctx, f.x - 10, f.y - 10, f.w + 20, f.h + 20, f.r + 8);
    ctx.fillStyle = theme.canvas.floorHull;
    ctx.fill();
    ctx.strokeStyle = rgba(theme.accent, 0.1);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const f of map.floors) {
    rr(ctx, f.x, f.y, f.w, f.h, f.r);
    ctx.fillStyle = theme.canvas.floorDeck;
    ctx.fill();
    ctx.strokeStyle = theme.canvas.floorDeckStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  for (const f of map.floors) {
    ctx.save();
    rr(ctx, f.x, f.y, f.w, f.h, f.r);
    ctx.clip();
    ctx.strokeStyle = theme.canvas.floorGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.ceil(f.x / 40) * 40; gx < f.x + f.w; gx += 40) {
      ctx.moveTo(gx, f.y);
      ctx.lineTo(gx, f.y + f.h);
    }
    for (let gy = Math.ceil(f.y / 40) * 40; gy < f.y + f.h; gy += 40) {
      ctx.moveTo(f.x, gy);
      ctx.lineTo(f.x + f.w, gy);
    }
    ctx.stroke();
    ctx.restore();
  }

  // decor props sit on the deck, under the zone overlays (prototype order)
  drawDecor(ctx, map.decor, t);

  // bay-door dressing (only while the legacy deck plate survives) plus the
  // map's ship pads and their parked shuttles, same layer as decor (notes/003)
  if (hasFlightDeck(map)) drawFlightDeck(ctx, t);
  drawShipPads(ctx, t, map.pads, flight.takenPads);

  // holotables sit on the deck with the pads (shuttle race feature)
  drawGameTables(ctx, map.gameTables, t);

  // the Space Link portal sits on the deck too (space link feature)
  drawSpaceLink(ctx, map.spaceLink, t);

  // rugs lie flat on the deck, under the zone overlays and everything else.
  // They keep their placement order (the sort is stable), so the depth nudge is
  // the only thing that restacks one rug over another
  for (const item of opts.items.filter((i) => isFlat(i.kind)).sort((a, b) => a.depth - b.depth)) {
    drawItem(ctx, item.kind, item.x, item.y, t, item.scale, item.color);
  }

  // zones: accent-tinted rect + name/occupant label. Occupancy never changes a
  // zone's look — every zone draws the same whether or not anyone is inside
  for (const z of map.zones) {
    const n = zoneCounts.get(z.id) ?? 0;
    // a claimed pod is drawn in its owner's status color (idle tint when they're
    // offline) so the pod reads as their presence; every other zone stays accent.
    // podStatus is keyed only for claimed pods, so a plain lookup suffices (notes/009)
    const podS = opts.podStatus.get(z.id);
    const zoneColor =
      podS === undefined ? theme.accent : podS === "offline" ? POD_IDLE_COLOR : STATUS_COLOR[podS];
    // the small ops pods take a smaller label so it fits the rect (prototype)
    ctx.font = z.id.startsWith("ops") ? `600 11px ${theme.fonts.mono}` : `600 13px ${theme.fonts.mono}`;
    rr(ctx, z.rect.x, z.rect.y, z.rect.w, z.rect.h, 10);
    ctx.fillStyle = rgba(zoneColor, 0.03);
    ctx.fill();
    ctx.strokeStyle = rgba(zoneColor, 0.25);
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.fillStyle = rgba(zoneColor, 0.5);
    // claimed pod: the owner's name replaces the zone title entirely, sitting at
    // the pod's bottom edge whether or not they're aboard (notes/009)
    const owner = z.pod ? opts.podNames.get(z.id) : undefined;
    if (owner === undefined) {
      // count suffix only when occupied, e.g. "LOUNGE · 3" (prototype behavior)
      ctx.fillText(z.name + (n ? " · " + n : ""), z.rect.x + 12, z.rect.y + 21);
    } else {
      ctx.font = `600 10px ${theme.fonts.mono}`;
      ctx.fillStyle = rgba(zoneColor, 0.45);
      ctx.fillText(`◈ ${owner.toUpperCase()}`, z.rect.x + 12, z.rect.y + z.rect.h - 9);
    }
  }

  // airlock marker at the spawn point; label offset matches the prototype's
  // hardcoded (262, 758) for spawn (330, 800)
  ctx.font = `600 11px ${theme.fonts.mono}`;
  ctx.fillStyle = "rgba(160,180,210,.4)";
  ctx.fillText("AIRLOCK", map.spawn.x - 68, map.spawn.y - 42);
  ctx.strokeStyle = "rgba(160,180,210,.25)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.arc(map.spawn.x, map.spawn.y, 19, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // locate guide line: marching dashes from self toward the crewmate, a
  // pulsing ring at their feet; sits under the avatars so it reads as a
  // floor marking (notes/010)
  if (opts.locate) {
    const { x1, y1, x2, y2 } = opts.locate;
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d > 40) {
      // stop the line short of both avatars so neither is underlined
      const ux = (x2 - x1) / d;
      const uy = (y2 - y1) / d;
      ctx.strokeStyle = rgba(theme.accent, 0.75);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([10, 9]);
      // negative offset marches the dashes toward the target
      ctx.lineDashOffset = -(t / 30) % 19;
      ctx.beginPath();
      ctx.moveTo(x1 + ux * 24, y1 + uy * 24);
      ctx.lineTo(x2 - ux * 26, y2 - uy * 26);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    // target marker: two counter-phased pulse rings
    for (const phase of [0, 0.5]) {
      const p = (t / 1100 + phase) % 1;
      ctx.strokeStyle = rgba(theme.accent, 0.85 * (1 - p));
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x2, y2 - 5, 16 + 34 * p, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // the race gate loop rings the hull, under the shuttles flying it
  if (opts.race) drawRaceGates(ctx, opts.race.gates, opts.race.next, opts.race.self, t);

  // the blasters arena rings the hull the same way (shuttle blasters feature)
  if (opts.blast.arena) drawBlastArena(ctx, opts.blast.arena, t);

  // avatars, NPCs and standing props back-to-front by y, so a person in front
  // of a bookshelf covers it and one behind it is covered (notes/017). A prop's
  // depth nudge biases only this sort key, never where it draws — that's how a
  // monitor standing on a meeting table gets in front of it without moving
  const people: { y: number; draw: () => void }[] = [
    ...entities.map((e) => ({ y: e.y, draw: () => drawAvatar(ctx, e, t) })),
    ...opts.npcs.map((n) => ({ y: n.y, draw: () => drawNpc(ctx, n, t) })),
    ...opts.items
      .filter((i) => !isFlat(i.kind))
      .map((i) => ({
        y: i.y + i.depth,
        draw: () => drawItem(ctx, i.kind, i.x, i.y, t, i.scale, i.color),
      })),
  ];
  for (const p of people.sort((a, b) => a.y - b.y)) p.draw();

  // build mode overlay, over the deck but under anything airborne (notes/017)
  if (opts.decor) drawDecorOverlay(ctx, opts.decor, t);

  // airborne shuttles fly above everything on deck (notes/003)
  for (const s of flight.ships) {
    drawShipSprite(ctx, s.x, s.y, s.a, { thrust: s.thrust, pilot: s.pilot }, t);
    // pilot name pill, same styling as the avatar label
    ctx.font = `600 10.5px ${theme.fonts.mono}`;
    const label = s.me ? "YOU" : s.name.toUpperCase();
    const lw = ctx.measureText(label).width;
    rr(ctx, s.x - lw / 2 - 6, s.y - 52, lw + 12, 16, 8);
    ctx.fillStyle = theme.canvas.avatarLabelBg;
    ctx.fill();
    ctx.fillStyle = s.me ? theme.accent : theme.canvas.avatarLabelText;
    ctx.fillText(label, s.x - lw / 2, s.y - 40);
  }

  // laser bolts fly above the shuttles; explosions flash on top of everything
  // (shuttle blasters feature)
  if (opts.blast.bolts.length > 0) drawBolts(ctx, opts.blast.bolts);
  if (opts.blast.explosions.length > 0) drawExplosions(ctx, opts.blast.explosions, t);

  // board/dock hint on top of the scene (notes/003)
  if (flight.tip) drawTip(ctx, flight.tip.x, flight.tip.y, flight.tip.text, t);

  ctx.restore();
}

// sprite scale: 20x30 logical pixels drawn at u px each (prototype)
const SPRITE_SCALE = 1.6;
// walk cycle alternates its two frames at this rate (prototype)
const WALK_FRAME_MS = 150;

// presence status dot colors, shared with the DOM via theme.ui (notes/004)
const STATUS_COLOR: Record<PlayerStatus, string> = {
  available: theme.ui["dot-on"],
  busy: theme.ui["dot-busy"],
  away: theme.ui["dot-off"],
};

// a claimed pod whose owner isn't aboard takes this muted tint instead of a
// status color — there's no live presence to reflect (notes/009)
const POD_IDLE_COLOR = theme.canvas.podIdle;

// wave locator ring: two expanding sonar circles around the waver (notes/004)
const WAVE_RING_MAX_R = 46; // outer radius at full expansion
const WAVE_RING_MIN_R = 14; // radius a ring is born at
const WAVE_PULSES = 3; // expansions over the ring's lifetime

function drawAvatar(ctx: CanvasRenderingContext2D, e: AvatarEntity, t: number): void {
  const u = SPRITE_SCALE;
  const feet = e.y + 14;
  // drop shadow under the feet
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.ellipse(e.x, feet + 1, 10, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // pulsing accent ring while speaking in a zone (step 3.6, prototype numbers)
  if (e.speaking && e.inZone) {
    ctx.strokeStyle = rgba(theme.accent, 0.55);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(e.x, e.y - 5, 26 + 2 * Math.sin(t / 170), 0, Math.PI * 2);
    ctx.stroke();
  }
  // body: cached pixel sprite, walk frames while moving, idle frame otherwise (notes/002)
  const frame = e.moving ? Math.floor(t / WALK_FRAME_MS) % 2 : 2;
  const spr = buildSprite(e.character, e.dir, frame);
  ctx.drawImage(spr, e.x - 10 * u, feet - 30 * u, 20 * u, 30 * u);
  // muted: red dot on the shoulder (prototype numbers)
  if (!e.micOn) {
    ctx.fillStyle = theme.canvas.micOffDot;
    ctx.beginPath();
    ctx.arc(e.x + 11, e.y + 8, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = theme.canvas.micOffDotStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // wave locator ring: sonar pulses so the target can spot who waved (notes/004)
  if (e.wave !== null) {
    const p = (e.wave * WAVE_PULSES) % 1; // this pulse's expansion progress
    ctx.strokeStyle = rgba(theme.accent, 0.8 * (1 - p));
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(e.x, e.y - 5, WAVE_RING_MIN_R + (WAVE_RING_MAX_R - WAVE_RING_MIN_R) * p, 0, Math.PI * 2);
    ctx.stroke();
  }
  // name pill above the head; self reads YOU in accent, status dot on the left (notes/004)
  ctx.font = `600 10.5px ${theme.fonts.mono}`;
  const label = e.me ? "YOU" : e.name.toUpperCase();
  const tw = ctx.measureText(label).width;
  // pill holds dot + gap + label, centered on the avatar like the original
  const pw = tw + 21;
  const left = e.x - pw / 2;
  rr(ctx, left, e.y - 54, pw, 16, 8);
  ctx.fillStyle = theme.canvas.avatarLabelBg;
  ctx.fill();
  ctx.fillStyle = STATUS_COLOR[e.status];
  ctx.beginPath();
  ctx.arc(left + 8, e.y - 46, 2.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = e.me ? theme.accent : theme.canvas.avatarLabelText;
  ctx.fillText(label, left + 15, e.y - 42);
  // visitor badge above the name pill: home workspace's name in the portal's
  // violet, so a Visitor reads as one at a glance (space link feature)
  if (e.visitingFrom !== null) {
    ctx.font = `600 8px ${theme.fonts.mono}`;
    const badge = `◈ ${e.visitingFrom.toUpperCase()}`;
    const bw = ctx.measureText(badge).width;
    rr(ctx, e.x - bw / 2 - 5, e.y - 70, bw + 10, 13, 6);
    ctx.fillStyle = theme.canvas.avatarLabelBg;
    ctx.fill();
    ctx.fillStyle = "rgba(138,125,255,.9)";
    ctx.fillText(badge, e.x - bw / 2, e.y - 60);
    ctx.font = `600 10.5px ${theme.fonts.mono}`;
  }
  // emote bubble above the name pill: pops in, floats up, fades out (notes/010)
  if (e.emote !== null) {
    const p = e.emote.age01;
    // quick overshoot pop over the first 15%, then settle to full size
    const pop = p < 0.15 ? 0.5 + (p / 0.15) * 0.6 : 1.1 - Math.min(0.1, (p - 0.15) * 0.5);
    // drift upward through the lifetime; fade over the last 25%
    const rise = 10 * p;
    const alpha = p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${Math.round(17 * pop)}px ${theme.fonts.sans}`;
    ctx.textAlign = "center";
    ctx.fillText(EMOTE_GLYPH[e.emote.emote], e.x, e.y - 62 - rise);
    ctx.restore();
    ctx.textAlign = "start";
  }
}

// build mode overlay: the armed ghost under the cursor and the frame around a
// picked prop (notes/017). Both are local — nobody else sees them
function drawDecorOverlay(ctx: CanvasRenderingContext2D, view: DecorView, t: number): void {
  if (view.selected) {
    const { w, h } = itemSize(view.selected.kind, view.selected.scale);
    ctx.strokeStyle = rgba(theme.accent, 0.9);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -(t / 60) % 9;
    ctx.strokeRect(view.selected.x - w / 2 - 4, view.selected.y - h - 4, w + 8, h + 8);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
  if (view.ghost) {
    const { kind, x, y, scale, color, ok } = view.ghost;
    const { w, h } = itemSize(kind, scale);
    // footprint marker: green where the prop may land, red where it may not
    const tint = ok ? theme.accent : theme.ui.danger;
    ctx.fillStyle = rgba(tint, 0.12);
    ctx.strokeStyle = rgba(tint, 0.7);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.roundRect(x - w / 2 - 2, y - h - 2, w + 4, h + 4, 4);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    drawItem(ctx, kind, x, y, t, scale, color, ok ? 0.75 : 0.35);
  }
}
