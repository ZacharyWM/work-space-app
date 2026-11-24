// race hud (shuttle race feature): the 3-2-1-GO countdown, the local racer's
// gate progress + clock, live standings while any race runs, and the final
// results card. All live data reads from conn.race; App rerenders this on
// every race message
import { useEffect, useState } from "react";
import type { RaceResult } from "shared";
import type { Connection } from "../net/connection";

// how long the GO flash lingers after the countdown ends
const GO_FLASH_MS = 900;

// mm:ss.t, the race clock format everywhere (App reuses it for the finish toast)
export function raceTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const tenths = Math.floor((t % 1000) / 100);
  return `${m}:${String(s).padStart(2, "0")}.${tenths}`;
}

const panelStyle: React.CSSProperties = {
  position: "fixed",
  right: 18,
  top: 64,
  zIndex: 22,
  width: 210,
  padding: "12px 14px",
  background: "var(--surface-bg)",
  border: "1px solid var(--surface-border)",
  borderRadius: 12,
  backdropFilter: "blur(14px)",
  boxShadow: "0 14px 40px rgba(0,0,0,.5)",
};

const panelTitleStyle: React.CSSProperties = {
  font: "600 9px var(--font-mono)",
  letterSpacing: "0.22em",
  color: "var(--accent)",
  marginBottom: 8,
};

export function RaceHud(props: {
  conn: Connection;
  // true while the local player is out on the course
  racing: boolean;
  // gates the local player has passed (stage callback)
  selfGate: number;
  // epoch ms of GO (raceStarted receipt + countdown); null when spectating
  goAt: number | null;
  onQuit: () => void;
}) {
  const { conn, racing, goAt } = props;
  // 10Hz clock for the countdown and the race timer
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!conn.race.racing) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [conn.race.racing]);

  if (!conn.race.racing) return null;
  const gateCount = conn.race.gates.length;

  // live standings: finishers by place, then everyone still out by gates passed
  const nameOf = (id: string): string =>
    conn.race.members.find((m) => m.id === id)?.name ?? conn.roster.get(id)?.name ?? "?";
  const running = [...conn.race.progress.entries()]
    .map(([id, gate]) => ({ id, gate }))
    .sort((a, b) => b.gate - a.gate);

  // countdown overlay: 3..1, then a brief GO flash
  const untilGo = goAt === null ? null : goAt - now;
  const showCount = racing && untilGo !== null && untilGo > 0;
  const showGo = racing && untilGo !== null && untilGo <= 0 && untilGo > -GO_FLASH_MS;

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
            color: "var(--accent)",
            textShadow: "0 0 40px rgba(62,224,138,.45)",
            pointerEvents: "none",
          }}
        >
          {showGo ? "GO" : Math.ceil((untilGo ?? 0) / 1000)}
        </div>
      )}
      <div style={panelStyle}>
        <div style={panelTitleStyle}>SHUTTLE RACE</div>
        {/* own progress + clock while out on the course */}
        {racing && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ font: "700 15px var(--font-mono)", color: "var(--text)" }}>
              GATE {Math.min(props.selfGate + 1, gateCount)} / {gateCount}
            </div>
            <div style={{ font: "600 12px var(--font-mono)", color: "var(--accent)" }}>
              {goAt === null ? "0:00.0" : raceTime(now - goAt)}
            </div>
          </div>
        )}
        {/* standings: finishers, then racers by distance around the loop */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {conn.race.finishes.map((f) => (
            <div
              key={f.id}
              style={{
                display: "flex",
                gap: 6,
                font: "600 10px var(--font-mono)",
                color: f.id === conn.selfId ? "var(--accent)" : "var(--text)",
              }}
            >
              <span style={{ flex: "none", width: 18 }}>P{f.place}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.name.toUpperCase()}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>{raceTime(f.timeMs)}</span>
            </div>
          ))}
          {running.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                gap: 6,
                font: "600 10px var(--font-mono)",
                color: r.id === conn.selfId ? "var(--accent)" : "var(--text-dim)",
              }}
            >
              <span style={{ flex: "none", width: 18 }}>·</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {nameOf(r.id).toUpperCase()}
              </span>
              <span style={{ marginLeft: "auto" }}>
                {r.gate}/{gateCount}
              </span>
            </div>
          ))}
        </div>
        {racing && (
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
            title="Drop out of the race"
          >
            QUIT RACE
          </button>
        )}
      </div>
    </>
  );
}

// the scoreboard card: pops up for a finisher the moment they cross the line
// (results null — live standings that update as the others finish) and for
// everyone when the race ends (final standings); stays up until CLOSE. While
// it's up, a finisher keeps race comms via the debrief — App releases it on close
export function RaceResults(props: {
  conn: Connection;
  // final standings, or null while the race still runs (live mode)
  results: RaceResult[] | null;
  selfId: string | null;
  onClose: () => void;
}) {
  const { conn, results } = props;
  const gateCount = conn.race.gates.length;
  const nameOf = (id: string): string =>
    conn.race.members.find((m) => m.id === id)?.name ?? conn.roster.get(id)?.name ?? "?";
  // live mode: everyone still out on the course, leaders first
  const running =
    results === null
      ? [...conn.race.progress.entries()].map(([id, gate]) => ({ id, gate })).sort((a, b) => b.gate - a.gate)
      : [];
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
        border: "1px solid var(--accent)",
        borderRadius: 14,
        boxShadow: "0 10px 36px rgba(0,0,0,.55), 0 0 24px rgba(62,224,138,.15)",
        animation: "toastin .25s ease",
      }}
    >
      <div
        style={{
          font: "600 10px var(--font-mono)",
          letterSpacing: "0.22em",
          color: "var(--accent)",
          marginBottom: 10,
        }}
      >
        {results === null ? "RACE RESULTS · LIVE" : "RACE RESULTS"}
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
            <span style={{ flex: "none", width: 24 }}>{r.timeMs === null ? "—" : `P${i + 1}`}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.name.toUpperCase()}
            </span>
            <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>
              {r.timeMs === null ? "DNF" : raceTime(r.timeMs)}
            </span>
          </div>
        ))}
        {/* live mode: finishers so far, then everyone still out by gates passed */}
        {results === null &&
          conn.race.finishes.map((f) => (
            <div
              key={f.id}
              style={{
                display: "flex",
                gap: 8,
                font: "600 11px var(--font-mono)",
                color: f.id === props.selfId ? "var(--accent)" : "var(--text)",
              }}
            >
              <span style={{ flex: "none", width: 24 }}>P{f.place}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.name.toUpperCase()}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>{raceTime(f.timeMs)}</span>
            </div>
          ))}
        {running.map((r) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              gap: 8,
              font: "600 11px var(--font-mono)",
              color: r.id === props.selfId ? "var(--accent)" : "var(--text-dim)",
            }}
          >
            <span style={{ flex: "none", width: 24 }}>·</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {nameOf(r.id).toUpperCase()}
            </span>
            <span style={{ marginLeft: "auto" }}>
              {r.gate}/{gateCount}
            </span>
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
