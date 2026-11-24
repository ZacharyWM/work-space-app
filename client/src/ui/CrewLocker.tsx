// crew locker (notes/002): the character + callsign customizer modal from the
// prototype. every pick applies instantly — written onto the self roster entry
// (the canvas reads it next frame) and relayed to the room; the server saves
// it to the user's profile (notes/005).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  HAIR_OPTIONS,
  HAT_OPTIONS,
  PANTS_OPTIONS,
  SHIRT_OPTIONS,
  SKIN_OPTIONS,
  type Character,
} from "shared";
import type { Connection } from "../net/connection";
import { buildSprite, type Facing } from "../render/sprite";

// keep in sync with the rename message's max length (shared/protocol)
const NAME_MAX = 32;

// preview canvas logical size (prototype)
const PREVIEW_W = 128;
const PREVIEW_H = 164;
// the preview mannequin turns through the four facings on this cadence (prototype)
const PREVIEW_TURN_MS = 1400;
const PREVIEW_WALK_MS = 220;
const PREVIEW_FACINGS: Facing[] = ["down", "right", "up", "left"];

const sectionLabelStyle: CSSProperties = {
  font: "600 9.5px var(--font-mono)",
  letterSpacing: "0.2em",
  color: "rgba(160,180,210,.55)",
  marginBottom: 7,
};

// round swatch for skin/hair, square-ish for shirt/pants (prototype shapes)
function swatchStyle(color: string, selected: boolean, round: boolean): CSSProperties {
  return {
    width: 27,
    height: 27,
    borderRadius: round ? "50%" : 8,
    background: color,
    border: `2px solid ${selected ? "var(--accent)" : "rgba(255,255,255,.18)"}`,
    cursor: "pointer",
    padding: 0,
    transition: "border-color .15s",
  };
}

export function CrewLocker(props: {
  conn: Connection;
  onClose: () => void;
  // a committed rename isn't echoed back by the server, so the hud (which
  // shows the name) must be told to rerender explicitly (notes/005)
  onRename: () => void;
}) {
  const { conn } = props;
  // the self roster entry is the live truth for what's worn aboard
  const self = conn.roster.get(conn.selfId!);
  const [character, setCharacter] = useState<Character>(self!.character);
  // the preview rAF loop reads the latest pick without re-registering
  const chRef = useRef(character);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // apply one edit everywhere: react state, roster, room; the server persists
  // it to the profile (notes/005)
  function apply(patch: Partial<Character>): void {
    const next = { ...chRef.current, ...patch };
    chRef.current = next;
    setCharacter(next);
    if (self) self.character = next;
    conn.send({ type: "character", character: next });
  }

  // callsign draft; committed on blur or enter, reverted when emptied (notes/005)
  const [name, setName] = useState(self!.name);
  function commitName(): void {
    const trimmed = name.trim().slice(0, NAME_MAX);
    // nothing typed or nothing changed: snap the field back to the live name
    if (trimmed === "" || trimmed === self!.name) {
      setName(self!.name);
      return;
    }
    setName(trimmed);
    self!.name = trimmed;
    conn.send({ type: "rename", name: trimmed });
    props.onRename();
  }

  // animated mannequin: cycles facing and walk frames (prototype drawPreview)
  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = PREVIEW_W * dpr;
    canvas.height = PREVIEW_H * dpr;
    const ctx = canvas.getContext("2d")!; // 2d context never fails on a fresh canvas
    let raf = 0;
    const draw = (t: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#0B101D";
      ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
      // faint grid backdrop
      ctx.strokeStyle = "rgba(110,140,190,.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = 8; gx < PREVIEW_W; gx += 24) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, PREVIEW_H);
      }
      for (let gy = 8; gy < PREVIEW_H; gy += 24) {
        ctx.moveTo(0, gy);
        ctx.lineTo(PREVIEW_W, gy);
      }
      ctx.stroke();
      const dir = PREVIEW_FACINGS[Math.floor(t / PREVIEW_TURN_MS) % 4]!;
      const frame = Math.floor(t / PREVIEW_WALK_MS) % 2;
      ctx.fillStyle = "rgba(0,0,0,.4)";
      ctx.beginPath();
      ctx.ellipse(64, 152, 26, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.drawImage(buildSprite(chRef.current, dir, frame), 14, 2, 100, 150);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(3,5,10,.62)",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        style={{
          width: 470,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          background: "var(--card-bg)",
          border: "1px solid rgba(120,150,200,.18)",
          borderRadius: 16,
          padding: 24,
          boxShadow: "0 30px 80px rgba(0,0,0,.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ font: "600 10.5px var(--font-mono)", letterSpacing: "0.24em", color: "var(--accent)" }}>
              CREW LOCKER
            </div>
            <h2 style={{ margin: "8px 0 0", fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}>
              Your character
            </h2>
          </div>
          <button
            onClick={props.onClose}
            title="Close"
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              border: "1px solid rgba(255,255,255,.14)",
              background: "rgba(255,255,255,.05)",
              color: "var(--text)",
              fontSize: 15,
              cursor: "pointer",
              flex: "none",
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 18, alignItems: "flex-start" }}>
          <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
            <canvas
              ref={canvasRef}
              style={{
                width: PREVIEW_W,
                height: PREVIEW_H,
                borderRadius: 12,
                border: "1px solid rgba(120,150,200,.2)",
                background: "#0B101D",
              }}
            />
            <div style={{ font: "500 9.5px var(--font-mono)", letterSpacing: "0.14em", color: "var(--text-dim)" }}>
              PREVIEW
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 13 }}>
            <div>
              <div style={sectionLabelStyle}>CALLSIGN</div>
              {/* commits on blur/enter; the rename rides to the room + profile (notes/005) */}
              <input
                value={name}
                maxLength={NAME_MAX}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                style={{
                  width: "100%",
                  height: 38,
                  borderRadius: 9,
                  border: "1px solid rgba(120,150,200,.22)",
                  background: "rgba(255,255,255,.04)",
                  color: "var(--text)",
                  padding: "0 12px",
                  font: "500 13.5px var(--font-sans)",
                  outline: "none",
                }}
              />
            </div>
            <div>
              <div style={sectionLabelStyle}>SKIN</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {SKIN_OPTIONS.map((c) => (
                  <button
                    key={c}
                    title="Skin color"
                    style={swatchStyle(c, c === character.skin, true)}
                    onClick={() => apply({ skin: c })}
                  />
                ))}
              </div>
            </div>
            <div>
              <div style={sectionLabelStyle}>HAIR · FIRST = NONE</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {HAIR_OPTIONS.map((c) => (
                  <button
                    key={c}
                    title="Hair"
                    // the bald option renders as a dark empty swatch (prototype)
                    style={swatchStyle(c === "none" ? "#10151F" : c, c === character.hair, true)}
                    onClick={() => apply({ hair: c })}
                  />
                ))}
              </div>
            </div>
            <div>
              <div style={sectionLabelStyle}>SHIRT</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {SHIRT_OPTIONS.map((c) => (
                  <button
                    key={c}
                    title="Shirt color"
                    style={swatchStyle(c, c === character.shirt, false)}
                    onClick={() => apply({ shirt: c })}
                  />
                ))}
              </div>
            </div>
            <div>
              <div style={sectionLabelStyle}>PANTS</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {PANTS_OPTIONS.map((c) => (
                  <button
                    key={c}
                    title="Pants color"
                    style={swatchStyle(c, c === character.pants, false)}
                    onClick={() => apply({ pants: c })}
                  />
                ))}
              </div>
            </div>
            <div>
              <div style={sectionLabelStyle}>HAT</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {HAT_OPTIONS.map((h) => {
                  const selected = h === character.hat;
                  return (
                    <button
                      key={h}
                      style={{
                        height: 30,
                        padding: "0 11px",
                        borderRadius: 8,
                        border: `1px solid ${selected ? "var(--accent)" : "rgba(255,255,255,.14)"}`,
                        background: selected ? "var(--accent)" : "rgba(255,255,255,.05)",
                        color: selected ? "var(--bg)" : "rgba(200,215,235,.75)",
                        font: "600 10px var(--font-mono)",
                        letterSpacing: "0.1em",
                        cursor: "pointer",
                        transition: "all .15s",
                      }}
                      onClick={() => apply({ hat: h })}
                    >
                      {h.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                paddingTop: 2,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Space helmet</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>
                  {character.helmet ? "Dome on — EVA ready" : "No dome"}
                </div>
              </div>
              {/* toggle switch, same look as the join screen rows */}
              <button
                title="Toggle helmet"
                onClick={() => apply({ helmet: !character.helmet })}
                style={{
                  width: 44,
                  height: 25,
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  position: "relative",
                  background: character.helmet ? "var(--accent-strong)" : "rgba(255,255,255,.14)",
                  transition: "background .2s",
                  flex: "none",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: 3,
                    left: character.helmet ? 22 : 3,
                    width: 19,
                    height: 19,
                    borderRadius: "50%",
                    background: "white",
                    transition: "left .2s",
                    boxShadow: "0 1px 3px rgba(0,0,0,.4)",
                  }}
                />
              </button>
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginTop: 20,
            paddingTop: 14,
            borderTop: "1px solid rgba(255,255,255,.06)",
          }}
        >
          <div style={{ font: "500 9.5px var(--font-mono)", letterSpacing: "0.12em", color: "rgba(160,180,210,.45)" }}>
            SAVED TO YOUR PROFILE
          </div>
          <button
            onClick={props.onClose}
            style={{
              height: 42,
              padding: "0 22px",
              borderRadius: 10,
              border: "none",
              background: "var(--accent)",
              color: "var(--bg)",
              font: "600 11.5px var(--font-mono)",
              letterSpacing: "0.16em",
              cursor: "pointer",
            }}
          >
            DONE
          </button>
        </div>
      </div>
    </div>
  );
}
