// meeting mode (notes/003): full-view overlay that swaps the ship canvas for
// the zone's cameras; an active screen share takes the main stage and the
// cameras collapse into a side strip. camera tiles size like Zoom's gallery:
// a solver picks the grid that maximizes tile area for the headcount, and any
// tile can be pinned to the stage (local-only, share wins over pin). pure
// client view state — the server knows nothing of meeting mode, and the
// bottom toolbar (z 30) stays on top.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Player } from "shared";
import type { PeerManager } from "../media/peerManager";
import type { Connection } from "../net/connection";
import { VideoSurface } from "./Tiles";

export function MeetingView(props: {
  conn: Connection;
  peers: PeerManager;
  // local camera stream for the self tile
  localStream: MediaStream;
  // local display capture while self shares (LocalScreen.stream), else null
  localScreen: MediaStream | null;
  zoneId: string;
  onClose: () => void;
}) {
  const { conn, peers, zoneId } = props;
  const selfId = conn.selfId!;
  const self = conn.roster.get(selfId);
  // self first, then co-zone occupants in join order (the Tiles row order)
  const others = [...conn.roster.values()].filter(
    (p) => p.id !== selfId && p.zoneId === zoneId,
  );
  const occupants = self ? [self, ...others] : others;
  // pin (Zoom-style, local-only): the pinned camera takes the stage; an active
  // screen share outranks it, and the pin resumes when the share ends
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const pinned = occupants.find((p) => p.id === pinnedId);
  // drop the pin when its owner leaves the zone, so it can't resurrect later
  useEffect(() => {
    if (pinnedId !== null && pinned === undefined) setPinnedId(null);
  }, [pinnedId, pinned]);
  // presenter = first sharer in roster (join) order, so every client shows the
  // same screen when a race produces two (decision 4)
  const sharer = [...conn.roster.values()].find(
    (p) => p.zoneId === zoneId && p.screenOn,
  );
  const screenStream =
    sharer === undefined
      ? undefined
      : sharer.id === selfId
        ? (props.localScreen ?? undefined)
        : peers.remoteScreens.get(sharer.id);
  const zoneName = conn.map?.zones.find((z) => z.id === zoneId)?.name ?? zoneId;
  // opening the meeting view alone un-parks the camera asynchronously (3.1):
  // until the track lands the stream is empty — show the placeholder, not a
  // black surface; App rerenders when the track arrives
  const localCam =
    props.localStream.getVideoTracks().length > 0
      ? props.localStream
      : undefined;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // above the tiles row (20) and legend, below the toolbar (30) and toasts (25)
        zIndex: 22,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        // solid backdrop: the canvas keeps animating underneath, unseen
        background:
          "radial-gradient(ellipse at 50% 30%, rgba(13,20,38,1), var(--bg))",
        // bottom padding clears the floating toolbar
        padding: "14px 18px 84px",
      }}
    >
      {/* header: where you are + the way back to the ship */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            font: "600 12.5px var(--font-mono)",
            letterSpacing: "0.2em",
          }}
        >
          MEETING{" "}
          <span style={{ color: "var(--accent)" }}>
            · {zoneName.toUpperCase()}
          </span>
          <span style={{ color: "rgba(160,180,210,.45)" }}>
            {" "}
            · {occupants.length} PRESENT
          </span>
        </div>
        <button
          className="hud-media-btn"
          onClick={props.onClose}
          title="Back to the ship view"
          style={{
            marginLeft: "auto",
            height: 34,
            padding: "0 13px",
            borderRadius: 9,
            border: "1px solid rgba(255,255,255,.16)",
            background: "rgba(255,255,255,.06)",
            color: "var(--text)",
            font: "600 10.5px var(--font-mono)",
            letterSpacing: "0.1em",
            cursor: "pointer",
            transition: "all .18s",
          }}
        >
          SHIP VIEW
        </button>
      </div>

      {sharer || pinned ? (
        // stage layout: screen share (or the pinned camera) + strip on the right
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12 }}>
          {sharer ? (
            <ScreenStage
              sharer={sharer}
              selfId={selfId}
              screenStream={screenStream}
            />
          ) : (
            // pinned camera on the stage; unpin returns to the gallery grid
            <MeetingTile
              p={pinned!}
              you={pinned!.id === selfId}
              stream={
                pinned!.id === selfId
                  ? localCam
                  : peers.remoteStreams.get(pinned!.id)
              }
              fill
              pin={{ pinned: true, onToggle: () => setPinnedId(null) }}
            />
          )}
          <div
            style={{
              width: 180,
              flex: "none",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              overflowY: "auto",
            }}
          >
            {/* share strip keeps everyone (no pins while a share owns the stage);
                pin strip lists everyone but the pinned occupant */}
            {(sharer
              ? occupants
              : occupants.filter((p) => p.id !== pinned!.id)
            ).map((p) => (
              <MeetingTile
                key={p.id}
                p={p}
                you={p.id === selfId}
                stream={
                  p.id === selfId ? localCam : peers.remoteStreams.get(p.id)
                }
                pin={
                  sharer
                    ? undefined
                    : { pinned: false, onToggle: () => setPinnedId(p.id) }
                }
              />
            ))}
          </div>
        </div>
      ) : (
        // no share, no pin: Zoom-style gallery — tiles grow to fill the space,
        // shrinking as the headcount rises
        <CameraGrid
          occupants={occupants}
          selfId={selfId}
          localCam={localCam}
          peers={peers}
          onPin={setPinnedId}
        />
      )}
    </div>
  );
}

// the screen-share stage (unchanged layout, extracted so the stage slot can
// also host a pinned camera)
function ScreenStage(props: {
  sharer: Player;
  selfId: string;
  screenStream: MediaStream | undefined;
}) {
  const { sharer, screenStream } = props;
  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        borderRadius: 12,
        overflow: "hidden",
        background: "#04060c",
        border: "1px solid rgba(120,150,200,.16)",
      }}
    >
      {screenStream ? (
        <VideoSurface stream={screenStream} fit="contain" />
      ) : (
        // flag arrived before the track (pair still connecting)
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            font: "600 11px var(--font-mono)",
            letterSpacing: "0.2em",
            color: "var(--text-dim)",
          }}
        >
          CONNECTING SCREEN…
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 10,
          bottom: 10,
          padding: "5px 10px",
          borderRadius: 7,
          background: "rgba(5,8,15,.75)",
          border: "1px solid var(--accent-dim)",
          font: "600 10px var(--font-mono)",
          letterSpacing: "0.14em",
          color: "var(--accent)",
        }}
      >
        {props.sharer.id === props.selfId ? "YOU" : sharer.name.toUpperCase()} ·
        SHARING
      </div>
    </div>
  );
}

// Zoom-style gallery: measure the container, then for every possible column
// count compute the largest 16/10 tile that fits the resulting rows, and keep
// the best. tiles therefore fill the space and shrink as people join.
function CameraGrid(props: {
  occupants: Player[];
  selfId: string;
  localCam: MediaStream | undefined;
  peers: PeerManager;
  onPin: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // measure before first paint, then track resizes (window or panel changes)
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = props.occupants.length;
  const GAP = 14;
  const ASPECT = 16 / 10; // matches the tile aspect below
  // fallback covers the single pre-measure frame
  let tileW = 230;
  if (size !== null && n > 0) {
    let best = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      // width allowed by columns vs. width implied by the row-height budget
      const byWidth = (size.w - GAP * (cols - 1)) / cols;
      const byHeight = ((size.h - GAP * (rows - 1)) / rows) * ASPECT;
      best = Math.max(best, Math.min(byWidth, byHeight));
    }
    // floor keeps tiles legible in degenerate windows (clipped, not scrolled)
    tileW = Math.max(90, Math.floor(best));
  }
  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexWrap: "wrap",
        gap: GAP,
        alignItems: "center",
        justifyContent: "center",
        alignContent: "center",
        overflow: "hidden",
      }}
    >
      {props.occupants.map((p) => (
        <MeetingTile
          key={p.id}
          p={p}
          you={p.id === props.selfId}
          stream={
            p.id === props.selfId
              ? props.localCam
              : props.peers.remoteStreams.get(p.id)
          }
          width={tileW}
          pin={{ pinned: false, onToggle: () => props.onPin(p.id) }}
        />
      ))}
    </div>
  );
}

// one camera tile: gallery cells pass an explicit width from the solver, the
// strip sizes by its 180px container, and fill stretches it across the stage
// (pinned). pin, when given, renders the hover PIN / UNPIN control.
function MeetingTile(props: {
  p: Player;
  you: boolean;
  stream: MediaStream | undefined;
  width?: number;
  fill?: boolean;
  pin?: { pinned: boolean; onToggle: () => void };
}) {
  const { p } = props;
  const initials = (p.name || "YO").slice(0, 2).toUpperCase();
  return (
    <div
      style={{
        position: "relative",
        // stage fills the flex row; everything else keeps the fixed aspect
        ...(props.fill
          ? { flex: 1, minWidth: 0, alignSelf: "stretch" }
          : { aspectRatio: "16 / 10", width: props.width, flex: "none" }),
        borderRadius: 12,
        overflow: "hidden",
        // speaking lights the border, same rule as the Tiles row
        border: `1.5px solid ${p.speaking ? "var(--accent)" : "rgba(255,255,255,.10)"}`,
        background: "var(--tile-placeholder-bg)",
        boxShadow: "0 10px 30px rgba(0,0,0,.5)",
        animation: "tilein .3s ease",
        transition: "border-color .25s",
      }}
    >
      {p.camOn && props.stream ? (
        // the stage letterboxes (no face crop at that size); tiles crop-fill
        <VideoSurface
          stream={props.stream}
          fit={props.fill ? "contain" : "cover"}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            gap: 7,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "rgba(255,255,255,.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              font: "600 15px var(--font-sans)",
              color: "rgba(200,215,235,.7)",
            }}
          >
            {initials}
          </div>
          {!p.camOn && (
            <div
              style={{
                font: "500 9px var(--font-mono)",
                letterSpacing: "0.16em",
                color: "var(--text-dim)",
              }}
            >
              CAM OFF
            </div>
          )}
        </div>
      )}
      {/* pin control: hover-revealed (styles.css), always visible while pinned */}
      {props.pin && (
        <button
          className={"meeting-pin-btn" + (props.pin.pinned ? " pinned" : "")}
          onClick={props.pin.onToggle}
          title={props.pin.pinned ? "Unpin this video" : "Pin this video"}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            height: 26,
            padding: "0 9px",
            borderRadius: 7,
            border: "1px solid rgba(255,255,255,.18)",
            background: "rgba(5,8,15,.72)",
            color: "var(--text)",
            font: "600 9px var(--font-mono)",
            letterSpacing: "0.12em",
            cursor: "pointer",
          }}
        >
          {props.pin.pinned ? "UNPIN" : "PIN"}
        </button>
      )}
      {/* footer overlay: speaking dot, name, muted marker */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "14px 9px 6px",
          background: "linear-gradient(transparent, rgba(4,6,12,.85))",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flex: "none",
            background: p.speaking ? "var(--accent)" : "rgba(255,255,255,.22)",
            transition: "background .2s",
          }}
        />
        <span
          style={{
            font: "500 11.5px var(--font-sans)",
            color: "var(--text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {props.you ? "You" : p.name}
        </span>
        {!p.micOn && (
          <span
            style={{
              marginLeft: "auto",
              flex: "none",
              font: "600 8.5px var(--font-mono)",
              letterSpacing: "0.1em",
              color: "var(--danger)",
              background: "rgba(255,77,77,.25)",
              padding: "2px 5px",
              borderRadius: 4,
            }}
          >
            MUTED
          </span>
        )}
      </div>
    </div>
  );
}
