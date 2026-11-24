// chat panel (notes/010): left-side panel opened from the CHAT toolbar button.
// message log on top (ship history + everything received live), composer below
// with a SHIP/ZONE scope toggle — zone scope reaches only the sender's current
// zone and is disabled in open space. a side panel like the crew panel, so the
// map stays visible while chatting.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ChatScope } from "shared";
import type { Connection } from "../net/connection";

// composer cap mirrors the protocol's chatTextSchema max (notes/010)
const CHAT_MAX_LEN = 500;

const scopeLabelStyle: CSSProperties = {
  font: "600 9.5px var(--font-mono)",
  letterSpacing: "0.2em",
  color: "rgba(160,180,210,.55)",
};

// hh:mm in the viewer's locale; chat is same-day chatter, dates would be noise
function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatPanel(props: {
  conn: Connection;
  // own zone gates the ZONE scope; null = open space (notes/010)
  zoneId: string | null;
  onClose: () => void;
}) {
  const { conn } = props;
  const [scope, setScope] = useState<ChatScope>("ship");
  const [draft, setDraft] = useState("");
  // the scrollable log; kept pinned to the newest message
  const logRef = useRef<HTMLDivElement | null>(null);

  // out of a zone, a picked ZONE scope falls back to SHIP (notes/010)
  const zoneScopeOff = props.zoneId === null;
  const effectiveScope = scope === "zone" && zoneScopeOff ? "ship" : scope;

  // pin the log to the bottom as messages arrive (and on open)
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [conn.chat.length]);

  function sendDraft(): void {
    const text = draft.trim();
    if (text === "") return;
    conn.send({ type: "chat", scope: effectiveScope, text });
    // the log entry arrives via the server echo — no local append (notes/010)
    setDraft("");
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 70,
        left: 18,
        zIndex: 32,
        width: 300,
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
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span style={{ font: "600 11px var(--font-mono)", letterSpacing: "0.2em" }}>COMMS</span>
        <button
          className="hud-zoom-btn"
          onClick={props.onClose}
          title="Close chat"
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

      {/* message log, oldest at the top, pinned to the newest */}
      <div
        ref={logRef}
        style={{
          flex: 1,
          minHeight: 120,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          paddingRight: 4,
        }}
      >
        {conn.chat.length === 0 && (
          <div style={{ font: "500 11px var(--font-sans)", color: "var(--text-dim)", padding: "6px 0" }}>
            Nothing yet. Say something — SHIP reaches everyone aboard, ZONE just your room.
          </div>
        )}
        {conn.chat.map((m) => {
          const mine = m.from === conn.selfId;
          return (
            <div key={m.id}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span
                  style={{
                    font: "600 10.5px var(--font-mono)",
                    letterSpacing: "0.06em",
                    color: mine ? "var(--accent)" : "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {mine ? "YOU" : m.name.toUpperCase()}
                </span>
                {/* zone-scoped messages are marked — they reached only the room;
                    announcements are marked in accent (notes/010) */}
                {m.scope === "zone" && (
                  <span style={{ font: "600 8px var(--font-mono)", letterSpacing: "0.14em", color: "var(--accent-dim, rgba(160,180,210,.55))" }}>
                    ZONE
                  </span>
                )}
                {m.scope === "announce" && (
                  <span style={{ font: "600 8px var(--font-mono)", letterSpacing: "0.14em", color: "var(--accent)" }}>
                    ALL HANDS
                  </span>
                )}
                <span style={{ marginLeft: "auto", font: "500 9px var(--font-mono)", color: "rgba(160,180,210,.45)", flex: "none" }}>
                  {timeOf(m.ts)}
                </span>
              </div>
              <div
                style={{
                  font: "400 12.5px var(--font-sans)",
                  lineHeight: 1.45,
                  color: "rgba(225,235,250,.92)",
                  overflowWrap: "anywhere",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.text}
              </div>
            </div>
          );
        })}
      </div>

      {/* composer: scope toggle + input; Enter sends */}
      <div style={{ display: "flex", gap: 6, margin: "12px 0 6px" }}>
        {(["ship", "zone", "announce"] as const).map((s) => {
          const selected = effectiveScope === s;
          const off = s === "zone" && zoneScopeOff;
          return (
            <button
              key={s}
              className="hud-media-btn"
              disabled={off}
              onClick={() => setScope(s)}
              title={
                s === "ship"
                  ? "Everyone aboard sees it"
                  : s === "announce"
                    ? "Banner + chime for everyone aboard — the megaphone"
                    : off
                      ? "Enter a zone to chat with just that room"
                      : "Only your current zone sees it"
              }
              style={{
                flex: 1,
                height: 28,
                borderRadius: 8,
                border: `1px solid ${selected ? "var(--accent-dim)" : "rgba(255,255,255,.14)"}`,
                background: selected ? "var(--accent-faint)" : "rgba(255,255,255,.05)",
                color: selected ? "var(--accent)" : "var(--text-dim)",
                font: "600 8.5px var(--font-mono)",
                letterSpacing: "0.14em",
                cursor: off ? "default" : "pointer",
                opacity: off ? 0.4 : 1,
                transition: "all .18s",
              }}
            >
              {s === "ship" ? "SHIP" : s === "zone" ? "ZONE" : "ALL HANDS"}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={draft}
          maxLength={CHAT_MAX_LEN}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendDraft();
            }
          }}
          placeholder={
            effectiveScope === "ship"
              ? "Message the whole ship…"
              : effectiveScope === "announce"
                ? "Announce to all hands…"
                : "Message this zone…"
          }
          style={{
            flex: 1,
            minWidth: 0,
            height: 34,
            padding: "0 10px",
            borderRadius: 9,
            border: "1px solid rgba(120,150,200,.22)",
            background: "rgba(255,255,255,.04)",
            color: "var(--text)",
            fontSize: 12.5,
            outline: "none",
          }}
        />
        <button
          className="hud-media-btn"
          disabled={draft.trim() === ""}
          onClick={sendDraft}
          title="Send"
          style={{
            flex: "none",
            height: 34,
            padding: "0 12px",
            borderRadius: 9,
            border: `1px solid ${draft.trim() === "" ? "rgba(255,255,255,.14)" : "var(--accent-dim)"}`,
            background: draft.trim() === "" ? "rgba(255,255,255,.05)" : "var(--accent-faint)",
            color: draft.trim() === "" ? "var(--text-dim)" : "var(--accent)",
            font: "600 9.5px var(--font-mono)",
            letterSpacing: "0.12em",
            cursor: draft.trim() === "" ? "default" : "pointer",
            transition: "all .18s",
          }}
        >
          SEND
        </button>
      </div>
      <div style={scopeLabelStyle as CSSProperties}>
        {/* what the picked scope will actually do, spelled out */}
        {effectiveScope === "ship"
          ? "VISIBLE TO EVERYONE ABOARD"
          : effectiveScope === "announce"
            ? "BANNER + CHIME FOR EVERYONE ABOARD"
            : "VISIBLE TO YOUR ZONE ONLY"}
      </div>
    </div>
  );
}
