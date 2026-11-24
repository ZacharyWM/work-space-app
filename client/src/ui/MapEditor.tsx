// map editor (notes/010 map editor): owner-only full-screen overlay for
// reshaping the workspace layout — move/resize/add/delete floor plates and
// zones, rename zones, flag pods, place ship pads, move the spawn. Edits a
// local draft; SAVE sends the whole layout to the server (which re-validates
// and broadcasts), CANCEL discards. Validation runs the same shared
// mapEditDenial the server uses, so SAVE only enables on layouts the server
// would accept.
import { useEffect, useMemo, useRef, useState } from "react";
import { inFloor, mapEditDenial, type MapData, type Rect } from "shared";
import { drawDecor } from "../render/decor";
import { drawShipSprite } from "../render/flightdeck";
import { drawNpc } from "../render/npcs";
import { drawGameTables } from "../render/race";
import { drawSpaceLink } from "../render/spacelink";
import { rgba, theme } from "../theme";

// grid every rect edge and the spawn snap to (world px)
const SNAP = 20;
// margin around the current layout the editor view (and new elements) can use
const VIEW_MARGIN = 520;
// corner-handle hit radius in screen px
const HANDLE_PX = 9;
// smallest rect the resize handles allow
const MIN_SIZE = 60;

// what's selected: one floor plate, zone, ship pad, game table, or NPC, by
// index into the draft; pads, tables, and NPCs are points, so they move but
// never resize
type Selection =
  | { kind: "floor" | "zone"; i: number }
  | { kind: "pad"; i: number }
  | { kind: "table"; i: number }
  | { kind: "npc"; i: number }
  | null;
// placement tools arm one click; select is the default manipulate mode —
// table places a shuttle race holotable, blast a shuttle blasters one, dog
// and bot place the NPC kinds (notes/014 robot pets). link moves the Space
// Link portal like spawn moves the spawn point — every map has exactly one
// of each, movable but never deletable (space link feature)
type Tool =
  | "select"
  | "floor"
  | "zone"
  | "pod"
  | "ship"
  | "table"
  | "blast"
  | "dog"
  | "bot"
  | "link"
  | "spawn";

// ship-pad circle radius in the editor (matches the live deck's pad rings);
// also the hit-test radius for selecting a pad
const PAD_R = 34;
// game-table hit-test/selection radius (the tabletop is 68px wide)
const TABLE_R = 36;
// NPC hit-test/selection radius (the sprites are ~32px wide)
const NPC_R = 26;

// an active pointer drag: moving a rect (grab offset from its origin) or
// resizing it by one corner (0 tl, 1 tr, 2 bl, 3 br)
type Drag =
  | { mode: "move"; offX: number; offY: number }
  | { mode: "resize"; corner: number };

const snap = (v: number): number => Math.round(v / SNAP) * SNAP;

// fresh client-side zone id; uniqueness against the draft is checked by
// mapEditDenial, and collisions across edits don't matter (ids are per-map)
function newZoneId(): string {
  return `z-${Math.random().toString(36).slice(2, 10)}`;
}

// the world box the editor shows: every floor/zone plus the spawn, padded
function viewBounds(map: MapData): Rect {
  let minX = map.spawn.x;
  let minY = map.spawn.y;
  let maxX = map.spawn.x;
  let maxY = map.spawn.y;
  const eat = (r: Rect): void => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };
  for (const f of map.floors) eat(f);
  for (const z of map.zones) eat(z.rect);
  for (const p of map.pads) eat({ x: p.x - PAD_R, y: p.y - PAD_R, w: PAD_R * 2, h: PAD_R * 2 });
  for (const p of map.gameTables) eat({ x: p.x - TABLE_R, y: p.y - TABLE_R, w: TABLE_R * 2, h: TABLE_R * 2 });
  for (const p of map.npcs) eat({ x: p.x - NPC_R, y: p.y - NPC_R, w: NPC_R * 2, h: NPC_R * 2 });
  eat({ x: map.spaceLink.x - TABLE_R, y: map.spaceLink.y - TABLE_R, w: TABLE_R * 2, h: TABLE_R * 2 });
  return {
    x: minX - VIEW_MARGIN,
    y: minY - VIEW_MARGIN,
    w: maxX - minX + VIEW_MARGIN * 2,
    h: maxY - minY + VIEW_MARGIN * 2,
  };
}

// small mono toolbar button, accent while active
function toolButtonStyle(active: boolean): React.CSSProperties {
  return {
    height: 34,
    padding: "0 11px",
    borderRadius: 8,
    border: `1px solid ${active ? "var(--accent-dim)" : "rgba(255,255,255,.16)"}`,
    background: active ? "var(--accent-faint)" : "rgba(255,255,255,.06)",
    color: active ? "var(--accent)" : "var(--text)",
    font: "600 10px var(--font-mono)",
    letterSpacing: "0.08em",
    cursor: "pointer",
    transition: "all .15s",
  };
}

export function MapEditor(props: {
  map: MapData;
  onSave: (map: MapData) => void;
  onClose: () => void;
}) {
  // the editable copy; the live map is untouched until the server echoes the
  // save back via mapChanged
  const [draft, setDraft] = useState<MapData>(() => structuredClone(props.map));
  const [sel, setSel] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>("select");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // world->screen transform, fixed to the layout as opened (a stable frame
  // while dragging); recomputed only when the window resizes
  const xformRef = useRef({ scale: 1, ox: 0, oy: 0 });
  const boundsRef = useRef(viewBounds(props.map));
  // draft/sel snapshots for the imperative canvas redraw
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const selRef = useRef(sel);
  selRef.current = sel;

  // the shared semantic check gates SAVE — identical to the server's gate
  const denial = useMemo(() => mapEditDenial(draft), [draft]);

  const rectOf = (d: MapData, s: { kind: "floor" | "zone"; i: number }): Rect =>
    s.kind === "floor" ? d.floors[s.i]! : d.zones[s.i]!.rect;

  // canvas sizing + transform, then a redraw on any draft/selection change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const fit = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      canvas.width = Math.max(1, cw * dpr);
      canvas.height = Math.max(1, ch * dpr);
      const b = boundsRef.current;
      const scale = Math.min(cw / b.w, ch / b.h);
      xformRef.current = {
        scale,
        ox: (cw - b.w * scale) / 2 - b.x * scale,
        oy: (ch - b.h * scale) / 2 - b.y * scale,
      };
      draw();
    };

    const draw = (): void => {
      const ctx = canvas.getContext("2d")!;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { scale, ox, oy } = xformRef.current;
      const d = draftRef.current;
      const s = selRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      // background grid so distances read at a glance
      const b = boundsRef.current;
      ctx.strokeStyle = "rgba(120,150,200,.07)";
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      for (let gx = Math.ceil(b.x / 100) * 100; gx < b.x + b.w; gx += 100) {
        ctx.moveTo(gx, b.y);
        ctx.lineTo(gx, b.y + b.h);
      }
      for (let gy = Math.ceil(b.y / 100) * 100; gy < b.y + b.h; gy += 100) {
        ctx.moveTo(b.x, gy);
        ctx.lineTo(b.x + b.w, gy);
      }
      ctx.stroke();
      // floor plates, hull + deck like the ship view but flat
      for (const f of d.floors) {
        ctx.fillStyle = theme.canvas.floorDeck;
        ctx.beginPath();
        ctx.roundRect(f.x, f.y, f.w, f.h, f.r);
        ctx.fill();
        ctx.strokeStyle = theme.canvas.floorDeckStroke;
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
      }
      // built-in decor for context (not editable here); faded
      ctx.save();
      ctx.globalAlpha = 0.45;
      drawDecor(ctx, d.decor, 0);
      ctx.restore();
      // zones over the floors; pods tinted
      for (const z of d.zones) {
        ctx.beginPath();
        ctx.roundRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h, 10);
        ctx.fillStyle = rgba(theme.accent, z.pod ? 0.1 : 0.05);
        ctx.fill();
        ctx.strokeStyle = rgba(theme.accent, 0.55);
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
        ctx.font = `600 ${12 / scale}px ${theme.fonts.mono}`;
        ctx.fillStyle = rgba(theme.accent, 0.85);
        ctx.fillText(z.name + (z.pod ? " · POD" : ""), z.rect.x + 8 / scale, z.rect.y + 16 / scale);
      }
      // game tables: the live holotable prop, static (t = 0)
      drawGameTables(ctx, d.gameTables, 0);
      // the Space Link portal, static too (space link feature)
      drawSpaceLink(ctx, d.spaceLink, 0);
      // NPCs: the live sprite standing still, plus a label naming the kind
      for (const n of d.npcs) {
        drawNpc(ctx, { ...n, dir: n.kind === "dog" ? "right" : "down", moving: false }, 0);
        ctx.font = `600 ${9 / scale}px ${theme.fonts.mono}`;
        ctx.fillStyle = rgba(theme.accent, 0.8);
        const label = n.kind === "dog" ? "NPC · DOG" : "NPC · ROBOT";
        ctx.fillText(label, n.x - ctx.measureText(label).width / 2, n.y + NPC_R + 12);
      }
      // ship pads: dashed ring + parked shuttle + label, like the live deck
      d.pads.forEach((pad, i) => {
        ctx.strokeStyle = rgba(theme.accent, 0.5);
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([5 / scale, 5 / scale]);
        ctx.beginPath();
        ctx.arc(pad.x, pad.y, PAD_R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        drawShipSprite(ctx, pad.x, pad.y, -Math.PI / 2, { thrust: false }, 0);
        ctx.font = `600 ${9 / scale}px ${theme.fonts.mono}`;
        ctx.fillStyle = rgba(theme.accent, 0.8);
        ctx.fillText(`PAD ${i + 1}`, pad.x - 13, pad.y + PAD_R + 16);
      });
      // spawn marker
      ctx.strokeStyle = "rgba(160,180,210,.7)";
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([6 / scale, 5 / scale]);
      ctx.beginPath();
      ctx.arc(d.spawn.x, d.spawn.y, 16 / scale + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `600 ${11 / scale}px ${theme.fonts.mono}`;
      ctx.fillStyle = "rgba(160,180,210,.8)";
      ctx.fillText("SPAWN", d.spawn.x - 22 / scale, d.spawn.y - 24 / scale);
      // selection frame; rects get corner handles, pads a ring (move-only)
      if (s) {
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.lineWidth = 2 / scale;
        ctx.setLineDash([8 / scale, 6 / scale]);
        if (s.kind === "pad" || s.kind === "table" || s.kind === "npc") {
          const p =
            s.kind === "pad" ? d.pads[s.i]! : s.kind === "table" ? d.gameTables[s.i]! : d.npcs[s.i]!;
          const r = s.kind === "pad" ? PAD_R : s.kind === "table" ? TABLE_R : NPC_R;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const r = rectOf(d, s);
          ctx.strokeRect(r.x, r.y, r.w, r.h);
          ctx.setLineDash([]);
          ctx.fillStyle = "#fff";
          const hs = HANDLE_PX / scale;
          for (const [cx, cy] of corners(r)) ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
        }
      }
    };

    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // draw() reads draft/sel through refs; this effect re-runs (and redraws)
    // on every draft/sel change via the dependency list
  }, [draft, sel]);

  // corner centers of a rect, in handle order (tl, tr, bl, br)
  const corners = (r: Rect): [number, number][] => [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ];

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { scale, ox, oy } = xformRef.current;
    return { x: (clientX - rect.left - ox) / scale, y: (clientY - rect.top - oy) / scale };
  };

  // replace the selected element's rect (immutably, so react redraws)
  function setRect(s: { kind: "floor" | "zone"; i: number }, r: Rect): void {
    setDraft((d) => {
      if (s.kind === "floor") {
        const floors = d.floors.slice();
        floors[s.i] = { ...floors[s.i]!, ...r };
        return { ...d, floors };
      }
      const zones = d.zones.slice();
      zones[s.i] = { ...zones[s.i]!, rect: r };
      return { ...d, zones };
    });
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    const p = toWorld(e.clientX, e.clientY);
    // capture keeps a drag tracking outside the canvas; best-effort — a
    // pointer that already lifted has no capture to take
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* drag continuity only */
    }
    // placement tools: one click drops the element and returns to select
    if (tool === "spawn") {
      setDraft((d) => ({ ...d, spawn: { x: snap(p.x), y: snap(p.y) } }));
      setTool("select");
      return;
    }
    // the portal moves like the spawn: one click, never deleted (space link)
    if (tool === "link") {
      setDraft((d) => ({ ...d, spaceLink: { x: snap(p.x), y: snap(p.y) } }));
      setTool("select");
      return;
    }
    if (tool === "floor") {
      setDraft((d) => ({
        ...d,
        floors: [...d.floors, { x: snap(p.x - 120), y: snap(p.y - 90), w: 240, h: 180, r: 14 }],
      }));
      setSel({ kind: "floor", i: draft.floors.length });
      setTool("select");
      return;
    }
    if (tool === "ship") {
      setDraft((d) => ({ ...d, pads: [...d.pads, { x: snap(p.x), y: snap(p.y) }] }));
      setSel({ kind: "pad", i: draft.pads.length });
      setTool("select");
      return;
    }
    if (tool === "table" || tool === "blast") {
      const game = tool === "blast" ? ("blast" as const) : ("race" as const);
      setDraft((d) => ({
        ...d,
        gameTables: [...d.gameTables, { x: snap(p.x), y: snap(p.y), game }],
      }));
      setSel({ kind: "table", i: draft.gameTables.length });
      setTool("select");
      return;
    }
    if (tool === "dog" || tool === "bot") {
      const kind = tool;
      setDraft((d) => ({ ...d, npcs: [...d.npcs, { x: snap(p.x), y: snap(p.y), kind }] }));
      setSel({ kind: "npc", i: draft.npcs.length });
      setTool("select");
      return;
    }
    if (tool === "zone" || tool === "pod") {
      const pod = tool === "pod";
      setDraft((d) => ({
        ...d,
        zones: [
          ...d.zones,
          {
            id: newZoneId(),
            name: pod ? "NEW POD" : "NEW ZONE",
            ...(pod ? { pod: true } : {}),
            rect: { x: snap(p.x - 80), y: snap(p.y - 60), w: 160, h: 120 },
          },
        ],
      }));
      setSel({ kind: "zone", i: draft.zones.length });
      setTool("select");
      return;
    }
    // select mode: corner handle of the current selection first (point
    // elements — pads, tables, and NPCs — have none)
    if (sel && sel.kind !== "pad" && sel.kind !== "table" && sel.kind !== "npc") {
      const r = rectOf(draft, sel);
      const hs = HANDLE_PX / xformRef.current.scale;
      const hit = corners(r).findIndex(
        ([cx, cy]) => Math.abs(p.x - cx) <= hs && Math.abs(p.y - cy) <= hs,
      );
      if (hit >= 0) {
        dragRef.current = { mode: "resize", corner: hit };
        return;
      }
    }
    // then topmost pad (smallest target, drawn on top), then game table,
    // then zone, then floor
    for (let i = draft.pads.length - 1; i >= 0; i--) {
      const pad = draft.pads[i]!;
      if (Math.hypot(p.x - pad.x, p.y - pad.y) <= PAD_R) {
        setSel({ kind: "pad", i });
        dragRef.current = { mode: "move", offX: p.x - pad.x, offY: p.y - pad.y };
        return;
      }
    }
    for (let i = draft.gameTables.length - 1; i >= 0; i--) {
      const table = draft.gameTables[i]!;
      if (Math.hypot(p.x - table.x, p.y - table.y) <= TABLE_R) {
        setSel({ kind: "table", i });
        dragRef.current = { mode: "move", offX: p.x - table.x, offY: p.y - table.y };
        return;
      }
    }
    for (let i = draft.npcs.length - 1; i >= 0; i--) {
      const npc = draft.npcs[i]!;
      if (Math.hypot(p.x - npc.x, p.y - npc.y) <= NPC_R) {
        setSel({ kind: "npc", i });
        dragRef.current = { mode: "move", offX: p.x - npc.x, offY: p.y - npc.y };
        return;
      }
    }
    const inRect = (r: Rect): boolean =>
      p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    for (let i = draft.zones.length - 1; i >= 0; i--) {
      const r = draft.zones[i]!.rect;
      if (inRect(r)) {
        setSel({ kind: "zone", i });
        dragRef.current = { mode: "move", offX: p.x - r.x, offY: p.y - r.y };
        return;
      }
    }
    for (let i = draft.floors.length - 1; i >= 0; i--) {
      const r = draft.floors[i]!;
      if (inRect(r)) {
        setSel({ kind: "floor", i });
        dragRef.current = { mode: "move", offX: p.x - r.x, offY: p.y - r.y };
        return;
      }
    }
    setSel(null);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current;
    const s = sel;
    if (!drag || !s) return;
    const p = toWorld(e.clientX, e.clientY);
    // pads, tables, and NPCs are points: move only, no resize path
    if (s.kind === "pad" || s.kind === "table" || s.kind === "npc") {
      if (drag.mode !== "move") return;
      const moved = { x: snap(p.x - drag.offX), y: snap(p.y - drag.offY) };
      setDraft((d) => {
        if (s.kind === "pad") {
          const pads = d.pads.slice();
          pads[s.i] = moved;
          return { ...d, pads };
        }
        if (s.kind === "npc") {
          const npcs = d.npcs.slice();
          npcs[s.i] = { ...npcs[s.i]!, ...moved };
          return { ...d, npcs };
        }
        const gameTables = d.gameTables.slice();
        gameTables[s.i] = { ...gameTables[s.i]!, ...moved };
        return { ...d, gameTables };
      });
      return;
    }
    const r = rectOf(draft, s);
    if (drag.mode === "move") {
      setRect(s, { ...r, x: snap(p.x - drag.offX), y: snap(p.y - drag.offY) });
      return;
    }
    // resize: the dragged corner follows the pointer, the opposite one anchors
    const right = r.x + r.w;
    const bottom = r.y + r.h;
    const px = snap(p.x);
    const py = snap(p.y);
    let { x, y } = r;
    let w = r.w;
    let h = r.h;
    if (drag.corner === 0 || drag.corner === 2) {
      x = Math.min(px, right - MIN_SIZE);
      w = right - x;
    } else {
      w = Math.max(MIN_SIZE, px - r.x);
    }
    if (drag.corner === 0 || drag.corner === 1) {
      y = Math.min(py, bottom - MIN_SIZE);
      h = bottom - y;
    } else {
      h = Math.max(MIN_SIZE, py - r.y);
    }
    setRect(s, { ...r, x, y, w, h });
  }

  function onPointerUp(): void {
    dragRef.current = null;
  }

  // delete the selection; the last floor plate can't go (the schema needs one)
  function deleteSelected(): void {
    const s = sel;
    if (!s) return;
    setDraft((d) => {
      if (s.kind === "floor") {
        if (d.floors.length <= 1) return d;
        return { ...d, floors: d.floors.filter((_, i) => i !== s.i) };
      }
      if (s.kind === "pad") return { ...d, pads: d.pads.filter((_, i) => i !== s.i) };
      if (s.kind === "table") {
        return { ...d, gameTables: d.gameTables.filter((_, i) => i !== s.i) };
      }
      if (s.kind === "npc") return { ...d, npcs: d.npcs.filter((_, i) => i !== s.i) };
      return { ...d, zones: d.zones.filter((_, i) => i !== s.i) };
    });
    setSel(null);
  }

  // keyboard: delete removes the selection, escape clears it then closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = e.target instanceof Element ? e.target.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelected();
        e.preventDefault();
      } else if (e.key === "Escape") {
        if (selRef.current) setSel(null);
        else props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // deleteSelected/onClose read current state via closures rebuilt per render
  });

  // save: built-in decor whose anchor no longer sits on a floor goes with
  // the floor (notes/010 map editor)
  function save(): void {
    if (denial !== null) return;
    const pruned: MapData = {
      ...draft,
      decor: draft.decor.filter((it) => inFloor(draft, it.x, it.y)),
    };
    props.onSave(pruned);
  }

  const selZone = sel?.kind === "zone" ? draft.zones[sel.i]! : null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--bg)" }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
          cursor: tool === "select" ? "default" : "crosshair",
          touchAction: "none",
        }}
      />
      {/* toolbar: tools, selection actions, validation, save/cancel */}
      <div
        style={{
          position: "fixed",
          left: "50%",
          transform: "translateX(-50%)",
          top: 14,
          zIndex: 41,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 11px",
          background: "var(--surface-bg)",
          border: "1px solid var(--surface-border)",
          borderRadius: 13,
          backdropFilter: "blur(14px)",
          boxShadow: "0 14px 40px rgba(0,0,0,.5)",
          maxWidth: "calc(100vw - 24px)",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            font: "600 10px var(--font-mono)",
            letterSpacing: "0.22em",
            color: "var(--accent)",
            padding: "0 4px",
          }}
        >
          MAP EDITOR
        </span>
        <button style={toolButtonStyle(tool === "select")} onClick={() => setTool("select")} title="Select, move, and resize">
          SELECT
        </button>
        <button style={toolButtonStyle(tool === "floor")} onClick={() => setTool("floor")} title="Click the map to add a floor plate">
          + FLOOR
        </button>
        <button style={toolButtonStyle(tool === "zone")} onClick={() => setTool("zone")} title="Click the map to add a zone">
          + ZONE
        </button>
        <button style={toolButtonStyle(tool === "pod")} onClick={() => setTool("pod")} title="Click the map to add a claimable pod">
          + POD
        </button>
        <button style={toolButtonStyle(tool === "ship")} onClick={() => setTool("ship")} title="Click a floor to add a shuttle launch pad">
          + SHUTTLE
        </button>
        <button style={toolButtonStyle(tool === "table")} onClick={() => setTool("table")} title="Click a floor to add a game table (shuttle race lobby)">
          + SHUTTLE RACE
        </button>
        <button style={toolButtonStyle(tool === "blast")} onClick={() => setTool("blast")} title="Click a floor to add a game table (shuttle blasters lobby)">
          + SHUTTLE BLASTERS
        </button>
        <button style={toolButtonStyle(tool === "dog")} onClick={() => setTool("dog")} title="Click a floor to add a wandering robot dog NPC">
          + NPC DOG
        </button>
        <button style={toolButtonStyle(tool === "bot")} onClick={() => setTool("bot")} title="Click a floor to add a wandering humanoid robot NPC">
          + NPC ROBOT
        </button>
        <button style={toolButtonStyle(tool === "link")} onClick={() => setTool("link")} title="Click the map to move the Space Link portal">
          SPACE LINK
        </button>
        <button style={toolButtonStyle(tool === "spawn")} onClick={() => setTool("spawn")} title="Click the map to move the spawn point">
          SPAWN
        </button>
        {sel && (
          <button
            style={{ ...toolButtonStyle(false), borderColor: "rgba(255,77,77,.5)", color: "var(--danger)" }}
            onClick={deleteSelected}
            title="Delete the selected element (Delete)"
          >
            DELETE
          </button>
        )}
        {selZone && (
          <>
            <input
              value={selZone.name}
              maxLength={24}
              onChange={(e) =>
                setDraft((d) => {
                  const zones = d.zones.slice();
                  zones[sel!.i] = { ...zones[sel!.i]!, name: e.target.value.toUpperCase() };
                  return { ...d, zones };
                })
              }
              style={{
                height: 34,
                width: 150,
                padding: "0 9px",
                borderRadius: 8,
                border: "1px solid rgba(120,150,200,.3)",
                background: "rgba(255,255,255,.05)",
                color: "var(--text)",
                font: "600 10px var(--font-mono)",
                letterSpacing: "0.08em",
              }}
            />
            <button
              style={toolButtonStyle(selZone.pod === true)}
              onClick={() =>
                setDraft((d) => {
                  const zones = d.zones.slice();
                  const z = zones[sel!.i]!;
                  zones[sel!.i] = { ...z, pod: z.pod === true ? undefined : true };
                  return { ...d, zones };
                })
              }
              title="Pods are claimable personal zones"
            >
              POD
            </button>
          </>
        )}
        <div style={{ width: 1, height: 24, background: "rgba(120,150,200,.18)", flex: "none" }} />
        <button
          style={{
            ...toolButtonStyle(false),
            borderColor: denial === null ? "var(--accent-dim)" : "rgba(255,255,255,.1)",
            background: denial === null ? "var(--accent-faint)" : "rgba(255,255,255,.03)",
            color: denial === null ? "var(--accent)" : "rgba(160,180,210,.4)",
            cursor: denial === null ? "pointer" : "default",
          }}
          disabled={denial !== null}
          onClick={save}
          title={denial ?? "Save this layout for everyone in the workspace"}
        >
          SAVE
        </button>
        <button style={toolButtonStyle(false)} onClick={props.onClose} title="Discard the changes">
          CANCEL
        </button>
      </div>
      {/* validation line under the toolbar while the layout is unsaveable */}
      {denial !== null && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            top: 72,
            zIndex: 41,
            padding: "7px 14px",
            borderRadius: 9,
            background: "rgba(10,15,28,.92)",
            border: "1px solid rgba(255,180,84,.45)",
            color: "var(--dot-busy)",
            font: "600 10px var(--font-mono)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          {denial}
        </div>
      )}
      {/* quick help, bottom center */}
      <div
        style={{
          position: "fixed",
          left: "50%",
          transform: "translateX(-50%)",
          bottom: 16,
          zIndex: 41,
          padding: "7px 14px",
          borderRadius: 9,
          background: "rgba(10,15,28,.8)",
          border: "1px solid rgba(120,150,200,.14)",
          color: "var(--text-dim)",
          font: "500 9.5px var(--font-mono)",
          letterSpacing: "0.1em",
          whiteSpace: "nowrap",
        }}
      >
        CLICK — SELECT · DRAG — MOVE · CORNERS — RESIZE · DELETE KEY — REMOVE
      </div>
    </div>
  );
}
