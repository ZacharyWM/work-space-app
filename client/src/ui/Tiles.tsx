// zone video tiles (step 3.5): top-center row — self first (label "You", own
// stream muted playback), then co-zone occupants in join order. geometry and
// colors copied from the prototype's tile markup; speaking lights the border
// and dot in accent (step 3.6). minimal beyond that until the 4.3 styling pass.
import { useEffect, useRef, type CSSProperties } from "react";
import type { PeerManager } from "../media/peerManager";
import type { Connection } from "../net/connection";

export function Tiles(props: {
  conn: Connection;
  peers: PeerManager;
  // local stream for the self tile; remote streams come from the peer manager
  localStream: MediaStream;
  zoneId: string | null;
}) {
  const { conn, peers, zoneId } = props;
  // open space renders none — connections don't exist there by construction
  if (zoneId === null) return null;
  const self = conn.roster.get(conn.selfId!);
  // roster Map preserves server insertion order = join order (1.4 roster tests)
  const occupants = [...conn.roster.values()].filter(
    (p) => p.id !== conn.selfId && p.zoneId === zoneId,
  );
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        alignItems: "flex-start",
        justifyContent: "center",
        maxWidth: "72vw",
        zIndex: 20,
      }}
    >
      {self && (
        <Tile
          label="You"
          name={self.name}
          camOn={self.camOn}
          micOn={self.micOn}
          speaking={self.speaking}
          screenOn={self.screenOn}
          // parked alone (3.1) the stream holds no camera track: take the
          // placeholder path instead of a black surface; App rerenders when
          // the track lands
          stream={props.localStream.getVideoTracks().length > 0 ? props.localStream : undefined}
        />
      )}
      {occupants.map((p) => (
        <Tile
          key={p.id}
          label={p.name}
          name={p.name}
          camOn={p.camOn}
          micOn={p.micOn}
          speaking={p.speaking}
          screenOn={p.screenOn}
          stream={peers.remoteStreams.get(p.id)}
        />
      ))}
    </div>
  );
}

// colors/fonts come from the :root CSS variables applyTheme() set (step 4.1)
const tileFont = "var(--font-mono)";

function Tile(props: {
  label: string;
  name: string;
  camOn: boolean;
  micOn: boolean;
  speaking: boolean;
  // sharing their screen — badge only here; the meeting view shows it (notes/003)
  screenOn: boolean;
  // undefined while a remote pair is still connecting — initials placeholder meanwhile
  stream: MediaStream | undefined;
}) {
  // prototype initials rule
  const initials = (props.name || "YO").slice(0, 2).toUpperCase();
  return (
    <div
      style={{
        width: 150,
        borderRadius: 11,
        overflow: "hidden",
        // speaking lights the border and footer dot in accent (prototype rule)
        border: `1.5px solid ${props.speaking ? "var(--accent)" : "rgba(255,255,255,.10)"}`,
        background: "var(--tile-bg)",
        boxShadow: "0 10px 30px rgba(0,0,0,.5)",
        color: "var(--text)",
        // prototype entrance + speaking-border ease (step 4.3)
        animation: "tilein .3s ease",
        transition: "border-color .25s",
      }}
    >
      <div style={{ position: "relative", height: 94, overflow: "hidden" }}>
        {props.camOn && props.stream ? (
          <VideoSurface stream={props.stream} />
        ) : (
          // cam off (or stream not yet arrived): initials, plus CAM OFF only when off
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--tile-placeholder-bg)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: "50%",
                background: "rgba(255,255,255,.06)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                font: "600 14px var(--font-sans)",
                color: "rgba(200,215,235,.7)",
              }}
            >
              {initials}
            </div>
            {!props.camOn && (
              <div
                style={{
                  font: `500 9px ${tileFont}`,
                  letterSpacing: "0.16em",
                  color: "var(--text-dim)",
                }}
              >
                CAM OFF
              </div>
            )}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 9px",
          background: "var(--tile-bg)",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flex: "none",
            background: props.speaking ? "var(--accent)" : "rgba(255,255,255,.22)",
            transition: "background .2s",
          }}
        />
        <span
          style={{
            font: "500 11.5px var(--font-sans)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {props.label}
        </span>
        {(props.screenOn || !props.micOn) && (
          <span style={{ marginLeft: "auto", flex: "none", display: "flex", gap: 4 }}>
            {props.screenOn && (
              <span style={badgeStyle("var(--accent)", "var(--accent-faint)")}>SHARING</span>
            )}
            {!props.micOn && (
              <span style={badgeStyle("var(--danger)", "rgba(255,77,77,.12)")}>MUTED</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// tile footer badge (MUTED / SHARING)
function badgeStyle(color: string, background: string): CSSProperties {
  return {
    font: `600 8.5px ${tileFont}`,
    letterSpacing: "0.1em",
    color,
    background,
    padding: "2px 5px",
    borderRadius: 4,
  };
}

const videoStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
};

// always muted: remote audio plays through the peer manager's hidden Audio
// element (3.4) and the self tile must not feed back — tiles are video-only.
// exported for the meeting view; screens render contained, cameras cropped
export function VideoSurface(props: { stream: MediaStream; fit?: "cover" | "contain" }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    ref.current!.srcObject = props.stream;
  }, [props.stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      style={{ ...videoStyle, objectFit: props.fit ?? "cover" }}
    />
  );
}
