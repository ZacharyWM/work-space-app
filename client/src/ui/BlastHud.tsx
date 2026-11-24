// blasters hud (shuttle blasters feature): the 3-2-1-FIGHT countdown, the
// live roster of who's still flying vs destroyed while any match runs, and
// the final results card. All live data reads from conn.blast; App rerenders
// this on every blasters message
import { useEffect, useState } from "react";
import type { BlastResult } from "shared";
import type { Connection } from "../net/connection";

// how long the FIGHT flash lingers after the countdown ends
const FIGHT_FLASH_MS = 900;

// panel geometry; the top offset drops below the race hud's slot when a race
// runs at the same time so the two standings don't overlap
const panelStyle: React.CSSProperties = {
  position: "fixed",
  right: 18,
  zIndex: 22,
  width: 210,
  padding: "12px 14px",
  background: "var(--surface-bg)",
  border: "1px solid var(--surface-border)",
  borderRadius: 12,
  backdropFilter: "blur(14px)",
  boxShadow: "0 14px 40px rgba(0,0,0,.5)",
};

export function BlastHud(props: {
  conn: Connection;
  // true while the local player is out in the arena
  blasting: boolean;
  // epoch ms of FIGHT (blastStarted receipt + countdown); null when spectating
  goAt: number | null;
  onQuit: () => void;
}) {
  const { conn, blasting, goAt } = props;
  // 10Hz clock for the countdown
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!conn.blast.playing) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [conn.blast.playing]);

  if (!conn.blast.playing) return null;

  const nameOf = (id: string): string =>
    conn.blast.members.find((m) => m.id === id)?.name ?? conn.roster.get(id)?.name ?? "?";
  const alive = [...conn.blast.alive];
  // newest kill first, so the feed reads top-down
  const fallen = [...conn.blast.eliminated].reverse();

  // countdown overlay: 3..1, then a brief FIGHT flash
  const untilGo = goAt === null ? null : goAt - now;
  const showCount = blasting && untilGo !== null && untilGo > 0;
  const showGo = blasting && untilGo !== null && untilGo <= 0 && untilGo > -FIGHT_FLASH_MS;

  return (
    <>
      {(showCount || showGo) && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            top: "34%",
            transform: "translate(-50%,-50%)",
            zIndex: 34,
            font: "700 84px var(--font-mono)",
            color: "var(--danger)",
            textShadow: "0 0 40px rgba(255,138,138,.45)",
            pointerEvents: "none",
          }}
        >
          {showGo ? "FIGHT" : Math.ceil((untilGo ?? 0) / 1000)}
        </div>
      )}
      <div style={{ ...panelStyle, top: conn.race.racing ? 420 : 64 }}>
        <div
          style={{
            font: "600 9px var(--font-mono)",
            letterSpacing: "0.22em",
            color: "var(--danger)",
            marginBottom: 8,
          }}
        >
          SHUTTLE BLASTERS
        </div>
        {/* own status while the match runs */}
        <div style={{ marginBottom: 8, font: "700 15px var(--font-mono)", color: "var(--text)" }}>
          {blasting ? `${alive.length} SHIP${alive.length === 1 ? "" : "S"} LEFT` : "SPECTATING"}
        </div>
        {/* who's still flying, then the fallen (newest first) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {alive.map((id) => (
            <div
              key={id}
              style={{
                display: "flex",
                gap: 6,
                font: "600 10px var(--font-mono)",
                color: id === conn.selfId ? "var(--accent)" : "var(--text)",
              }}
            >
              <span style={{ flex: "none", width: 18 }}>▲</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {nameOf(id).toUpperCase()}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--dot-on)" }}>ALIVE</span>
            </div>
          ))}
          {fallen.map((f) => (
            <div
              key={f.id}
              style={{
                display: "flex",
                gap: 6,
                font: "600 10px var(--font-mono)",
                color: f.id === conn.selfId ? "var(--accent)" : "var(--text-dim)",
              }}
            >
              <span style={{ flex: "none", width: 18 }}>✕</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.name.toUpperCase()}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--danger)" }}>OUT</span>
            </div>
          ))}
        </div>
        {blasting && (
          <button
            className="hud-media-btn"
            onClick={props.onQuit}
            style={{
              width: "100%",
              height: 30,
              marginTop: 10,
              borderRadius: 8,
              border: "1px solid rgba(255,77,77,.4)",
              background: "rgba(255,77,77,.08)",
              color: "var(--danger)",
              font: "600 9px var(--font-mono)",
              letterSpacing: "0.12em",
              cursor: "pointer",
            }}
            title="Forfeit the fight"
          >
            QUIT MATCH
          </button>
        )}
      </div>
    </>
  );
}

// the scoreboard card: pops up for a fallen player the moment they're blasted
// (results null — live standings that update as the others fall) and for
// everyone when the match ends (final standings); stays up until CLOSE. While
// it's up, a fallen player keeps match comms via the debrief — App releases it on close
export function BlastResults(props: {
  conn: Connection;
  // final standings, or null while the match still runs (live mode)
  results: BlastResult[] | null;
  selfId: string | null;
  onClose: () => void;
}) {
  const { conn, results } = props;
  const nameOf = (id: string): string =>
    conn.blast.members.find((m) => m.id === id)?.name ?? conn.roster.get(id)?.name ?? "?";
  // live mode: who's still flying, then the fallen (newest first)
  const alive = results === null ? [...conn.blast.alive] : [];
  const fallen = results === null ? [...conn.blast.eliminated].reverse() : [];
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        top: 84,
        transform: "translateX(-50%)",
        zIndex: 36,
        width: 300,
        maxWidth: "calc(100vw - 40px)",
        padding: "16px 18px",
        background: "rgba(10,15,28,.96)",
        border: "1px solid var(--danger)",
        borderRadius: 14,
        boxShadow: "0 10px 36px rgba(0,0,0,.55), 0 0 24px rgba(255,138,138,.15)",
        animation: "toastin .25s ease",
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
        {results === null ? "BLASTERS RESULTS · LIVE" : "BLASTERS RESULTS"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {(results ?? []).map((r, i) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              gap: 8,
              font: "600 11px var(--font-mono)",
              color: r.id === props.selfId ? "var(--accent)" : "var(--text)",
            }}
          >
            <span style={{ flex: "none", width: 24 }}>P{i + 1}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.name.toUpperCase()}
            </span>
            <span
              style={{ marginLeft: "auto", color: r.survived ? "var(--dot-on)" : "var(--text-dim)" }}
            >
              {i === 0 && r.survived ? "WINNER" : r.survived ? "SURVIVED" : "DESTROYED"}
            </span>
          </div>
        ))}
        {/* live mode: who's still flying, then the fallen (newest first) */}
        {alive.map((id) => (
          <div
            key={id}
            style={{
              display: "flex",
              gap: 8,
              font: "600 11px var(--font-mono)",
              color: id === props.selfId ? "var(--accent)" : "var(--text)",
            }}
          >
            <span style={{ flex: "none", width: 24 }}>▲</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {nameOf(id).toUpperCase()}
            </span>
            <span style={{ marginLeft: "auto", color: "var(--dot-on)" }}>ALIVE</span>
          </div>
        ))}
        {fallen.map((f) => (
          <div
            key={f.id}
            style={{
              display: "flex",
              gap: 8,
              font: "600 11px var(--font-mono)",
              color: f.id === props.selfId ? "var(--accent)" : "var(--text-dim)",
            }}
          >
            <span style={{ flex: "none", width: 24 }}>✕</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {f.name.toUpperCase()}
            </span>
            <span style={{ marginLeft: "auto", color: "var(--danger)" }}>OUT</span>
          </div>
        ))}
      </div>
      <button
        className="hud-media-btn"
        onClick={props.onClose}
        style={{
          width: "100%",
          height: 32,
          marginTop: 12,
          borderRadius: 8,
          border: "1px solid var(--accent-dim)",
          background: "var(--accent-faint)",
          color: "var(--accent)",
          font: "600 9.5px var(--font-mono)",
          letterSpacing: "0.12em",
          cursor: "pointer",
        }}
      >
        CLOSE
      </button>
    </div>
  );
}
