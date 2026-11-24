// space link overlay (workspace linking): opened by pressing E at the portal.
// Always shows the HOME workspace's Links (Q5) — at home a linked row offers
// VISIT, while visiting the same list plus RETURN HOME. Management —
// requesting, accepting, denying, removing, blocking — shows only to home's
// creator, and only at home; the server enforces the same rule.
import { useState, type CSSProperties, type FormEvent } from "react";
import type { ClientMessage, SpaceLinkState, WorkspaceInfo } from "shared";

// how many Links one workspace may hold (server maxLinksPerWorkspace)
const LINK_CAP = 10;

const sectionLabelStyle: CSSProperties = {
  font: "600 9.5px var(--font-mono)",
  letterSpacing: "0.2em",
  color: "rgba(160,180,210,.55)",
  marginTop: 6,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 8px",
  borderRadius: 9,
  background: "rgba(255,255,255,.03)",
};

const nameStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  font: "500 12.5px var(--font-sans)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// small mono action button; tone picks the accent (go), neutral, or danger look
function actionStyle(tone: "go" | "idle" | "danger"): CSSProperties {
  return {
    flex: "none",
    height: 26,
    padding: "0 9px",
    borderRadius: 7,
    border: `1px solid ${
      tone === "go"
        ? "var(--accent-dim)"
        : tone === "danger"
          ? "rgba(255,77,77,.5)"
          : "rgba(255,255,255,.14)"
    }`,
    background: tone === "go" ? "var(--accent-faint)" : "rgba(255,255,255,.05)",
    color:
      tone === "go"
        ? "var(--accent)"
        : tone === "danger"
          ? "var(--danger)"
          : "var(--text-dim)",
    font: "600 8.5px var(--font-mono)",
    letterSpacing: "0.1em",
    cursor: "pointer",
    transition: "all .18s",
  };
}

export function SpaceLinkPanel(props: {
  state: SpaceLinkState;
  // slug of the room this session stands in (VISIT is moot for it)
  currentSlug: string;
  error: string | null;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}) {
  const { state } = props;
  // standing at home ⇔ the current room is the home workspace
  const atHome = props.currentSlug === state.home.slug;
  // management shows only to home's creator, and only at home (Q3/Q5)
  const managing = state.creator && atHome;
  // two-click confirms for the destructive rows, keyed "verb:slug"
  const [armed, setArmed] = useState<string | null>(null);
  // request-a-link form
  const [requestName, setRequestName] = useState("");

  // a destructive row action: first click arms (SURE?), the second sends
  function confirmThen(key: string, fire: () => void): void {
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setArmed(null);
    fire();
  }

  function submitRequest(e: FormEvent): void {
    e.preventDefault();
    const name = requestName.trim();
    if (name === "") return;
    props.send({ type: "linkRequest", name });
    setRequestName("");
  }

  // a linked row: VISIT for everyone; UNLINK + BLOCK for the managing creator
  function linkRow(w: WorkspaceInfo) {
    const here = w.slug === props.currentSlug;
    return (
      <div key={w.slug} style={rowStyle}>
        <div style={nameStyle}>{w.name}</div>
        {here ? (
          <span style={{ ...sectionLabelStyle, marginTop: 0, flex: "none" }}>HERE</span>
        ) : (
          <button
            className="hud-media-btn"
            style={actionStyle("go")}
            onClick={() => props.send({ type: "visit", slug: w.slug })}
            title={`Visit ${w.name}`}
          >
            VISIT
          </button>
        )}
        {managing && (
          <button
            className="hud-media-btn"
            style={actionStyle(armed === `unlink:${w.slug}` ? "danger" : "idle")}
            onClick={() =>
              confirmThen(`unlink:${w.slug}`, () =>
                props.send({ type: "linkRemove", slug: w.slug }),
              )
            }
            title="Remove this link — visitors on both sides are sent home"
          >
            {armed === `unlink:${w.slug}` ? "SURE?" : "UNLINK"}
          </button>
        )}
        {managing && (
          <button
            className="hud-media-btn"
            style={actionStyle(armed === `block:${w.slug}` ? "danger" : "idle")}
            onClick={() =>
              confirmThen(`block:${w.slug}`, () =>
                props.send({ type: "linkBlock", name: w.slug }),
              )
            }
            title="Block this workspace — removes the link and refuses future requests"
          >
            {armed === `block:${w.slug}` ? "SURE?" : "BLOCK"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={props.onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 45,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(3,5,10,.6)",
        backdropFilter: "blur(2px)",
      }}
    >
      {/* clicks inside the card must not reach the backdrop's close */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 400,
          maxWidth: "calc(100vw - 40px)",
          maxHeight: "min(72vh, 620px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 20,
          borderRadius: 16,
          background: "var(--card-bg)",
          border: "1px solid rgba(138,125,255,.35)",
          boxShadow: "0 0 40px rgba(138,125,255,.12), 0 30px 80px rgba(0,0,0,.6)",
          animation: "tilein .3s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div
            style={{
              font: "600 10.5px var(--font-mono)",
              letterSpacing: "0.2em",
              color: "rgba(138,125,255,.9)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            SPACE LINK · {state.home.name.toUpperCase()}
          </div>
          <button
            type="button"
            className="hud-zoom-btn"
            onClick={props.onClose}
            title="Close"
            style={{
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
        {/* while visiting: where you are, and the way back (Q5) */}
        {!atHome && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 12px",
              borderRadius: 10,
              border: "1px solid rgba(138,125,255,.35)",
              background: "rgba(138,125,255,.08)",
            }}
          >
            <div
              style={{
                ...nameStyle,
                font: "600 10px var(--font-mono)",
                letterSpacing: "0.12em",
                color: "rgba(138,125,255,.9)",
              }}
            >
              YOU ARE VISITING
            </div>
            <button
              className="hud-media-btn"
              style={actionStyle("go")}
              onClick={() => props.send({ type: "visit", slug: state.home.slug })}
              title={`Return to ${state.home.name}`}
            >
              RETURN HOME
            </button>
          </div>
        )}
        {props.error && (
          <div
            style={{
              font: "600 10px var(--font-mono)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--danger)",
            }}
          >
            {props.error}
          </div>
        )}
        {/* the home workspace's links — the only workspaces reachable (Q5) */}
        <div style={sectionLabelStyle}>
          LINKED WORKSPACES · {state.links.length}/{LINK_CAP}
        </div>
        {state.links.length === 0 && (
          <div style={{ font: "500 11px var(--font-sans)", color: "var(--text-dim)" }}>
            {managing
              ? "No links yet — request one below."
              : "No links yet — your workspace's creator can request one here."}
          </div>
        )}
        {state.links.map(linkRow)}
        {managing && (
          <>
            {state.inbound.length > 0 && (
              <>
                <div style={sectionLabelStyle}>LINK REQUESTS</div>
                {state.inbound.map((w) => (
                  <div key={w.slug} style={rowStyle}>
                    <div style={nameStyle}>{w.name}</div>
                    <button
                      className="hud-media-btn"
                      style={actionStyle("go")}
                      onClick={() => props.send({ type: "linkAccept", slug: w.slug })}
                      title={`Link with ${w.name} — everyone aboard either side may visit the other`}
                    >
                      ACCEPT
                    </button>
                    <button
                      className="hud-media-btn"
                      style={actionStyle("idle")}
                      onClick={() => props.send({ type: "linkDeny", slug: w.slug })}
                      title="Deny this request"
                    >
                      DENY
                    </button>
                    <button
                      className="hud-media-btn"
                      style={actionStyle(armed === `block:${w.slug}` ? "danger" : "idle")}
                      onClick={() =>
                        confirmThen(`block:${w.slug}`, () =>
                          props.send({ type: "linkBlock", name: w.slug }),
                        )
                      }
                      title="Block this workspace — refuses this and future requests"
                    >
                      {armed === `block:${w.slug}` ? "SURE?" : "BLOCK"}
                    </button>
                  </div>
                ))}
              </>
            )}
            {state.outbound.length > 0 && (
              <>
                <div style={sectionLabelStyle}>SENT REQUESTS</div>
                {state.outbound.map((w) => (
                  <div key={w.slug} style={rowStyle}>
                    <div style={nameStyle}>{w.name}</div>
                    <span style={{ ...sectionLabelStyle, marginTop: 0, flex: "none" }}>
                      PENDING
                    </span>
                    <button
                      className="hud-media-btn"
                      style={actionStyle("idle")}
                      onClick={() => props.send({ type: "linkCancel", slug: w.slug })}
                      title="Withdraw this request"
                    >
                      CANCEL
                    </button>
                  </div>
                ))}
              </>
            )}
            {state.blocks.length > 0 && (
              <>
                <div style={sectionLabelStyle}>BLOCKED</div>
                {state.blocks.map((w) => (
                  <div key={w.slug} style={rowStyle}>
                    <div style={nameStyle}>{w.name}</div>
                    <button
                      className="hud-media-btn"
                      style={actionStyle("idle")}
                      onClick={() => props.send({ type: "linkUnblock", slug: w.slug })}
                      title="Lift the block — restores nothing on its own"
                    >
                      UNBLOCK
                    </button>
                  </div>
                ))}
              </>
            )}
            {/* petition by typed name, resolved like workspace creation (Q9) */}
            <div style={sectionLabelStyle}>REQUEST A LINK</div>
            <form onSubmit={submitRequest} style={{ display: "flex", gap: 6 }}>
              <input
                value={requestName}
                onChange={(e) => setRequestName(e.target.value)}
                maxLength={40}
                placeholder="Workspace name"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 34,
                  padding: "0 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(120,150,200,.22)",
                  background: "rgba(255,255,255,.04)",
                  color: "var(--text)",
                  fontSize: 12.5,
                  outline: "none",
                }}
              />
              <button
                type="submit"
                disabled={requestName.trim() === ""}
                style={{
                  ...actionStyle("go"),
                  height: 34,
                  cursor: requestName.trim() === "" ? "default" : "pointer",
                }}
              >
                REQUEST
              </button>
            </form>
          </>
        )}
        {/* the ground rules, one quiet line */}
        <div
          style={{
            marginTop: 4,
            font: "500 10px var(--font-sans)",
            lineHeight: 1.5,
            color: "var(--text-dim)",
          }}
        >
          Visits are temporary: exiting, refreshing, or logging out lands you back
          home. Nothing you do while visiting persists except game scores.
        </div>
      </div>
    </div>
  );
}
