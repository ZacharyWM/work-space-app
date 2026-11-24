// rAF stage: DPR canvas sizing, WASD movement, camera follow + wheel zoom + drag-pan,
// remote-avatar interpolation, throttled pos sends (step 1.6), shuttle flight (notes/003)
import {
  BLAST_COUNTDOWN_MS,
  clampItemScale,
  clampMove,
  inFloor,
  ITEM_SCALE_DEFAULT,
  placementDenialAt,
  RACE_COUNTDOWN_MS,
  removalDenialAt,
  stepToward,
  type BlastArena,
  type Emote,
  type GameTableGame,
  type ItemKind,
  type MapData,
  type PlacedItem,
  type PlayerStatus,
  type Point,
  type RaceStart,
} from "shared";
import type { Connection } from "../net/connection";
import { EXPLOSION_MS, type Bolt, type Explosion } from "./blast";
import {
  drawScene,
  makeStars,
  type AvatarEntity,
  type DecorView,
  type FlightView,
  type ShipEntity,
} from "./draw";
import { isFlat, itemSize } from "./items";
import { DOCK_EXIT_DY, PAD_BOARD_RADIUS, PAD_DOCK_RADIUS } from "./flightdeck";
import { NpcLayer } from "./npcs";
import { GATE_RADIUS, TABLE_RADIUS } from "./race";
import { SPACE_LINK_RADIUS } from "./spacelink";
import { SpaceLayer } from "./space";
import type { Facing } from "./sprite";

// prototype numbers
const SPEED = 255; // walk speed, px/s
const POS_INTERVAL_MS = 66; // ~15 pos sends/s, and only when moved
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.8;
const WHEEL_FACTOR = 0.0013; // exp zoom factor per wheel delta unit
const ZOOM_STEP = 1.28; // hud −/+ button step (prototype)
const ZOOM_EASE = 0.12; // per-frame zoom ease
const FOLLOW_EASE = 0.1; // per-frame camera follow ease
const LERP_RATE = 15; // 1/s convergence rate for remote avatars
// a remote's eased display position slower than this counts as standing still;
// well under walk speed (255) but above the interpolation tail's crawl (notes/002)
const REMOTE_MOVING_MIN = 20; // px/s
// pan limit: at least this many world px of ship must stay inside the viewport
const SHIP_VISIBLE_MIN = 200;
const MOVE_KEYS = new Set([
  "w",
  "a",
  "s",
  "d",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

// shuttle flight physics (prototype moveShip numbers, notes/003)
const SHIP_TURN = 3.1; // rad/s while A/D held
const SHIP_THRUST = 540; // forward acceleration, px/s²
const SHIP_DRAG = 0.5; // coasting velocity decay, 1/s
const SHIP_BRAKE = 3.2; // decay while S held, 1/s
const SHIP_MAX_SPEED = 470; // px/s
// how far a shuttle may stray from the mothership
const FLIGHT_BOUNDS = { minX: -1600, maxX: 3600, minY: -1200, maxY: 2500 };
// while racing, the course sets the bounds instead: the gate loop's box plus
// this margin, so a custom map's course is always inside its own bounds
const RACE_BOUNDS_MARGIN = 600;

// shuttle blasters combat numbers (shuttle blasters feature)
const FIRE_COOLDOWN_MS = 400; // min gap between own shots
const BOLT_SPEED = 1100; // px/s, comfortably above SHIP_MAX_SPEED
const BOLT_LIFETIME_MS = 800; // range = speed * lifetime ≈ 880px
const BOLT_NOSE_OFFSET = 30; // bolts spawn ahead of the shuttle's nose
const SHIP_HIT_RADIUS = 30; // bolt within this of a shuttle = hit
// a remote shuttle's display position moving faster than this shows the flame
const REMOTE_THRUST_MIN = 40; // px/s
// props snap to the same 20px grid the map editor snaps its elements to (notes/017)
const DECOR_SNAP = 20;
// a pointer that traveled less than this (css px) between down and up counts
// as a click, not a drag-pan — this is what lets both share the primary button
const CLICK_SLOP = 4;

// how long the wave locator ring pulses around the waver's avatar (notes/004)
const WAVE_RING_MS = 3600;

// how long an emote bubble floats above an avatar (notes/010)
const EMOTE_MS = 3200;
// how long the locate guide line points at a crewmate (notes/010)
const LOCATE_MS = 6000;
// number-key emote shortcuts, in emoteSchema order (notes/010)
const EMOTE_KEYS: Emote[] = [
  "thumbsUp",
  "heart",
  "laugh",
  "party",
  "wave",
  "question",
];

// a remote avatar's smoothed display state; facing/moving are derived from how
// the display position travels each frame, since the wire only carries positions.
// a is the smoothed shuttle heading, used only while that player flies (notes/003)
type DisplayState = Point & { dir: Facing; moving: boolean; a: number };

// build mode state (notes/017): the armed library kind (null = picking only),
// the size and color the tray places at, the ghost under the cursor, the picked
// prop's id, the drag of a prop already on the deck, and the live size/color a
// control is dragging the picked prop to before the server echoes it back.
// In a preview an absent field means "not previewing that one" — which is why
// color is optional rather than nullable, since null is itself a color choice
type DecorMode = {
  kind: ItemKind | null;
  scale: number;
  color: string | null;
  ghost: {
    kind: ItemKind;
    x: number;
    y: number;
    scale: number;
    color: string | null;
    ok: boolean;
  } | null;
  selected: string | null;
  drag: { id: string; kind: ItemKind; scale: number; color: string | null; moved: boolean } | null;
  preview: { id: string; scale?: number; color?: string | null } | null;
};

export class Stage {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly conn: Connection;
  // replaced in place by owner map edits via setMap (notes/010 map editor)
  private map: MapData;
  private readonly selfId: string;
  private readonly ro: ResizeObserver;
  private readonly stars = makeStars();
  // outside-the-ship scenery; owns the flyby traffic state across frames
  private readonly space = new SpaceLayer();
  // wandering NPCs; the sim is purely local (notes/014 robot pets)
  private readonly npcs: NpcLayer;
  private readonly keys = new Set<string>();
  // smoothed display positions for remote avatars, keyed by player id
  private readonly disp = new Map<string, DisplayState>();
  // wave-ring expiry (performance.now ms) per player who waved at us (notes/004)
  private readonly waves = new Map<string, number>();
  // live emote bubble per player: glyph name + expiry; a new emote replaces
  // the old and restarts its clock (notes/010)
  private readonly emotes = new Map<string, { emote: Emote; until: number }>();
  // crewmate being located: a guide line points from self to them until the
  // timer runs out or they leave; a new locate retargets it (notes/010)
  private locateTarget: { id: string; until: number } | null = null;
  // local player position; authoritative on this client, sent to the server
  private player: Point;
  // local facing + walk state, from the movement keys (drives the sprite, notes/002)
  private dir: Facing = "down";
  private moving = false;
  // double-click walk destination; null = no auto-walk (notes/011)
  private moveTarget: Point | null = null;
  // shuttle flight state (notes/003): pad flown from (null = on foot), pose +
  // velocity while airborne, and whether W is held (drives the flame)
  private myPad: number | null = null;
  private flight = { x: 0, y: 0, a: -Math.PI / 2, vx: 0, vy: 0 };
  private thrusting = false;
  // shuttle race state (holotable game): the course + own progress while
  // racing (null = not racing); frozen until the countdown ends. bounds come
  // from the gate loop so custom-map courses stay reachable
  private myRace: {
    gates: Point[];
    passed: number;
    frozenUntil: number;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  } | null = null;
  // where the racer stood at the start — the landing spot afterward
  private preRace: Point | null = null;
  // shuttle blasters state (holotable game): the arena + bounds while we're
  // in a match (null = not fighting); frozen until the countdown ends
  private myBlast: {
    arena: BlastArena;
    frozenUntil: number;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  } | null = null;
  // where the combatant stood at the start — the landing spot afterward
  private preBlast: Point | null = null;
  // every live laser bolt (ours and relayed); the stage owns the simulation
  private bolts: Bolt[] = [];
  // shuttle explosions still playing
  private explosions: Explosion[] = [];
  // own fire cooldown: no shot before this timestamp
  private nextFireAt = 0;
  // tells react (hud texts) when flight starts/ends
  private readonly onFlyingChange?: (flying: boolean) => void;
  // tells react when our race run starts/ends, and each gate we pass
  private readonly onRacingChange?: (racing: boolean) => void;
  private readonly onRaceGate?: (passed: number) => void;
  // tells react when our blasters run starts/ends
  private readonly onBlastingChange?: (blasting: boolean) => void;
  // E pressed at a holotable — App joins that table's game lobby
  private readonly onGameTable?: (game: GameTableGame) => void;
  // E pressed at the Space Link — App opens the overlay (space link feature)
  private readonly onSpaceLink?: () => void;
  // camera starts wide over the ship center and flies in to the player (prototype join behavior)
  private readonly cam = { x: 800, y: 540, z: 0.55, tz: 1.05 };
  // camera follows the player unless the user drag-panned away; walking or the
  // hud re-center button resumes the follow
  private follow = true;
  // false while meeting mode covers the canvas (notes/003)
  private keysEnabled = true;
  // last pointer position while a drag-pan is active, null otherwise (css px)
  private drag: Point | null = null;
  // where the primary button went down (css px), for the click-vs-pan test
  private pressAt: Point | null = null;
  // build mode; null while the decor tray is closed (notes/017)
  private decor: DecorMode | null = null;
  // told when the picked prop changes, so App can offer to clear it away
  private readonly onDecorSelect?: (item: PlacedItem | null) => void;
  // told when a placement un-arms the kind, so App's copy stays in sync
  private readonly onDecorArmedChange?: (kind: ItemKind | null) => void;
  private dpr = 1;
  private raf = 0;
  private lastT: number;
  private sent: Point; // last position actually sent
  private sentA: number | undefined; // last heading actually sent (flying only)
  private lastSendT = 0;

  constructor(
    canvas: HTMLCanvasElement,
    conn: Connection,
    onFlyingChange?: (flying: boolean) => void,
    race?: {
      onRacingChange?: (racing: boolean) => void;
      onRaceGate?: (passed: number) => void;
      onBlastingChange?: (blasting: boolean) => void;
      onGameTable?: (game: GameTableGame) => void;
      onSpaceLink?: () => void;
    },
    // the picked prop changed while building (notes/017)
    onDecorSelect?: (item: PlacedItem | null) => void,
    // a placement just un-armed the kind (notes/017)
    onDecorArmedChange?: (kind: ItemKind | null) => void,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!; // 2d context never fails on a fresh canvas
    this.conn = conn;
    this.onFlyingChange = onFlyingChange;
    this.onRacingChange = race?.onRacingChange;
    this.onRaceGate = race?.onRaceGate;
    this.onBlastingChange = race?.onBlastingChange;
    this.onGameTable = race?.onGameTable;
    this.onSpaceLink = race?.onSpaceLink;
    this.onDecorSelect = onDecorSelect;
    this.onDecorArmedChange = onDecorArmedChange;
    // mounted only after welcome, so map/selfId/self roster entry all exist
    this.map = conn.map!;
    this.npcs = new NpcLayer(this.map);
    this.selfId = conn.selfId!;
    const self = conn.roster.get(this.selfId)!;
    this.player = { x: self.x, y: self.y };
    this.sent = { ...this.player };
    // a resume can land mid-flight: pick the shuttle back up where it dropped (notes/003)
    if (self.shipPad !== null) {
      this.myPad = self.shipPad;
      this.flight = {
        x: self.x,
        y: self.y,
        a: self.shipA ?? -Math.PI / 2,
        vx: 0,
        vy: 0,
      };
      this.cam.tz = 0.8;
      this.onFlyingChange?.(true);
    }
    this.fit();
    this.ro = new ResizeObserver(this.fit);
    this.ro.observe(canvas);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDblClick);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  // hud zoom buttons (step 2.3); same clamp as the wheel
  zoomIn(): void {
    this.cam.tz = Math.min(ZOOM_MAX, this.cam.tz * ZOOM_STEP);
  }

  zoomOut(): void {
    this.cam.tz = Math.max(ZOOM_MIN, this.cam.tz / ZOOM_STEP);
  }

  // hud re-center button: resume the eased camera follow toward the player
  recenter(): void {
    this.follow = true;
  }

  // someone waved at the local player: pulse the locator ring around their
  // avatar for the next few seconds (notes/004)
  wave(id: string): void {
    this.waves.set(id, performance.now() + WAVE_RING_MS);
  }

  // show a player's emote bubble (remote via the relay, self on send) (notes/010)
  emote(id: string, emote: Emote): void {
    this.emotes.set(id, { emote, until: performance.now() + EMOTE_MS });
  }

  // own emote from the hud picker or a number key: tell the room, show it
  // here — no echo comes back (notes/010)
  sendEmote(emote: Emote): void {
    this.conn.send({ type: "emote", emote });
    this.emote(this.selfId, emote);
  }

  // point the guide line at a crewmate for a few seconds (crew panel LOCATE);
  // purely local — the target is never told (notes/010)
  locate(id: string): void {
    this.locateTarget = { id, until: performance.now() + LOCATE_MS };
  }

  // the workspace's map was replaced by an owner edit (notes/010 map editor):
  // swap the layout, and if the floor under this player is gone — an off-floor
  // avatar can't move, clampMove blocks both axes — teleport home to the new
  // spawn and tell the room immediately
  setMap(map: MapData): void {
    this.map = map;
    // NPCs re-anchor at their (possibly moved) map spots (notes/014 robot pets)
    this.npcs.setMap(map);
    // the layout changed under the walk; the old destination may be gone (notes/011)
    this.moveTarget = null;
    if (!this.flying && !inFloor(map, this.player.x, this.player.y)) {
      this.player = { ...map.spawn };
      const self = this.conn.roster.get(this.selfId);
      if (self) {
        self.x = this.player.x;
        self.y = this.player.y;
      }
      this.conn.send({ type: "pos", x: this.player.x, y: this.player.y });
      this.sent = { ...this.player };
      this.follow = true;
    }
  }

  // meeting mode covers the canvas — suppress movement/interact keys so the
  // player can't blindly wander out of the zone behind the overlay (notes/003)
  setKeysEnabled(on: boolean): void {
    this.keysEnabled = on;
    if (!on) {
      this.keys.clear();
      this.moveTarget = null;
      this.moving = false;
      this.thrusting = false;
    }
  }

  // --- build mode (notes/017) ---

  // open/close the decor tray's build mode; closing drops the ghost and the pick
  setDecorMode(on: boolean): void {
    this.decor = on
      ? {
          kind: null,
          scale: ITEM_SCALE_DEFAULT,
          color: null,
          ghost: null,
          selected: null,
          drag: null,
          preview: null,
        }
      : null;
    if (!on) this.onDecorSelect?.(null);
  }

  // arm a library kind (its ghost follows the cursor until placed), or null to
  // go back to picking props already on the deck
  setDecorKind(kind: ItemKind | null): void {
    if (!this.decor) return;
    this.decor.kind = kind;
    this.decor.ghost = null;
    if (kind !== null) this.selectItem(null);
  }

  // the size the tray's slider places new props at; the ghost shows it
  setDecorScale(scale: number): void {
    if (!this.decor) return;
    this.decor.scale = clampItemScale(scale);
  }

  // the color the tray's picker places new props at; the ghost shows it
  setDecorColor(color: string | null): void {
    if (!this.decor) return;
    this.decor.color = color;
  }

  // live size for the picked prop while its slider is being dragged, so the
  // canvas follows the thumb; App clears it once the server echoes the commit
  setItemScalePreview(preview: { id: string; scale: number } | null): void {
    if (!this.decor) return;
    this.decor.preview = preview;
  }

  // the same, for the picked prop's color picker. Merged onto any size preview
  // already running for that prop, so the two controls don't cancel each other
  setItemColorPreview(preview: { id: string; color: string | null } | null): void {
    if (!this.decor) return;
    if (preview === null) {
      this.decor.preview = null;
      return;
    }
    const live = this.decor.preview;
    this.decor.preview =
      live?.id === preview.id ? { ...live, color: preview.color } : preview;
  }

  // drop the pick (App calls this after clearing a prop away)
  clearDecorSelection(): void {
    this.selectItem(null);
  }

  // our clerk account, which the pod rules are judged against
  private get userId(): string {
    return this.conn.roster.get(this.selfId)?.userId ?? "";
  }

  // pod zone id -> owning account, the shape the shared rules read
  private podOwners(): Map<string, string> {
    const owners = new Map<string, string>();
    for (const pod of this.conn.pods.values())
      owners.set(pod.zoneId, pod.userId);
    return owners;
  }

  // css-px pointer position -> world coords (inverts the draw transform)
  private toWorld(e: { clientX: number; clientY: number }): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - r.width / 2) / this.cam.z + this.cam.x,
      y: (e.clientY - r.top - r.height / 2) / this.cam.z + this.cam.y,
    };
  }

  // grid snap, so a row of desks lines up without pixel-nudging
  private snap(v: number): number {
    return Math.round(v / DECOR_SNAP) * DECOR_SNAP;
  }

  // the size a prop draws (and hit-tests) at: the live slider preview while
  // one is being dragged, otherwise the size the server stored
  private scaleOf(item: PlacedItem): number {
    const preview = this.decor?.preview;
    return preview?.id === item.id && preview.scale !== undefined ? preview.scale : item.scale;
  }

  // the color a prop draws in: the live picker preview while one is open,
  // otherwise the color the server stored
  private colorOf(item: PlacedItem): string | null {
    const preview = this.decor?.preview;
    return preview?.id === item.id && preview.color !== undefined ? preview.color : item.color;
  }

  // the prop under a world point: standing props first (they are drawn over
  // the rugs), topmost — the one drawn last, i.e. the greatest sort key —
  // winning. The key is the deck point plus the prop's draw-order nudge, so
  // clicking a stack picks whichever prop is visibly on top of it
  private itemAt(p: Point): PlacedItem | null {
    let hit: PlacedItem | null = null;
    for (const item of this.conn.items.values()) {
      const { w, h } = itemSize(item.kind, this.scaleOf(item));
      const inside =
        p.x >= item.x - w / 2 &&
        p.x <= item.x + w / 2 &&
        p.y >= item.y - h &&
        p.y <= item.y;
      if (!inside) continue;
      if (hit === null) {
        hit = item;
        continue;
      }
      // a standing prop always beats a rug; between equals, the lower one wins
      if (isFlat(hit.kind) && !isFlat(item.kind)) hit = item;
      else if (
        isFlat(hit.kind) === isFlat(item.kind) &&
        item.y + item.depth >= hit.y + hit.depth
      ) {
        hit = item;
      }
    }
    return hit;
  }

  // pick (or unpick) a prop and tell App, which owns the delete popup
  private selectItem(item: PlacedItem | null): void {
    if (!this.decor) return;
    this.decor.selected = item?.id ?? null;
    // the outgoing pick's slider preview goes with it
    this.decor.preview = null;
    this.onDecorSelect?.(item);
  }

  // the ghost the overlay draws: the armed kind (or the prop being dragged)
  // at the snapped cursor, flagged with whether the deck accepts it there
  private updateGhost(world: Point): void {
    const d = this.decor;
    if (!d) return;
    const kind = d.drag?.kind ?? d.kind;
    if (kind === null || kind === undefined) {
      d.ghost = null;
      return;
    }
    // a dragged prop keeps its own size and color; a fresh one takes the tray's
    const scale = d.drag?.scale ?? d.scale;
    const color = d.drag ? d.drag.color : d.color;
    const x = this.snap(world.x);
    const y = this.snap(world.y);
    const ok =
      placementDenialAt(this.map, x, y, this.podOwners(), this.userId) === null;
    d.ghost = { kind, x, y, scale, color, ok };
  }

  // a control's preview retires the moment the server echoes every value it
  // asked for (or the prop is cleared away), so the canvas goes back to shared
  // truth. A field the preview never set counts as already agreed
  private retirePreview(): void {
    const d = this.decor;
    if (!d?.preview) return;
    const stored = this.conn.items.get(d.preview.id);
    const scaleAgreed = d.preview.scale === undefined || stored?.scale === d.preview.scale;
    const colorAgreed = d.preview.color === undefined || stored?.color === d.preview.color;
    if (stored === undefined || (scaleAgreed && colorAgreed)) d.preview = null;
  }

  // every placed prop at the size and color it draws at this frame — the stored
  // ones, or the live ones while a control is being dragged (notes/017)
  private itemViews(): PlacedItem[] {
    const items = [...this.conn.items.values()];
    if (!this.decor?.preview) return items;
    return items.map((i) =>
      i.scale === this.scaleOf(i) && i.color === this.colorOf(i)
        ? i
        : { ...i, scale: this.scaleOf(i), color: this.colorOf(i) },
    );
  }

  // what the overlay draws this frame: the ghost plus the picked prop, both
  // local to this client (notes/017)
  private decorView(): DecorView | null {
    const d = this.decor;
    if (!d) return null;
    const picked =
      d.selected === null ? null : (this.conn.items.get(d.selected) ?? null);
    // the selection frame tracks the slider too, so it hugs the prop
    const selected = picked && {
      ...picked,
      scale: this.scaleOf(picked),
      color: this.colorOf(picked),
    };
    return { ghost: d.ghost, selected };
  }

  // backing-store size = css size * dpr (capped at 2)
  private fit = (): void => {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, this.canvas.clientWidth * this.dpr);
    this.canvas.height = Math.max(1, this.canvas.clientHeight * this.dpr);
  };

  // exp factor keeps wheel steps proportional at any zoom level
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * WHEEL_FACTOR);
    this.cam.tz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.cam.tz * f));
  };

  // drag-pan: primary button grabs the map and detaches the camera from the player.
  // in build mode the same button also drags props and places them — the
  // click-vs-pan test on release decides which happened (notes/017)
  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.pressAt = { x: e.clientX, y: e.clientY };
    const d = this.decor;
    // grabbing a prop we're allowed to move drags it instead of the map;
    // with a kind armed the press is a placement, so props stay put
    if (d && d.kind === null) {
      const item = this.itemAt(this.toWorld(e));
      if (
        item &&
        removalDenialAt(
          this.map,
          item.x,
          item.y,
          this.podOwners(),
          this.userId,
        ) === null
      ) {
        d.drag = {
          id: item.id,
          kind: item.kind,
          scale: item.scale,
          color: item.color,
          moved: false,
        };
        this.updateGhost(this.toWorld(e));
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = "grabbing";
        return;
      }
    }
    this.drag = { x: e.clientX, y: e.clientY };
    // capture so the pan keeps tracking when the pointer leaves the canvas
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent): void => {
    // the ghost tracks the cursor whether or not a button is down (notes/017)
    if (this.decor) {
      this.updateGhost(this.toWorld(e));
      if (this.decor.drag && this.pressAt) {
        if (
          Math.hypot(e.clientX - this.pressAt.x, e.clientY - this.pressAt.y) >
          CLICK_SLOP
        ) {
          this.decor.drag.moved = true;
        }
        return; // dragging a prop never pans the map
      }
    }
    if (!this.drag) return;
    // follow breaks only once the pointer actually moves, so a plain click
    // (no drag) doesn't silently detach the camera from the player
    if (e.clientX !== this.drag.x || e.clientY !== this.drag.y)
      this.follow = false;
    // css-px pointer delta → world units at the current zoom, opposite direction
    this.cam.x -= (e.clientX - this.drag.x) / this.cam.z;
    this.cam.y -= (e.clientY - this.drag.y) / this.cam.z;
    this.drag = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    const press = this.pressAt;
    this.pressAt = null;
    const d = this.decor;
    if (d) {
      const world = this.toWorld(e);
      const dragged = d.drag;
      d.drag = null;
      if (dragged) {
        // a prop that actually travelled lands on the snapped point; a press
        // that didn't move is a plain pick instead
        if (dragged.moved) {
          const x = this.snap(world.x);
          const y = this.snap(world.y);
          if (
            placementDenialAt(this.map, x, y, this.podOwners(), this.userId) ===
            null
          ) {
            this.conn.send({ type: "moveItem", id: dragged.id, x, y });
          }
          this.updateGhost(world);
        } else {
          this.selectItem(this.conn.items.get(dragged.id) ?? null);
        }
      } else if (
        press &&
        Math.hypot(e.clientX - press.x, e.clientY - press.y) <= CLICK_SLOP
      ) {
        if (d.kind !== null) {
          // armed: stamp a prop, then un-arm so the next drop needs a fresh pick
          const x = this.snap(world.x);
          const y = this.snap(world.y);
          if (
            placementDenialAt(this.map, x, y, this.podOwners(), this.userId) ===
            null
          ) {
            this.conn.send({
              type: "placeItem",
              kind: d.kind,
              x,
              y,
              scale: d.scale,
              color: d.color,
            });
            d.kind = null;
            d.ghost = null;
            this.onDecorArmedChange?.(null);
          }
        } else {
          this.selectItem(this.itemAt(world));
        }
      }
      if (d.drag === null && !d.kind) this.updateGhost(world);
    }
    if (this.canvas.hasPointerCapture(e.pointerId))
      this.canvas.releasePointerCapture(e.pointerId);
    this.canvas.style.cursor = "";
    if (!this.drag) return;
    this.drag = null;
  };

  // the ghost belongs under the cursor; drop it when the cursor leaves
  private onPointerLeave = (): void => {
    if (this.decor) this.decor.ghost = null;
  };

  // double-click on walkable floor starts an auto-walk to that point (notes/011);
  // clicks in open space, in flight, or under meeting mode are ignored
  private onDblClick = (e: MouseEvent): void => {
    if (!this.keysEnabled || this.flying) return;
    // screen → world: invert the draw transform (center on cam, scale by zoom)
    const r = this.canvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - r.width / 2) / this.cam.z + this.cam.x;
    const wy = (e.clientY - r.top - r.height / 2) / this.cam.z + this.cam.y;
    if (!inFloor(this.map, wx, wy)) return;
    this.moveTarget = { x: wx, y: wy };
    // heading somewhere resumes the camera follow, like walking does
    this.follow = true;
  };

  // airborne in any mode: pad shuttle (myPad), race shuttle (myRace), or
  // blasters shuttle (myBlast)
  private get flying(): boolean {
    return this.myPad !== null || this.myRace !== null || this.myBlast !== null;
  }

  // input is dead during a game countdown (race or blasters)
  private get raceFrozen(): boolean {
    if (this.myRace !== null && this.lastT < this.myRace.frozenUntil)
      return true;
    return this.myBlast !== null && this.lastT < this.myBlast.frozenUntil;
  }

  // the race is on and we're in it: board the race shuttle on our grid slot
  // (App calls this off the raceStarted message) (shuttle race feature)
  startRace(gates: Point[], start: RaceStart): void {
    this.preRace = { ...this.player };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const g of gates) {
      minX = Math.min(minX, g.x);
      minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x);
      maxY = Math.max(maxY, g.y);
    }
    this.myRace = {
      gates,
      passed: 0,
      frozenUntil: performance.now() + RACE_COUNTDOWN_MS,
      bounds: {
        minX: minX - RACE_BOUNDS_MARGIN,
        maxX: maxX + RACE_BOUNDS_MARGIN,
        minY: minY - RACE_BOUNDS_MARGIN,
        maxY: maxY + RACE_BOUNDS_MARGIN,
      },
    };
    this.flight = { x: start.x, y: start.y, a: start.a, vx: 0, vy: 0 };
    this.keys.clear();
    this.moveTarget = null;
    this.thrusting = false;
    this.follow = true;
    // widen the camera so the first gate is in view
    this.cam.tz = Math.min(this.cam.tz, 0.7);
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.x = start.x;
      self.y = start.y;
    }
    this.onRacingChange?.(true);
  }

  // our race run is over (finished, quit, or the race ended): back on foot
  // where the run began; a no-op when not racing
  endRace(): void {
    if (this.myRace === null) return;
    this.myRace = null;
    this.thrusting = false;
    this.keys.clear();
    // land where we stood at the start; a mid-race map edit may have removed
    // that floor — fall back to the spawn like a dock does (notes/010)
    this.player = this.preRace ?? { ...this.map.spawn };
    this.preRace = null;
    if (!inFloor(this.map, this.player.x, this.player.y))
      this.player = { ...this.map.spawn };
    this.dir = "down";
    this.moving = false;
    this.follow = true;
    this.cam.tz = Math.max(this.cam.tz, 1.05);
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.x = this.player.x;
      self.y = this.player.y;
    }
    // tell the room where we landed; the server re-derives our zone from it
    this.conn.send({ type: "pos", x: this.player.x, y: this.player.y });
    this.sent = { ...this.player };
    this.sentA = undefined;
    this.onRacingChange?.(false);
  }

  // the match is on and we're in it: board the blasters shuttle on our spawn
  // pose (App calls this off the blastStarted message) (shuttle blasters feature)
  startBlast(arena: BlastArena, start: RaceStart): void {
    this.preBlast = { ...this.player };
    this.myBlast = {
      arena,
      frozenUntil: performance.now() + BLAST_COUNTDOWN_MS,
      // a square around the arena circle, like the race course's box
      bounds: {
        minX: arena.x - arena.r - RACE_BOUNDS_MARGIN,
        maxX: arena.x + arena.r + RACE_BOUNDS_MARGIN,
        minY: arena.y - arena.r - RACE_BOUNDS_MARGIN,
        maxY: arena.y + arena.r + RACE_BOUNDS_MARGIN,
      },
    };
    this.flight = { x: start.x, y: start.y, a: start.a, vx: 0, vy: 0 };
    this.keys.clear();
    this.moveTarget = null;
    this.thrusting = false;
    this.follow = true;
    this.nextFireAt = 0;
    // widen the camera so the arena reads at a glance
    this.cam.tz = Math.min(this.cam.tz, 0.6);
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.x = start.x;
      self.y = start.y;
    }
    this.onBlastingChange?.(true);
  }

  // our blasters run is over (destroyed, quit, or the match ended): back on
  // foot where the run began; a no-op when not fighting
  endBlast(): void {
    if (this.myBlast === null) return;
    this.myBlast = null;
    this.thrusting = false;
    this.keys.clear();
    // land where we stood at the start; a mid-match map edit may have removed
    // that floor — fall back to the spawn like a dock does (notes/010)
    this.player = this.preBlast ?? { ...this.map.spawn };
    this.preBlast = null;
    if (!inFloor(this.map, this.player.x, this.player.y))
      this.player = { ...this.map.spawn };
    this.dir = "down";
    this.moving = false;
    this.follow = true;
    this.cam.tz = Math.max(this.cam.tz, 1.05);
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.x = this.player.x;
      self.y = this.player.y;
    }
    // tell the room where we landed; the server re-derives our zone from it
    this.conn.send({ type: "pos", x: this.player.x, y: this.player.y });
    this.sent = { ...this.player };
    this.sentA = undefined;
    this.onBlastingChange?.(false);
  }

  // a relayed laser bolt (or our own): simulated locally from origin + heading
  spawnBolt(owner: string, x: number, y: number, a: number): void {
    this.bolts.push({
      x,
      y,
      vx: Math.cos(a) * BOLT_SPEED,
      vy: Math.sin(a) * BOLT_SPEED,
      until: performance.now() + BOLT_LIFETIME_MS,
      owner,
    });
  }

  // a shuttle was destroyed there: play the explosion (App calls this off the
  // blastEliminated broadcast, own shuttle included)
  blastExplode(x: number, y: number): void {
    this.explosions.push({ x, y, at: performance.now() });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // meeting mode owns the keyboard while it covers the canvas (notes/003)
    if (!this.keysEnabled) return;
    // typing in a text field must not move the avatar
    const tag = e.target instanceof Element ? e.target.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const k = e.key.toLowerCase();
    // E boards the nearest free shuttle, or docks the one being flown (notes/003)
    if (k === "e" && !e.repeat) {
      this.tryInteract();
      e.preventDefault();
      return;
    }
    // space is the trigger while fighting a blasters match; held = auto-fire
    // on the cooldown (shuttle blasters feature)
    if (k === " " && this.myBlast !== null) {
      this.keys.add(k);
      e.preventDefault();
      return;
    }
    // 1-6 flash an emote (notes/010)
    const emoteIdx = Number.parseInt(k, 10) - 1;
    if (emoteIdx >= 0 && emoteIdx < EMOTE_KEYS.length && !e.repeat) {
      this.sendEmote(EMOTE_KEYS[emoteIdx]!);
      e.preventDefault();
      return;
    }
    if (MOVE_KEYS.has(k)) {
      this.keys.add(k);
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private tick = (t: number): void => {
    // dt clamped so a backgrounded tab doesn't teleport the player on resume
    const dt = Math.min(0.05, (t - this.lastT) / 1000 || 0.016);
    this.lastT = t;
    if (this.flying) this.moveShip(dt);
    else this.movePlayer(dt);
    // laser bolts fly even for spectators (shuttle blasters feature)
    this.stepBolts(dt);
    const c = this.cam;
    c.z += (c.tz - c.z) * ZOOM_EASE;
    // follow is off while the user has drag-panned away from the player
    const target = this.flying ? this.flight : this.player;
    if (this.follow) {
      c.x += (target.x - c.x) * FOLLOW_EASE;
      c.y += (target.y - c.y) * FOLLOW_EASE;
    }
    // the keep-ship-visible clamp would pin the camera once the shuttle leaves
    // the hull behind, so it only applies on foot (notes/003)
    if (!this.flying) this.clampCam();
    this.sendPos(t);
    // zone occupancy from roster zoneIds (server-authoritative via zoneChanged,
    // so every client renders the same counts)
    const zoneCounts = new Map<string, number>();
    // live status keyed by clerk user id (unique per account by the single-session
    // rule); lets a pod pick up its owner's status wherever they stand (notes/009)
    const statusByUser = new Map<string, PlayerStatus>();
    for (const p of this.conn.roster.values()) {
      if (p.zoneId !== null)
        zoneCounts.set(p.zoneId, (zoneCounts.get(p.zoneId) ?? 0) + 1);
      statusByUser.set(p.userId, p.status);
    }
    // claimed pod labels + owner presence come from the live pod map: the name
    // for the label, the owner's status (or "offline") for the pod color (notes/009)
    const podNames = new Map<string, string>();
    const podStatus = new Map<string, PlayerStatus | "offline">();
    for (const pod of this.conn.pods.values()) {
      podNames.set(pod.zoneId, pod.name);
      podStatus.set(pod.zoneId, statusByUser.get(pod.userId) ?? "offline");
    }
    const view = this.view(dt);
    // locate guide line endpoints: self -> the target's smoothed display
    // position; drops when the timer runs out or the target leaves (notes/010)
    let locate: { x1: number; y1: number; x2: number; y2: number } | null =
      null;
    if (this.locateTarget !== null) {
      const targetPos =
        this.disp.get(this.locateTarget.id) ??
        this.conn.roster.get(this.locateTarget.id);
      if (
        this.locateTarget.until <= t ||
        !this.conn.roster.has(this.locateTarget.id) ||
        !targetPos
      ) {
        this.locateTarget = null;
      } else {
        const from = this.flying ? this.flight : this.player;
        locate = { x1: from.x, y1: from.y, x2: targetPos.x, y2: targetPos.y };
      }
    }
    // a slider preview whose size the server has echoed is done (notes/017)
    this.retirePreview();
    drawScene(this.ctx, {
      w: this.canvas.clientWidth,
      h: this.canvas.clientHeight,
      dpr: this.dpr,
      t,
      map: this.map,
      cam: c,
      stars: this.stars,
      space: this.space,
      entities: view.entities,
      npcs: this.npcs.step(dt, t),
      // placed props, and the build-mode overlay when the tray is open (notes/017)
      items: this.itemViews(),
      decor: this.decorView(),
      zoneCounts,
      flight: view.flight,
      podNames,
      podStatus,
      locate,
      // the gate loop while a race runs, ours or someone else's; our next
      // gate + shuttle position light the highlight and guide line
      race: this.conn.race.racing
        ? {
            gates: this.conn.race.gates,
            next: this.myRace?.passed ?? -1,
            self: this.myRace ? { x: this.flight.x, y: this.flight.y } : null,
          }
        : null,
      // the arena while a match runs (spectators see it too); bolts and
      // explosions render whenever any are live
      blast: {
        arena: this.conn.blast.playing ? this.conn.blast.arena : null,
        bolts: this.bolts,
        explosions: this.explosions,
      },
    });
    this.raf = requestAnimationFrame(this.tick);
  };

  // keep part of the ship in view by capping the camera center's distance to the
  // nearest floor plate (a bounding-box clamp fails here: the ship is L-shaped,
  // so the box corners are empty space). runs every frame (before draw) so drags,
  // zooms, and resizes are all covered
  private clampCam(): void {
    const c = this.cam;
    // viewport half-extent in world units at the current zoom; keeping the camera
    // within the smaller half-extent minus a visible slice keeps floor on screen
    const hw = this.canvas.clientWidth / 2 / c.z;
    const hh = this.canvas.clientHeight / 2 / c.z;
    const r = Math.max(0, Math.min(hw, hh) - SHIP_VISIBLE_MIN);
    // nearest point to the camera across all floor plates
    let nx = 0;
    let ny = 0;
    let best = Infinity;
    for (const f of this.map.floors) {
      const px = Math.min(f.x + f.w, Math.max(f.x, c.x));
      const py = Math.min(f.y + f.h, Math.max(f.y, c.y));
      const d2 = (px - c.x) ** 2 + (py - c.y) ** 2;
      if (d2 < best) {
        best = d2;
        nx = px;
        ny = py;
      }
    }
    const d = Math.sqrt(best);
    if (d <= r) return; // within range (d = 0 means the camera is over a floor)
    // pull the camera back onto the allowed radius around the ship
    const s = r / d;
    c.x = nx + (c.x - nx) * s;
    c.y = ny + (c.y - ny) * s;
  }

  private movePlayer(dt: number): void {
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has("w") || k.has("arrowup")) dy -= 1;
    if (k.has("s") || k.has("arrowdown")) dy += 1;
    if (k.has("a") || k.has("arrowleft")) dx -= 1;
    if (k.has("d") || k.has("arrowright")) dx += 1;
    // the keyboard overrides a double-click walk; with no keys held the
    // auto-walk owns this frame's movement (notes/011)
    if (dx || dy) this.moveTarget = null;
    else if (this.moveTarget) {
      this.autoWalk(dt);
      return;
    }
    this.moving = !!(dx || dy);
    if (!dx && !dy) return;
    // walking snaps the camera back to following the player after a drag-pan
    this.follow = true;
    // horizontal input wins the facing on diagonals (prototype rule)
    this.dir = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
    // normalize so diagonals aren't faster, then clamp to the floor plates
    const m = Math.hypot(dx, dy);
    const sp = (SPEED * dt) / m;
    this.player = clampMove(this.map, this.player, {
      x: this.player.x + dx * sp,
      y: this.player.y + dy * sp,
    });
    // keep the self roster entry truthful for later consumers (zone counts, 2.x)
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.x = this.player.x;
      self.y = this.player.y;
    }
  }

  // one frame of the double-click walk: step straight toward the target at walk
  // speed, sliding along plate edges via stepToward; arriving or getting fully
  // blocked (no pathfinding) ends the walk (notes/011)
  private autoWalk(dt: number): void {
    const target = this.moveTarget!;
    const prev = this.player;
    const next = stepToward(this.map, prev, target, SPEED * dt);
    const mx = next.x - prev.x;
    const my = next.y - prev.y;
    if (!mx && !my) {
      // both axes blocked: the target is unreachable from here, give up
      this.moveTarget = null;
      this.moving = false;
      return;
    }
    this.player = next;
    this.moving = true;
    this.follow = true;
    // facing from the dominant axis of this frame's travel, like remotes (notes/002)
    this.dir =
      Math.abs(mx) > Math.abs(my)
        ? mx > 0
          ? "right"
          : "left"
        : my > 0
          ? "down"
          : "up";
    if (next.x === target.x && next.y === target.y) {
      this.moveTarget = null;
      this.moving = false;
    }
    // keep the self roster entry truthful, same as the keyboard path
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.x = next.x;
      self.y = next.y;
    }
  }

  // shuttle physics: A/D turn, W thrusts along the heading, S brakes hard,
  // light drag otherwise (notes/003); the hull is overflown, not hit
  private moveShip(dt: number): void {
    const f = this.flight;
    // the countdown holds every input; the shuttle sits on the grid
    const k = this.raceFrozen ? new Set<string>() : this.keys;
    if (k.has("a") || k.has("arrowleft")) f.a -= SHIP_TURN * dt;
    if (k.has("d") || k.has("arrowright")) f.a += SHIP_TURN * dt;
    const thrust = k.has("w") || k.has("arrowup");
    const brake = k.has("s") || k.has("arrowdown");
    this.thrusting = thrust;
    if (thrust) {
      f.vx += Math.cos(f.a) * SHIP_THRUST * dt;
      f.vy += Math.sin(f.a) * SHIP_THRUST * dt;
      // flying resumes the camera follow after a drag-pan, like walking does
      this.follow = true;
    }
    const drag = brake ? SHIP_BRAKE : SHIP_DRAG;
    f.vx -= f.vx * drag * dt;
    f.vy -= f.vy * drag * dt;
    const sp = Math.hypot(f.vx, f.vy);
    if (sp > SHIP_MAX_SPEED) {
      f.vx *= SHIP_MAX_SPEED / sp;
      f.vy *= SHIP_MAX_SPEED / sp;
    }
    // shuttles overfly the hull freely (ship pads feature) — pads can sit on
    // any plate, so hull collision would trap interior liftoffs; only the
    // outer flight bounds remain (the course's own box while racing, the
    // arena's while fighting)
    const bounds = this.myRace?.bounds ?? this.myBlast?.bounds ?? FLIGHT_BOUNDS;
    f.x = Math.max(bounds.minX, Math.min(bounds.maxX, f.x + f.vx * dt));
    f.y = Math.max(bounds.minY, Math.min(bounds.maxY, f.y + f.vy * dt));
    // a blasters shuttle can't leave the combat zone: positions outside the
    // arena circle are pulled back onto its edge
    if (this.myBlast) {
      const { arena } = this.myBlast;
      const d = Math.hypot(f.x - arena.x, f.y - arena.y);
      if (d > arena.r) {
        f.x = arena.x + ((f.x - arena.x) / d) * arena.r;
        f.y = arena.y + ((f.y - arena.y) / d) * arena.r;
      }
    }
    // keep the self roster entry truthful, same as movePlayer
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.x = f.x;
      self.y = f.y;
    }
    if (this.myRace) this.checkGate();
    // space held = fire whenever the cooldown allows
    if (this.myBlast && !this.raceFrozen && k.has(" ")) this.fire();
  }

  // fire own laser bolt from the shuttle's nose and tell the room; rate-capped
  // by the cooldown (shuttle blasters feature)
  private fire(): void {
    if (this.lastT < this.nextFireAt) return;
    this.nextFireAt = this.lastT + FIRE_COOLDOWN_MS;
    const f = this.flight;
    const x = f.x + Math.cos(f.a) * BOLT_NOSE_OFFSET;
    const y = f.y + Math.sin(f.a) * BOLT_NOSE_OFFSET;
    this.spawnBolt(this.selfId, x, y, f.a);
    this.conn.send({ type: "blastFire", x, y, a: f.a });
  }

  // one frame of the laser-bolt simulation: advance, expire, and hit-test our
  // own bolts against the other combatants' shuttles — the shooter's client
  // calls the hit (favor the shooter), the server settles it
  private stepBolts(dt: number): void {
    if (this.bolts.length === 0 && this.explosions.length === 0) return;
    const survivors: Bolt[] = [];
    for (const b of this.bolts) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.until <= this.lastT) continue;
      let hit = false;
      if (
        b.owner === this.selfId &&
        this.myBlast !== null &&
        !this.raceFrozen
      ) {
        for (const p of this.conn.roster.values()) {
          if (p.id === this.selfId || !p.blasting) continue;
          // the smoothed display position is where the shuttle is drawn
          const d = this.disp.get(p.id) ?? p;
          if (Math.hypot(d.x - b.x, d.y - b.y) < SHIP_HIT_RADIUS) {
            this.conn.send({ type: "blastHit", target: p.id });
            hit = true;
            break;
          }
        }
      }
      if (!hit) survivors.push(b);
    }
    this.bolts = survivors;
    // drop explosions that finished playing
    this.explosions = this.explosions.filter(
      (e) => this.lastT - e.at < EXPLOSION_MS,
    );
  }

  // gate pass detection (shuttle race feature): flying within the ring of the
  // next gate advances progress; the last gate lands us and the server takes
  // the finish from the final raceProgress
  private checkGate(): void {
    const race = this.myRace!;
    if (this.raceFrozen) return;
    const gate = race.gates[race.passed];
    if (!gate) return;
    if (
      Math.hypot(gate.x - this.flight.x, gate.y - this.flight.y) >= GATE_RADIUS
    )
      return;
    race.passed++;
    this.conn.send({ type: "raceProgress", gate: race.passed });
    this.onRaceGate?.(race.passed);
    if (race.passed >= race.gates.length) this.endRace();
  }

  // E key: dock when hovering by the origin pad, board when standing by a
  // free pad, join a game lobby when standing at a holotable
  private tryInteract(): void {
    // no E actions mid-game — quitting goes through the hud button
    if (this.myRace !== null || this.myBlast !== null) return;
    if (this.flying) {
      if (this.canDock()) this.dock();
      return;
    }
    const pad = this.nearFreePad();
    if (pad !== null) {
      this.board(pad);
      return;
    }
    const game = this.nearTable();
    if (game !== null) {
      this.onGameTable?.(game);
      return;
    }
    // the Space Link portal opens its overlay (space link feature)
    if (this.nearSpaceLink()) this.onSpaceLink?.();
  }

  // standing within interaction range of the map's Space Link portal
  private nearSpaceLink(): boolean {
    const p = this.map.spaceLink;
    return Math.hypot(p.x - this.player.x, p.y - this.player.y) < SPACE_LINK_RADIUS;
  }

  // the game of the nearest holotable within interaction range, or null
  private nearTable(): GameTableGame | null {
    let best: GameTableGame | null = null;
    let bestD = TABLE_RADIUS;
    for (const t of this.map.gameTables) {
      const d = Math.hypot(t.x - this.player.x, t.y - this.player.y);
      if (d < bestD) {
        bestD = d;
        best = t.game;
      }
    }
    return best;
  }

  // docking is allowed within range of the pad flown from; a map edit can
  // delete that pad mid-flight, in which case docking anywhere is allowed
  // (dock() then lands the pilot at the spawn)
  private canDock(): boolean {
    const pad = this.map.pads[this.myPad!];
    if (!pad) return true;
    return (
      Math.hypot(pad.x - this.flight.x, pad.y - this.flight.y) < PAD_DOCK_RADIUS
    );
  }

  // nearest map pad within boarding range whose shuttle nobody (self included)
  // is flying; null when out of range — roster shipPads are the taken-state truth
  private nearFreePad(): number | null {
    const taken = new Set<number>();
    for (const p of this.conn.roster.values())
      if (p.shipPad !== null) taken.add(p.shipPad);
    for (let i = 0; i < this.map.pads.length; i++) {
      const pad = this.map.pads[i]!;
      if (taken.has(i)) continue;
      if (
        Math.hypot(pad.x - this.player.x, pad.y - this.player.y) <
        PAD_BOARD_RADIUS
      )
        return i;
    }
    return null;
  }

  private board(pad: number): void {
    const p = this.map.pads[pad]!;
    this.myPad = pad;
    // lift off straight up, nose north (prototype boardShip)
    this.flight = { x: p.x, y: p.y, a: -Math.PI / 2, vx: 0, vy: -20 };
    this.keys.clear();
    this.moveTarget = null;
    this.thrusting = false;
    this.follow = true;
    // widen the camera for flight (prototype: cap the zoom at 0.8)
    this.cam.tz = Math.min(this.cam.tz, 0.8);
    const self = this.conn.roster.get(this.selfId);
    if (self) self.shipPad = pad;
    // the server flips this player zone-null and breaks their pairs (notes/003)
    this.conn.send({ type: "ship", pad });
    this.onFlyingChange?.(true);
  }

  private dock(): void {
    const pad = this.map.pads[this.myPad!]; // flying, so myPad is set
    this.myPad = null;
    this.thrusting = false;
    this.keys.clear();
    // step off just below the pad; if a map edit removed the pad or its plate
    // mid-flight, land at the spawn instead of floating (notes/010)
    this.player = pad
      ? { x: pad.x, y: pad.y + DOCK_EXIT_DY }
      : { ...this.map.spawn };
    if (!inFloor(this.map, this.player.x, this.player.y))
      this.player = { ...this.map.spawn };
    this.dir = "down";
    this.moving = false;
    this.follow = true;
    // tighten the camera back to walking scale (prototype dock)
    this.cam.tz = Math.max(this.cam.tz, 1.05);
    const self = this.conn.roster.get(this.selfId);
    if (self) {
      self.shipPad = null;
      self.x = this.player.x;
      self.y = this.player.y;
    }
    // position first, so the server derives the dock's zone from the on-deck
    // spot when the ship message lands (notes/003)
    this.conn.send({ type: "pos", x: this.player.x, y: this.player.y });
    this.sent = { ...this.player };
    this.sentA = undefined;
    this.conn.send({ type: "ship", pad: null });
    this.onFlyingChange?.(false);
  }

  // throttled to ~15/s and skipped entirely while standing still; in flight the
  // shuttle pose (heading included, for remote rendering) is what's sent
  private sendPos(t: number): void {
    if (t - this.lastSendT < POS_INTERVAL_MS) return;
    const pos = this.flying ? this.flight : this.player;
    const a = this.flying ? this.flight.a : undefined;
    if (pos.x === this.sent.x && pos.y === this.sent.y && a === this.sentA)
      return;
    this.conn.send({ type: "pos", x: pos.x, y: pos.y, a });
    this.sent = { x: pos.x, y: pos.y };
    this.sentA = a;
    this.lastSendT = t;
  }

  // build the frame's people + shuttles: remotes eased toward their last
  // received pose; a player flying a shuttle renders as a ship, not an avatar
  private view(dt: number): { entities: AvatarEntity[]; flight: FlightView } {
    const entities: AvatarEntity[] = [];
    const ships: ShipEntity[] = [];
    const takenPads = new Set<number>();
    const seen = new Set<string>();
    // frame-rate-independent ease; ~63% of the gap closes per send interval
    const ease = 1 - Math.exp(-LERP_RATE * dt);
    for (const p of this.conn.roster.values()) {
      if (p.id === this.selfId) continue;
      if (p.shipPad !== null) takenPads.add(p.shipPad);
      seen.add(p.id);
      let d = this.disp.get(p.id);
      // display speed this frame (px/s); drives walk state and the remote flame
      let speed = 0;
      if (!d) {
        // first sight of this player: snap to their reported pose
        d = {
          x: p.x,
          y: p.y,
          dir: "down",
          moving: false,
          a: p.shipA ?? -Math.PI / 2,
        };
        this.disp.set(p.id, d);
      } else {
        const mx = (p.x - d.x) * ease;
        const my = (p.y - d.y) * ease;
        d.x += mx;
        d.y += my;
        speed = Math.hypot(mx, my) / dt;
        // facing + walk state from this frame's display travel; facing holds
        // its last value when they stop (notes/002)
        d.moving = speed > REMOTE_MOVING_MIN;
        if (d.moving) {
          d.dir =
            Math.abs(mx) > Math.abs(my)
              ? mx > 0
                ? "right"
                : "left"
              : my > 0
                ? "down"
                : "up";
        }
        // shuttle heading eased the short way around the circle (notes/003)
        const ta = p.shipA ?? d.a;
        const da =
          ((((ta - d.a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) %
            (Math.PI * 2)) -
          Math.PI;
        d.a += da * ease;
      }
      if (p.shipPad !== null || p.racing || p.blasting) {
        // airborne (pad, race, or blasters shuttle): display speed stands in
        // for the pilot's unsent W key
        ships.push({
          x: d.x,
          y: d.y,
          a: d.a,
          name: p.name,
          me: false,
          thrust: speed > REMOTE_THRUST_MIN,
          pilot: p.character.shirt,
        });
      } else {
        // wave-ring progress while this player's wave marker is live (notes/004)
        const waveUntil = this.waves.get(p.id);
        entities.push({
          x: d.x,
          y: d.y,
          name: p.name,
          me: false,
          // speaking relayed by the server (3.6); zoneId gates the ring like 2.2 gates glow
          speaking: p.speaking,
          inZone: p.zoneId !== null,
          micOn: p.micOn,
          character: p.character,
          dir: d.dir,
          moving: d.moving,
          status: p.status,
          visitingFrom: p.visitingFrom,
          wave:
            waveUntil !== undefined && waveUntil > this.lastT
              ? 1 - (waveUntil - this.lastT) / WAVE_RING_MS
              : null,
          emote: this.emoteOf(p.id),
        });
      }
    }
    // drop display state + expired/departed wave markers and emote bubbles
    for (const id of this.disp.keys()) if (!seen.has(id)) this.disp.delete(id);
    for (const [id, until] of this.waves) {
      if (!seen.has(id) || until <= this.lastT) this.waves.delete(id);
    }
    for (const [id, entry] of this.emotes) {
      if ((!seen.has(id) && id !== this.selfId) || entry.until <= this.lastT)
        this.emotes.delete(id);
    }
    const self = this.conn.roster.get(this.selfId)!;
    if (this.flying) {
      // a race shuttle is race-issued — no pad goes empty for it
      if (this.myPad !== null) takenPads.add(this.myPad);
      ships.push({
        x: this.flight.x,
        y: this.flight.y,
        a: this.flight.a,
        name: self.name,
        me: true,
        thrust: this.thrusting,
        pilot: self.character.shirt,
      });
    } else {
      entities.push({
        x: this.player.x,
        y: this.player.y,
        name: self.name,
        me: true,
        // self speaking is written by the local detector, zoneId by the server echo
        speaking: self.speaking,
        inZone: self.zoneId !== null,
        micOn: self.micOn,
        // self character is written by the crew locker straight onto the roster entry
        character: self.character,
        dir: this.dir,
        moving: this.moving,
        // self status is written by the crew panel straight onto the roster entry;
        // self-waves are dropped server-side, so no ring (notes/004)
        status: self.status,
        // the badge shows on ourselves too while we're the visitor
        visitingFrom: self.visitingFrom,
        wave: null,
        emote: this.emoteOf(this.selfId),
      });
    }
    return { entities, flight: { takenPads, ships, tip: this.tip() } };
  }

  // this player's live emote bubble with its lifetime progress, or null (notes/010)
  private emoteOf(id: string): { emote: Emote; age01: number } | null {
    const entry = this.emotes.get(id);
    if (!entry || entry.until <= this.lastT) return null;
    return {
      emote: entry.emote,
      age01: 1 - (entry.until - this.lastT) / EMOTE_MS,
    };
  }

  // E-key hint: over a free pad on foot, over the shuttle when it can dock,
  // or over a holotable to join its game's lobby
  private tip(): { x: number; y: number; text: string } | null {
    if (this.myRace !== null || this.myBlast !== null) return null;
    if (this.flying) {
      if (!this.canDock()) return null;
      return {
        x: this.flight.x,
        y: this.flight.y - 76,
        text: "E — DOCK SHUTTLE",
      };
    }
    const pad = this.nearFreePad();
    if (pad !== null) {
      const p = this.map.pads[pad]!;
      return { x: p.x, y: p.y - 56, text: "E — BOARD SHUTTLE" };
    }
    // already seated in a lobby: the panel owns the interaction
    const inLobby =
      this.conn.race.members.some((m) => m.id === this.selfId) ||
      this.conn.blast.members.some((m) => m.id === this.selfId);
    const game = inLobby ? null : this.nearTable();
    if (game !== null) {
      const text =
        game === "blast"
          ? "E — JOIN SHUTTLE BLASTERS"
          : "E — JOIN SHUTTLE RACE";
      return { x: this.player.x, y: this.player.y - 72, text };
    }
    // over the portal: the overlay is one keypress away (space link feature)
    if (this.nearSpaceLink()) {
      return { x: this.player.x, y: this.player.y - 72, text: "E — SPACE LINK" };
    }
    return null;
  }
}
