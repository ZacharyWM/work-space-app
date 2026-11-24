// decor tray (notes/017): the prop library, opened from the DECOR toolbar
// button. Picking a kind arms it — the ghost then follows the cursor on the
// canvas and every click stamps one, gather-style — and picking it again
// disarms. With nothing armed, clicking a prop on the deck picks it (App
// offers to clear it) and dragging one moves it. Anyone aboard may build.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ITEM_KINDS,
  ITEM_SCALE_MAX,
  ITEM_SCALE_MIN,
  ITEM_SCALE_STEP,
  normalizeItemColor,
  type ItemKind,
} from "shared";
import { ITEM_SWATCHES, itemIsColorable, itemLabel, itemPreviewUrl } from "../render/items";

// the tray's sections, in ITEM_KINDS order — grouping is presentation, so it
// lives here rather than in the shared library
const GROUPS: { title: string; kinds: ItemKind[] }[] = [
  {
    title: "WORK",
    kinds: [
      "desk",
      "deskL",
      "standingDesk",
      "execDesk",
      "glassDesk",
      "benchDesk",
      "chair",
      "monitor",
      "bookshelf",
      "whiteboard",
      "cabinet",
      "meetingTable",
    ],
  },
  {
    title: "COMFORT",
    kinds: ["couch", "beanbag", "sideTable", "rug", "lamp", "coffee", "cooler"],
  },
  { title: "DRINKS", kinds: ["mug", "beerMug", "teaCup", "teapot", "wineGlass", "waterBottle", "sodaCan"] },
  {
    title: "GREEN",
    kinds: [
      "plant",
      "bonsai",
      "flowerVase",
      "cactus",
      "orchid",
      "snakePlant",
      "succulents",
      "monstera",
      "sunflower",
      "flowerBox",
    ],
  },
  { title: "SHIP", kinds: ["crate", "locker", "rack", "tank"] },
  { title: "FUN", kinds: ["arcade", "jukebox", "trophy", "duck", "cat"] },
];

const titleStyle: CSSProperties = {
  font: "600 9px var(--font-mono)",
  letterSpacing: "0.18em",
  color: "var(--text-dim)",
  margin: "10px 0 6px",
};

const hintStyle: CSSProperties = {
  font: "500 9px var(--font-mono)",
  letterSpacing: "0.06em",
  lineHeight: 1.7,
  color: "var(--text-dim)",
  marginTop: 10,
};

// the size control, shared by the tray (the size the next prop is stamped at)
// and the picked prop's popup (that prop's own size). onChange fires on every
// step of the drag so the canvas can preview it; onCommit fires once the thumb
// is let go, which is when the popup sends the resize
export function SizeSlider(props: {
  scale: number;
  onChange: (scale: number) => void;
  onCommit?: (scale: number) => void;
  // label above the track; the tray and the popup name it differently
  label: string;
}) {
  const commit = (): void => props.onCommit?.(props.scale);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          font: "600 9px var(--font-mono)",
          letterSpacing: "0.14em",
          color: "var(--text-dim)",
          whiteSpace: "nowrap",
        }}
      >
        {props.label}
      </span>
      <input
        className="decor-size-slider"
        type="range"
        aria-label={props.label}
        title={`${Math.round(props.scale * 100)}% of the prop's normal size`}
        min={ITEM_SCALE_MIN}
        max={ITEM_SCALE_MAX}
        step={ITEM_SCALE_STEP}
        value={props.scale}
        onChange={(e) => props.onChange(Number(e.target.value))}
        // both ways a thumb can be let go: the mouse and the arrow keys
        onPointerUp={commit}
        onKeyUp={commit}
        style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
      />
      <span
        style={{
          font: "600 9.5px var(--font-mono)",
          color: "var(--text)",
          width: 34,
          textAlign: "right",
        }}
      >
        {Math.round(props.scale * 100)}%
      </span>
    </div>
  );
}

// --- color picker ----------------------------------------------------------

// hsv -> #rrggbb; h in degrees, s and v in 0..1
function hsvHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const two = (n: number): string =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}`;
}

// #rrggbb -> hsv, so opening the wheel on an existing color puts the cursors
// where that color already is
function hexHsv(hex: string): { h: number; s: number; v: number } {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = (((g - b) / d) % 6) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const SQ = 132; // saturation/value square, px
const HUE_H = 14; // hue strip height, px

// the wheel: a saturation/value square over a hue strip, plus a hex field.
// Dragging either surface reports continuously, so the canvas previews it
function ColorWheel(props: { color: string; onPick: (hex: string) => void }) {
  const sqRef = useRef<HTMLCanvasElement | null>(null);
  const hueRef = useRef<HTMLCanvasElement | null>(null);
  const [hue, setHue] = useState(() => hexHsv(props.color).h);
  // what the hex field shows while it is being typed in — committing only on a
  // parseable value, so a half-typed "#3d6" doesn't repaint the prop
  const [draft, setDraft] = useState(props.color);
  useEffect(() => setDraft(props.color), [props.color]);

  // the square is white->hue left to right, transparent->black top to bottom
  useEffect(() => {
    const cv = sqRef.current;
    if (!cv) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const sat = g.createLinearGradient(0, 0, SQ, 0);
    sat.addColorStop(0, "#ffffff");
    sat.addColorStop(1, hsvHex(hue, 1, 1));
    g.fillStyle = sat;
    g.fillRect(0, 0, SQ, SQ);
    const val = g.createLinearGradient(0, 0, 0, SQ);
    val.addColorStop(0, "rgba(0,0,0,0)");
    val.addColorStop(1, "#000000");
    g.fillStyle = val;
    g.fillRect(0, 0, SQ, SQ);
  }, [hue]);

  // the strip is one sweep of the hue circle
  useEffect(() => {
    const cv = hueRef.current;
    if (!cv) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const grad = g.createLinearGradient(0, 0, SQ, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, hsvHex(i * 60, 1, 1));
    g.fillStyle = grad;
    g.fillRect(0, 0, SQ, HUE_H);
  }, []);

  // pointer position on a surface, clamped to it, as a 0..1 pair
  const at = (e: React.PointerEvent<HTMLCanvasElement>, h: number): { u: number; v: number } => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      u: Math.min(1, Math.max(0, (e.clientX - r.left) / SQ)),
      v: Math.min(1, Math.max(0, (e.clientY - r.top) / h)),
    };
  };

  // a press captures the pointer, so a drag that leaves the square keeps
  // reporting — the same feel as the size slider's thumb
  const drag =
    (h: number, report: (u: number, v: number) => void) =>
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (e.buttons !== 1 && e.type !== "pointerdown") return;
      if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId);
      const { u, v } = at(e, h);
      report(u, v);
    };

  const cur = hexHsv(props.color);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ position: "relative", width: SQ, height: SQ }}>
        <canvas
          ref={sqRef}
          width={SQ}
          height={SQ}
          onPointerDown={drag(SQ, (u, v) => props.onPick(hsvHex(hue, u, 1 - v)))}
          onPointerMove={drag(SQ, (u, v) => props.onPick(hsvHex(hue, u, 1 - v)))}
          style={{ borderRadius: 7, cursor: "crosshair", display: "block", touchAction: "none" }}
        />
        {/* where the current color sits in the square */}
        <div
          style={{
            position: "absolute",
            left: cur.s * SQ - 5,
            top: (1 - cur.v) * SQ - 5,
            width: 10,
            height: 10,
            borderRadius: "50%",
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
            pointerEvents: "none",
          }}
        />
      </div>
      <div style={{ position: "relative", width: SQ, height: HUE_H }}>
        <canvas
          ref={hueRef}
          width={SQ}
          height={HUE_H}
          onPointerDown={drag(HUE_H, (u) => {
            setHue(u * 360);
            props.onPick(hsvHex(u * 360, cur.s, cur.v));
          })}
          onPointerMove={drag(HUE_H, (u) => {
            setHue(u * 360);
            props.onPick(hsvHex(u * 360, cur.s, cur.v));
          })}
          style={{ borderRadius: 5, cursor: "crosshair", display: "block", touchAction: "none" }}
        />
        <div
          style={{
            position: "absolute",
            left: (hue / 360) * SQ - 2,
            top: -2,
            width: 4,
            height: HUE_H + 4,
            borderRadius: 3,
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
            pointerEvents: "none",
          }}
        />
      </div>
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const hex = normalizeItemColor(e.target.value);
          if (hex !== null) {
            setHue(hexHsv(hex).h);
            props.onPick(hex);
          }
        }}
        spellCheck={false}
        aria-label="Hex color"
        placeholder="#rrggbb"
        style={{
          width: SQ,
          padding: "5px 7px",
          borderRadius: 6,
          border: "1px solid var(--surface-border)",
          background: "rgba(255,255,255,.04)",
          color: "var(--text)",
          font: "600 10px var(--font-mono)",
          letterSpacing: "0.08em",
        }}
      />
    </div>
  );
}

// the color control, shared by the tray (the color the next prop is stamped in)
// and the picked prop's popup (that prop's own). A row of swatches for the fast
// path, DEFAULT to drop back to the authored art, and a wheel behind the last
// tile for anything else. onChange fires continuously so the canvas previews
// it; onCommit fires when the interaction settles, which is when the popup
// sends the recolor
export function ColorPicker(props: {
  color: string | null;
  onChange: (color: string | null) => void;
  onCommit?: (color: string | null) => void;
  label: string;
  // false when the picked prop's art declares no tintable slot: the control
  // still renders, greyed, rather than vanishing and jumping the popup around
  enabled: boolean;
}) {
  const [wheelOpen, setWheelOpen] = useState(false);
  // a swatch is one decision: report and commit together
  const set = (color: string | null): void => {
    props.onChange(color);
    props.onCommit?.(color);
  };
  return (
    <div style={{ position: "relative", opacity: props.enabled ? 1 : 0.35 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            font: "600 9px var(--font-mono)",
            letterSpacing: "0.14em",
            color: "var(--text-dim)",
            whiteSpace: "nowrap",
          }}
        >
          {props.label}
        </span>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          {ITEM_SWATCHES.map((hex) => (
            <button
              key={hex}
              disabled={!props.enabled}
              onClick={() => set(hex)}
              title={`Paint it ${hex}`}
              style={{
                width: 15,
                height: 15,
                padding: 0,
                borderRadius: 4,
                background: hex,
                border: `1.5px solid ${props.color === hex ? "var(--accent)" : "rgba(0,0,0,.45)"}`,
                cursor: props.enabled ? "pointer" : "default",
              }}
            />
          ))}
          {/* back to the color the art was drawn in */}
          <button
            disabled={!props.enabled}
            onClick={() => set(null)}
            title="Back to this prop's original color"
            style={{
              height: 15,
              padding: "0 5px",
              borderRadius: 4,
              background: "rgba(255,255,255,.04)",
              border: `1.5px solid ${props.color === null ? "var(--accent)" : "var(--surface-border)"}`,
              color: props.color === null ? "var(--accent)" : "var(--text-dim)",
              font: "600 7.5px var(--font-mono)",
              letterSpacing: "0.06em",
              cursor: props.enabled ? "pointer" : "default",
            }}
          >
            ORIG
          </button>
          {/* anything else: the wheel */}
          <button
            disabled={!props.enabled}
            onClick={() => setWheelOpen((v) => !v)}
            title="Pick any color, or type a hex code"
            style={{
              height: 15,
              padding: "0 5px",
              borderRadius: 4,
              background: "rgba(255,255,255,.04)",
              border: `1.5px solid ${wheelOpen ? "var(--accent)" : "var(--surface-border)"}`,
              color: wheelOpen ? "var(--accent)" : "var(--text-dim)",
              font: "600 7.5px var(--font-mono)",
              letterSpacing: "0.06em",
              cursor: props.enabled ? "pointer" : "default",
            }}
          >
            ···
          </button>
        </div>
      </div>
      {wheelOpen && props.enabled && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: 40,
            padding: 10,
            borderRadius: 11,
            background: "var(--surface-bg)",
            border: "1px solid var(--surface-border)",
            backdropFilter: "blur(14px)",
            boxShadow: "0 14px 40px rgba(0,0,0,.55)",
          }}
        >
          <ColorWheel
            // the wheel always edits a real color: a prop still on its authored
            // art opens the wheel on the first swatch rather than on nothing
            color={props.color ?? ITEM_SWATCHES[0]}
            onPick={props.onChange}
          />
          <button
            onClick={() => {
              props.onCommit?.(props.color);
              setWheelOpen(false);
            }}
            style={{
              marginTop: 8,
              width: "100%",
              height: 24,
              borderRadius: 7,
              border: "1px solid var(--accent-dim)",
              background: "var(--accent-faint)",
              color: "var(--accent)",
              font: "600 9px var(--font-mono)",
              letterSpacing: "0.14em",
              cursor: "pointer",
            }}
          >
            DONE
          </button>
        </div>
      )}
    </div>
  );
}

export function DecorPanel(props: {
  // the armed kind, or null while picking/moving props already on the deck
  armed: ItemKind | null;
  onArm: (kind: ItemKind | null) => void;
  // the size and color every prop stamped from here comes out at
  scale: number;
  onScale: (scale: number) => void;
  color: string | null;
  onColor: (color: string | null) => void;
  onClose: () => void;
}) {
  // the tray's color only means something for a kind that can wear one, and
  // with nothing armed there is no kind to judge — so it stays live until the
  // crew arms a prop whose art has no tintable slot
  const colorable = props.armed === null || itemIsColorable(props.armed);
  return (
    <div
      style={{
        position: "fixed",
        top: 70,
        left: 18,
        zIndex: 32,
        width: 244,
        maxHeight: "calc(100vh - 160px)",
        display: "flex",
        flexDirection: "column",
        padding: 16,
        background: "var(--surface-bg)",
        border: "1px solid var(--surface-border)",
        borderRadius: 15,
        backdropFilter: "blur(14px)",
        boxShadow: "0 14px 40px rgba(0,0,0,.5)",
        animation: "tilein .3s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={{ font: "600 11px var(--font-mono)", letterSpacing: "0.2em" }}>DECOR</span>
        <button
          className="hud-zoom-btn"
          onClick={props.onClose}
          title="Close the decor tray"
          style={{
            marginLeft: "auto",
            width: 26,
            height: 26,
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,.14)",
            background: "rgba(255,255,255,.05)",
            color: "var(--text)",
            font: "600 12px var(--font-sans)",
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ overflowY: "auto", marginTop: 4 }}>
        {GROUPS.map((group) => (
          <div key={group.title}>
            <div style={titleStyle}>{group.title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {group.kinds.map((kind) => {
                const on = props.armed === kind;
                return (
                  <button
                    key={kind}
                    onClick={() => props.onArm(on ? null : kind)}
                    title={`Place a ${itemLabel(kind).toLowerCase()}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 3,
                      padding: "8px 2px 5px",
                      borderRadius: 9,
                      border: `1px solid ${on ? "var(--accent)" : "var(--surface-border)"}`,
                      background: on ? "var(--accent-faint)" : "rgba(255,255,255,.03)",
                      cursor: "pointer",
                      transition: "all .15s",
                    }}
                  >
                    <img
                      // the armed tile wears the tray's color, so the choice is
                      // visible before anything is stamped; the rest of the
                      // library stays in its own colors
                      src={itemPreviewUrl(kind, on ? props.color : null)}
                      alt=""
                      style={{
                        width: 34,
                        height: 30,
                        objectFit: "contain",
                        // props are pixel art: keep the edges hard at any size
                        imageRendering: "pixelated",
                      }}
                    />
                    <span
                      style={{
                        font: "600 7.5px var(--font-mono)",
                        letterSpacing: "0.04em",
                        color: on ? "var(--accent)" : "var(--text-dim)",
                        textAlign: "center",
                        lineHeight: 1.2,
                      }}
                    >
                      {itemLabel(kind)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {/* the size and color the ghost — and so the next prop stamped — come
          out at */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: "1px solid var(--surface-border)",
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        <SizeSlider scale={props.scale} onChange={props.onScale} label="SIZE" />
        <ColorPicker
          color={props.color}
          onChange={props.onColor}
          label="COLOR"
          enabled={colorable}
        />
      </div>
      <div style={hintStyle}>
        {props.armed
          ? "CLICK THE DECK TO PLACE · CLICK THE TILE AGAIN TO STOP"
          : "PICK A PROP TO PLACE · DRAG ONE ON DECK TO MOVE IT · CLICK ONE TO RESIZE, RESTACK OR CLEAR IT"}
      </div>
    </div>
  );
}
