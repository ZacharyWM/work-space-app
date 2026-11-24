// cam/mic hardware picker: a gear button in the toolbar opens a popover with a
// dropdown per input kind. selection lives on LocalMedia (persisted to
// localStorage) and re-acquires the live track on change; here we just enumerate
// the devices and mirror the current choice. labels are only populated after a
// permission grant, so this surface is aboard-only (post-acquire).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  listInputDevices,
  type LocalMedia,
  type MediaDeviceOption,
} from "../media/localMedia";
import type { BackgroundEffect } from "../media/backgroundEffect";

// solid-background presets the picker offers as swatches — a couple of neutrals
// plus one accent; blur and off are separate controls alongside them
const SOLID_PRESETS = ["#1f2937", "#334155", "#e2e8f0", "#10b981"];

// toolbar-height neutral button, matching the hud's zoom/action buttons
const gearButtonStyle = (open: boolean): CSSProperties => ({
  width: 44,
  height: 44,
  borderRadius: 10,
  border: `1px solid ${open ? "var(--accent-dim)" : "rgba(255,255,255,.14)"}`,
  background: open ? "var(--accent-faint)" : "rgba(255,255,255,.05)",
  color: open ? "var(--accent)" : "var(--text)",
  font: "600 17px var(--font-sans)",
  cursor: "pointer",
  transition: "all .18s",
});

const selectLabelStyle: CSSProperties = {
  font: "600 9.5px var(--font-mono)",
  letterSpacing: "0.2em",
  color: "rgba(160,180,210,.55)",
};

const selectStyle: CSSProperties = {
  width: "100%",
  height: 38,
  padding: "0 10px",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,.16)",
  background: "rgba(255,255,255,.06)",
  color: "var(--text)",
  font: "500 12px var(--font-sans)",
  cursor: "pointer",
  appearance: "none",
};

// Off/Blur pill; the active one carries the accent ring like the gear button
const chipStyle = (active: boolean): CSSProperties => ({
  height: 30,
  padding: "0 12px",
  borderRadius: 8,
  border: `1px solid ${active ? "var(--accent-dim)" : "rgba(255,255,255,.16)"}`,
  background: active ? "var(--accent-faint)" : "rgba(255,255,255,.06)",
  color: active ? "var(--accent)" : "var(--text)",
  font: "600 11px var(--font-sans)",
  cursor: "pointer",
  transition: "all .18s",
});

// solid-color swatch; the active one gets an accent ring offset from the fill
const swatchStyle = (color: string, active: boolean): CSSProperties => ({
  width: 26,
  height: 26,
  borderRadius: "50%",
  background: color,
  border: "1px solid rgba(255,255,255,.2)",
  outline: active ? "2px solid var(--accent)" : "none",
  outlineOffset: 2,
  cursor: "pointer",
  padding: 0,
});

export function DeviceMenu(props: { media: LocalMedia }) {
  const { media } = props;
  const [open, setOpen] = useState(false);
  const [mics, setMics] = useState<MediaDeviceOption[]>([]);
  const [cams, setCams] = useState<MediaDeviceOption[]>([]);
  // mirror the manager's selection so the dropdowns reflect a pick immediately;
  // "" is the browser-default option, stored as null on the manager
  const [sel, setSel] = useState(media.devices);
  // mirror the chosen background effect so the controls reflect a pick at once
  const [bg, setBg] = useState<BackgroundEffect>(media.backgroundEffect);

  // while open, enumerate inputs and refresh on any device hotplug/unplug
  useEffect(() => {
    if (!open) return;
    let live = true;
    const refresh = () => {
      void listInputDevices().then((d) => {
        if (!live) return;
        setMics(d.mics);
        setCams(d.cams);
      });
    };
    refresh();
    setSel(media.devices);
    setBg(media.backgroundEffect);
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [open, media]);

  function pickMic(deviceId: string): void {
    const id = deviceId || null;
    setSel((s) => ({ ...s, micDeviceId: id }));
    void media.setMicDevice(id);
  }
  function pickCam(deviceId: string): void {
    const id = deviceId || null;
    setSel((s) => ({ ...s, camDeviceId: id }));
    void media.setCamDevice(id);
  }
  // background effect: mirror locally at once, then let LocalMedia build/swap/
  // tear down the processor. blur<->solid is a live swap; on<->off swaps the
  // sent track. re-sync afterward: a processor that fails to start falls back
  // to none, and the chip must not keep claiming the effect is on
  function pickEffect(effect: BackgroundEffect): void {
    setBg(effect);
    void media.setBackgroundEffect(effect).then((applied) => setBg(applied));
  }
  // is `effect` the one currently applied? solid also compares the color
  function effectActive(effect: BackgroundEffect): boolean {
    if (effect.mode === "solid") return bg.mode === "solid" && bg.color === effect.color;
    return bg.mode === effect.mode;
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        className="hud-zoom-btn"
        style={gearButtonStyle(open)}
        onClick={() => setOpen((v) => !v)}
        title="Choose camera and microphone"
      >
        ⚙
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 10px)",
            // grows rightward: the gear sits in the toolbar's left half, so a
            // right-anchored popover would clip off the viewport's left edge
            left: 0,
            zIndex: 35,
            width: 260,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "13px 14px",
            background: "var(--surface-bg)",
            border: "1px solid var(--surface-border)",
            borderRadius: 12,
            backdropFilter: "blur(14px)",
            boxShadow: "0 14px 40px rgba(0,0,0,.5)",
            animation: "toastin .2s ease",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={selectLabelStyle}>MICROPHONE</span>
            <select
              style={selectStyle}
              value={sel.micDeviceId ?? ""}
              onChange={(e) => pickMic(e.target.value)}
            >
              <option value="">System default</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={selectLabelStyle}>CAMERA</span>
            <select
              style={selectStyle}
              value={sel.camDeviceId ?? ""}
              onChange={(e) => pickCam(e.target.value)}
            >
              <option value="">System default</option>
              {cams.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={selectLabelStyle}>BACKGROUND</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button
                style={chipStyle(effectActive({ mode: "none" }))}
                onClick={() => pickEffect({ mode: "none" })}
                title="No background effect"
              >
                Off
              </button>
              <button
                style={chipStyle(effectActive({ mode: "blur" }))}
                onClick={() => pickEffect({ mode: "blur" })}
                title="Blur my background"
              >
                Blur
              </button>
              {SOLID_PRESETS.map((color) => (
                <button
                  key={color}
                  style={swatchStyle(color, effectActive({ mode: "solid", color }))}
                  onClick={() => pickEffect({ mode: "solid", color })}
                  title="Solid background"
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
