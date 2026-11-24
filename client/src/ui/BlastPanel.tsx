// shuttle blasters lobby panel (holotable game): shown while this player has
// a seat at the blasters table. Members ready up; once everyone (at least
// two) is ready anyone can hit START. Rendered from conn.blast, which App
// rerenders on every blasters message
import type { Connection } from "../net/connection";
import { Leaderboard } from "./Leaderboard";

// small mono action button, matching the race panel's
function blastButtonStyle(accent: boolean, disabled: boolean): React.CSSProperties {
  return {
    flex: 1,
    height: 38,
    borderRadius: 9,
    border: `1px solid ${accent ? "var(--accent-dim)" : "rgba(255,255,255,.16)"}`,
    background: accent ? "var(--accent-faint)" : "rgba(255,255,255,.06)",
    color: accent ? "var(--accent)" : "var(--text)",
    font: "600 10px var(--font-mono)",
    letterSpacing: "0.1em",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "all .18s",
  };
}

export function BlastPanel(props: {
  conn: Connection;
  onReady: (on: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
}) {
  const { conn } = props;
  const members = conn.blast.members;
  const self = members.find((m) => m.id === conn.selfId);
  // a fight takes at least two shuttles (the server enforces needTwo too)
  const canStart = members.length >= 2 && members.every((m) => m.ready);
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: 92,
        zIndex: 28,
        width: 300,
        maxWidth: "calc(100vw - 40px)",
        padding: "14px 16px",
        background: "var(--surface-bg)",
        border: "1px solid var(--surface-border)",
        borderRadius: 14,
        backdropFilter: "blur(14px)",
        boxShadow: "0 14px 40px rgba(0,0,0,.5)",
        animation: "toastin .2s ease",
      }}
    >
      <div
        style={{
          font: "600 10px var(--font-mono)",
          letterSpacing: "0.22em",
          color: "var(--danger)",
          marginBottom: 10,
        }}
      >
        HOLOTABLE · SHUTTLE BLASTERS
      </div>
      {/* one row per lobby member: ready dot + name */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {members.map((m) => (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flex: "none",
                background: m.ready ? "var(--dot-on)" : "var(--dot-off)",
                transition: "background .2s",
              }}
            />
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {m.name}
              {m.id === conn.selfId && (
                <span style={{ color: "var(--accent)", fontWeight: 600 }}> · YOU</span>
              )}
            </span>
            <span
              style={{
                marginLeft: "auto",
                font: "600 8.5px var(--font-mono)",
                letterSpacing: "0.1em",
                color: m.ready ? "var(--dot-on)" : "var(--text-dim)",
              }}
            >
              {m.ready ? "READY" : "WAITING"}
            </span>
          </div>
        ))}
      </div>
      {/* the workspace's best single-match kill counts (leaderboard feature) */}
      <Leaderboard
        title="MOST BLASTED"
        entries={conn.leaderboards.blast}
        selfUserId={conn.selfId ? (conn.roster.get(conn.selfId)?.userId ?? "") : ""}
        format={(score) => String(score)}
      />
      {/* solo lobbies wait for an opponent before START can arm */}
      {members.length < 2 && (
        <div
          style={{
            marginBottom: 10,
            font: "500 9px var(--font-mono)",
            letterSpacing: "0.1em",
            color: "var(--text-dim)",
          }}
        >
          NEEDS AT LEAST 2 PILOTS TO START
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="hud-media-btn"
          style={blastButtonStyle(self?.ready === true, false)}
          onClick={() => props.onReady(!(self?.ready === true))}
          title={self?.ready ? "Not ready after all" : "Ready to fight"}
        >
          {self?.ready ? "READY ✓" : "READY"}
        </button>
        <button
          className="hud-media-btn"
          style={blastButtonStyle(false, !canStart)}
          disabled={!canStart}
          onClick={props.onStart}
          title={
            members.length < 2
              ? "A fight takes at least two shuttles"
              : canStart
                ? "Launch the fight"
                : "Everyone must be ready to start"
          }
        >
          START
        </button>
        <button
          className="hud-media-btn"
          style={{
            ...blastButtonStyle(false, false),
            flex: "none",
            padding: "0 12px",
            borderColor: "rgba(255,77,77,.4)",
            color: "var(--danger)",
          }}
          onClick={props.onLeave}
          title="Leave the blasters lobby"
        >
          LEAVE
        </button>
      </div>
    </div>
  );
}
