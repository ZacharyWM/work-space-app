// per-workspace best-score list shared by the two holotable lobby panels
// (leaderboard feature): one row per account, best first, top 10 as the
// server sends them. Rendered from conn.leaderboards, which App rerenders on
// every leaderboards message
import type { LeaderboardEntry } from "shared";

export function Leaderboard(props: {
  // section label, e.g. "BEST TIMES"
  title: string;
  // rows as the server ranked them
  entries: LeaderboardEntry[];
  // the viewer's clerk user id, to mark their own row ("" = unknown)
  selfUserId: string;
  // score → display text (race time vs kill count)
  format: (score: number) => string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          font: "600 8.5px var(--font-mono)",
          letterSpacing: "0.18em",
          color: "var(--text-dim)",
          borderTop: "1px solid rgba(255,255,255,.08)",
          paddingTop: 10,
          marginBottom: 6,
        }}
      >
        {props.title}
      </div>
      {props.entries.length === 0 ? (
        <div style={{ font: "500 9px var(--font-mono)", color: "var(--text-dim)" }}>
          NO RECORDS YET
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {props.entries.map((e, i) => (
            <div key={e.userId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  flex: "none",
                  width: 16,
                  font: "600 9px var(--font-mono)",
                  color: i === 0 ? "var(--accent)" : "var(--text-dim)",
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.name}
                {e.userId === props.selfUserId && props.selfUserId !== "" && (
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}> · YOU</span>
                )}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  font: "600 10px var(--font-mono)",
                  color: i === 0 ? "var(--accent)" : "var(--text)",
                }}
              >
                {props.format(e.score)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
