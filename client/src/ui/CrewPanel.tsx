// crew panel (notes/004): right-side panel opened from the CREW toolbar button.
// top: your presence status selector. below: everyone else aboard — status dot,
// name, where they are — each with a WAVE button that pings them directly.
// it's a side panel, not a modal, so the map stays visible while waving.
import { useState, type CSSProperties } from "react";
import type { PlayerStatus } from "shared";
import type { Connection } from "../net/connection";

// the three statuses in selector order, with their dot colors (theme ui vars)
const STATUSES: { value: PlayerStatus; label: string }[] = [
  { value: "available", label: "AVAILABLE" },
  { value: "busy", label: "BUSY" },
  { value: "away", label: "AWAY" },
];

// status dot colors, shared with the hud's own-name dot (theme ui vars)
export const STATUS_COLOR: Record<PlayerStatus, string> = {
  available: "var(--dot-on)",
  busy: "var(--dot-busy)",
  away: "var(--dot-off)",
};

// WAVE button reads SENT and stays disabled this long after each wave
const WAVE_COOLDOWN_MS = 2500;

const sectionLabelStyle: CSSProperties = {
  font: "600 9.5px var(--font-mono)",
  letterSpacing: "0.2em",
  color: "rgba(160,180,210,.55)",
  marginBottom: 8,
};

// small colored presence dot used in the selector and the roster rows
function dotStyle(status: PlayerStatus): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flex: "none",
    background: STATUS_COLOR[status],
  };
}

export function CrewPanel(props: {
  conn: Connection;
  // own status is owned by App so the toolbar dot stays in sync (notes/004)
  status: PlayerStatus;
  onSetStatus: (status: PlayerStatus) => void;
  // point the canvas guide line at this player (notes/010)
  onLocate: (id: string) => void;
  // creator-only: ban a Visitor off this workspace — kicks them home and
  // blocks future Visits even while the Link stands (space link feature, Q7)
  onBanVisitor: (userId: string) => void;
  onClose: () => void;
}) {
  const { conn } = props;
  // ids inside their post-wave cooldown; their button reads SENT, disabled
  const [waved, setWaved] = useState<ReadonlySet<string>>(new Set());
  // the BAN button's two-click confirm, keyed by player id
  const [banArmed, setBanArmed] = useState<string | null>(null);

  function waveAt(id: string): void {
    conn.send({ type: "wave", to: id });
    setWaved((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setWaved((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, WAVE_COOLDOWN_MS);
  }

  // where a player is, for the row subtitle: flight beats zone beats open
  // space; a Visitor's row leads with their home workspace (space link, Q6)
  function locationOf(p: {
    shipPad: number | null;
    zoneId: string | null;
    visitingFrom: string | null;
  }): string {
    const place =
      p.shipPad !== null
        ? "IN FLIGHT"
        : p.zoneId === null
          ? "OPEN SPACE"
          : (conn.map?.zones.find((z) => z.id === p.zoneId)?.name ?? p.zoneId);
    if (p.visitingFrom !== null) {
      return `VISITOR · ${p.visitingFrom.toUpperCase()} · ${place}`;
    }
    return place;
  }

  // roster Map preserves join order; self is shown in the selector, not the list
  const others = [...conn.roster.values()].filter((p) => p.id !== conn.selfId);

  return (
    <div
      style={{
        position: "fixed",
        top: 70,
        right: 18,
        zIndex: 32,
        width: 264,
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
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <span style={{ font: "600 11px var(--font-mono)", letterSpacing: "0.2em" }}>
          CREW · {conn.roster.size}
        </span>
        <button
          className="hud-zoom-btn"
          onClick={props.onClose}
          title="Close crew panel"
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

      {/* own status selector */}
      <div style={sectionLabelStyle}>YOUR STATUS</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {STATUSES.map((s) => {
          const selected = s.value === props.status;
          return (
            <button
              key={s.value}
              className="hud-media-btn"
              onClick={() => props.onSetStatus(s.value)}
              title={`Set status to ${s.label.toLowerCase()}`}
              style={{
                flex: 1,
                height: 32,
                borderRadius: 8,
                border: `1px solid ${selected ? "var(--accent-dim)" : "rgba(255,255,255,.14)"}`,
                background: selected ? "var(--accent-faint)" : "rgba(255,255,255,.05)",
                color: selected ? "var(--accent)" : "var(--text-dim)",
                font: "600 8.5px var(--font-mono)",
                letterSpacing: "0.08em",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                transition: "all .18s",
              }}
            >
              <span style={dotStyle(s.value)} />
              {s.label}
            </button>
          );
        })}
      </div>

      {/* everyone else aboard, wave targets */}
      <div style={sectionLabelStyle}>ABOARD</div>
      <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
        {others.length === 0 && (
          <div style={{ font: "500 11px var(--font-sans)", color: "var(--text-dim)", padding: "6px 0" }}>
            Nobody else is aboard.
          </div>
        )}
        {others.map((p) => {
          const sent = waved.has(p.id);
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 8px",
                borderRadius: 9,
                background: "rgba(255,255,255,.03)",
              }}
            >
              <span style={dotStyle(p.status)} title={p.status} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    font: "500 12px var(--font-sans)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {p.name}
                </div>
                <div
                  style={{
                    font: "500 8.5px var(--font-mono)",
                    letterSpacing: "0.1em",
                    color: "var(--text-dim)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {locationOf(p)}
                </div>
              </div>
              {/* locate: light the guide line to this player on the map (notes/010) */}
              <button
                className="hud-media-btn"
                onClick={() => props.onLocate(p.id)}
                title={`Show where ${p.name} is on the map`}
                style={{
                  flex: "none",
                  height: 28,
                  padding: "0 8px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,.14)",
                  background: "rgba(255,255,255,.05)",
                  color: "var(--text-dim)",
                  font: "600 9px var(--font-mono)",
                  letterSpacing: "0.1em",
                  cursor: "pointer",
                  transition: "all .18s",
                }}
              >
                LOCATE
              </button>
              {/* the workspace's creator may ban a Visitor: kicked home, and
                  future Visits refused even while the Link stands (Q7) */}
              {conn.owner && p.visitingFrom !== null && (
                <button
                  className="hud-media-btn"
                  onClick={() => {
                    if (banArmed !== p.id) {
                      setBanArmed(p.id);
                      return;
                    }
                    setBanArmed(null);
                    props.onBanVisitor(p.userId);
                  }}
                  title={
                    banArmed === p.id
                      ? "Click again to ban this visitor"
                      : `Ban ${p.name} from this workspace`
                  }
                  style={{
                    flex: "none",
                    height: 28,
                    padding: "0 8px",
                    borderRadius: 8,
                    border: `1px solid ${banArmed === p.id ? "rgba(255,77,77,.5)" : "rgba(255,255,255,.14)"}`,
                    background: banArmed === p.id ? "rgba(255,138,138,.12)" : "rgba(255,255,255,.05)",
                    color: banArmed === p.id ? "var(--danger)" : "var(--text-dim)",
                    font: "600 9px var(--font-mono)",
                    letterSpacing: "0.1em",
                    cursor: "pointer",
                    transition: "all .18s",
                  }}
                >
                  {banArmed === p.id ? "SURE?" : "BAN"}
                </button>
              )}
              <button
                className="hud-media-btn"
                disabled={sent}
                onClick={() => waveAt(p.id)}
                title={sent ? "Wave sent" : `Wave at ${p.name}`}
                style={{
                  flex: "none",
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 8,
                  border: `1px solid ${sent ? "rgba(255,255,255,.14)" : "var(--accent-dim)"}`,
                  background: sent ? "rgba(255,255,255,.05)" : "var(--accent-faint)",
                  color: sent ? "var(--text-dim)" : "var(--accent)",
                  font: "600 9px var(--font-mono)",
                  letterSpacing: "0.1em",
                  cursor: sent ? "default" : "pointer",
                  transition: "all .18s",
                }}
              >
                {sent ? "SENT" : "WAVE"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
