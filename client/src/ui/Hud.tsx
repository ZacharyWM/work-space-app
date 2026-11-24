// zone hud: ship legend, bottom toolbar, zone toasts, open-space pill (step 2.3).
// fonts/colors/spacings copied from the prototype markup (step 4.3 styling pass);
// colors and fonts flow through the :root CSS variables applyTheme() set (step 4.1).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Emote, PlayerStatus } from "shared";
import type { LocalMedia, MediaToggles } from "../media/localMedia";
import { LocalScreen } from "../media/localScreen";
import { EMOTE_GLYPH } from "../render/draw";
import type { Connection } from "../net/connection";
import { ChatPanel } from "./ChatPanel";
import { CrewLocker } from "./CrewLocker";
import { CrewPanel, STATUS_COLOR } from "./CrewPanel";
import { DeviceMenu } from "./DeviceMenu";

// prototype toast timings
const ENTER_TOAST_MS = 2200;
const LEAVE_TOAST_MS = 2000;
// flight transition toasts (prototype boardShip/dock, notes/003)
const LAUNCH_TOAST_MS = 3200;
const DOCK_TOAST_MS = 2400;
// a launch/dock also flips the zone moments later (server echo); zone flips
// this close to a flight transition are that transition, not a walk
const FLIGHT_ZONE_SUPPRESS_MS = 1500;

// shared geometry for the floating, horizontally-centered hud surfaces
const centered: CSSProperties = {
  position: "fixed",
  left: "50%",
  transform: "translateX(-50%)",
  whiteSpace: "nowrap",
};

// toolbar mic/cam button, colored by device state (prototype on/off palettes)
function mediaButtonStyle(on: boolean): CSSProperties {
  return {
    height: 44,
    minWidth: 96,
    padding: "0 13px",
    borderRadius: 10,
    border: `1px solid ${on ? "rgba(255,255,255,.16)" : "rgba(255,77,77,.55)"}`,
    background: on ? "rgba(255,255,255,.06)" : "rgba(255,77,77,.14)",
    color: on ? "var(--text)" : "var(--danger)",
    font: "600 11.5px var(--font-mono)",
    letterSpacing: "0.08em",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    transition: "all .18s",
  };
}

// the state dot inside a mic/cam button
function mediaDotStyle(on: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flex: "none",
    background: on ? "var(--dot-on)" : "var(--dot-off)",
  };
}

// SHARE/MEETING buttons: neutral when idle, accent while active, dimmed when
// unavailable (outside a zone, or someone else is presenting) (notes/003)
function zoneButtonStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    height: 44,
    padding: "0 13px",
    borderRadius: 10,
    border: `1px solid ${active ? "var(--accent-dim)" : "rgba(255,255,255,.16)"}`,
    background: active ? "var(--accent-faint)" : "rgba(255,255,255,.06)",
    color: active ? "var(--accent)" : "var(--text)",
    font: "600 11.5px var(--font-mono)",
    letterSpacing: "0.08em",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "all .18s",
  };
}

const zoomButtonStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,.14)",
  background: "rgba(255,255,255,.05)",
  color: "var(--text)",
  font: "600 17px var(--font-sans)",
  cursor: "pointer",
};

const dividerStyle: CSSProperties = {
  width: 1,
  height: 30,
  background: "rgba(120,150,200,.18)",
  flex: "none",
};

// the emote strip in picker + shortcut order (1-6, matching the stage) (notes/010)
const EMOTES: Emote[] = ["thumbsUp", "heart", "laugh", "party", "wave", "question"];

export function Hud(props: {
  conn: Connection;
  media: LocalMedia;
  zoneId: string | null;
  // true while piloting a shuttle — swaps the legend/pill/zone texts (notes/003)
  flying: boolean;
  // true while racing a shuttle — takes precedence over the flying texts
  racing: boolean;
  // true while fighting a blasters match — same precedence as racing
  blasting: boolean;
  // screen share + meeting mode, owned by App (notes/003)
  sharing: boolean;
  // someone else in the zone is already presenting — SHARE locks out
  shareLocked: boolean;
  onToggleShare: () => void;
  meeting: boolean;
  onToggleMeeting: () => void;
  // own presence status + setter, owned by App (notes/004)
  status: PlayerStatus;
  onSetStatus: (status: PlayerStatus) => void;
  // flash an emote above own avatar (notes/010)
  onEmote: (emote: Emote) => void;
  // light the canvas guide line toward a crewmate (notes/010)
  onLocate: (id: string) => void;
  // clerk user id — pod ownership is account-level, not session-level (notes/009)
  selfUserId: string;
  // true while this session is a Visitor (space link feature): pods and decor
  // hide (no persistent footprint, Q6) and the legend flags the visit
  visiting: boolean;
  // creator-only ban of a visitor from the crew panel (Q7)
  onBanVisitor: (userId: string) => void;
  // pod claim/release, owned by App (notes/009)
  // decor tray toggle: anyone aboard may build (notes/017)
  decorOpen: boolean;
  onToggleDecor: () => void;
  // workspace creator: opens the map editor overlay (notes/010 map editor)
  owner: boolean;
  onOpenEditor: () => void;
  onClaimPod: (zoneId: string) => void;
  onReleasePod: () => void;
  // self mic/cam flipped — App rerenders the tiles off the updated roster (step 3.5)
  onMediaChanged: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  // snap the camera back onto the player after a drag-pan
  onRecenter: () => void;
  onExit: () => void;
}) {
  const { conn, media, zoneId, flying } = props;
  // mounted only after welcome, so selfId + self roster entry exist
  const self = conn.roster.get(conn.selfId!);
  // the user's toggles, read straight off the media manager each render — App
  // rerenders the hud on every flip, including gate-driven fallbacks (step 3.1)
  const { micOn, camOn } = media.state;
  // apply a toggle flip: tell the room, keep the self roster entry truthful, rerender
  function applyToggles(next: MediaToggles): void {
    conn.send({ type: "mediaState", ...next });
    if (self) {
      self.micOn = next.micOn;
      self.camOn = next.camOn;
    }
    props.onMediaChanged();
  }
  // an on-flip re-acquires the device (async); drop clicks while a flip is in flight
  const camBusyRef = useRef(false);
  async function toggleCam(): Promise<void> {
    if (camBusyRef.current) return;
    camBusyRef.current = true;
    try {
      applyToggles(await media.setCamOn(!camOn));
    } finally {
      camBusyRef.current = false;
    }
  }
  const micBusyRef = useRef(false);
  async function toggleMic(): Promise<void> {
    if (micBusyRef.current) return;
    micBusyRef.current = true;
    try {
      applyToggles(await media.setMicOn(!micOn));
    } finally {
      micBusyRef.current = false;
    }
  }
  // SHARE needs a zone, a capable browser, and no other presenter (notes/003)
  const shareDisabled =
    zoneId === null || !LocalScreen.supported() || (props.shareLocked && !props.sharing);
  // game transitions ride the flight toast path: boarding the race grid or
  // the arena shows the launch toast and suppresses the zone-exit flip,
  // like a pad launch
  const toast = useZoneToast(conn, zoneId, flying || props.racing || props.blasting);
  // crew locker modal, opened from the SUIT button (notes/002)
  const [lockerOpen, setLockerOpen] = useState(false);
  // rerender trigger: the toolbar shows self.name, which a locker rename
  // mutates in place on the roster (notes/005)
  const [, setNameVersion] = useState(0);
  // crew panel (statuses + waves), open by default on join, toggled by the CREW button (notes/004)
  const [crewOpen, setCrewOpen] = useState(true);
  // emote strip (notes/010): a small picker above the toolbar; picking closes it
  const [reactOpen, setReactOpen] = useState(false);
  // chat panel (notes/010): open state + how many messages were on the log
  // when it was last open — the difference is the CHAT badge's unread count
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeen, setChatSeen] = useState(conn.chat.length);
  const chatUnread = conn.chat.length - chatSeen;
  // while the panel is open every arrival counts as read
  useEffect(() => {
    if (chatOpen) setChatSeen(conn.chat.length);
  }, [chatOpen, conn.chat.length]);
  const zone = zoneId === null ? null : (conn.map?.zones.find((z) => z.id === zoneId) ?? null);
  const zoneName = zoneId === null ? null : (zone?.name ?? zoneId);
  // pod context for the toolbar (notes/009): standing in an unclaimed pod
  // offers CLAIM, standing in your own offers RELEASE (armed confirm)
  const podClaim = zone?.pod ? (conn.pods.get(zone.id) ?? null) : null;
  const podMine = podClaim !== null && podClaim.userId === props.selfUserId;
  // one pod per account per workspace — a claim elsewhere disables CLAIM here
  const haveOtherPod = [...conn.pods.values()].some(
    (p) => p.userId === props.selfUserId && p.zoneId !== zone?.id,
  );
  const [releaseArmed, setReleaseArmed] = useState(false);
  // an armed RELEASE disarms itself, and walking out of the pod disarms too
  useEffect(() => {
    if (!releaseArmed) return;
    const t = setTimeout(() => setReleaseArmed(false), 2500);
    return () => clearTimeout(t);
  }, [releaseArmed]);
  useEffect(() => setReleaseArmed(false), [zoneId]);

  return (
    <>
      {/* ship name + controls legend, top left */}
      <div
        style={{
          position: "fixed",
          top: 16,
          left: 18,
          zIndex: 15,
          display: "flex",
          flexDirection: "column",
          gap: 5,
          pointerEvents: "none",
        }}
      >
        {/* workspace name from the welcome labels where you are (notes/006) */}
        <div style={{ font: "600 12.5px var(--font-mono)", letterSpacing: "0.2em" }}>
          BLIP-A{" "}
          <span style={{ color: "rgba(160,180,210,.45)" }}>
            · {conn.workspace?.name.toUpperCase() ?? "DECK 1"}
          </span>
          {/* out on a Visit: say so, in the portal's violet (space link) */}
          {props.visiting && (
            <span style={{ color: "rgba(138,125,255,.85)" }}> · VISITING</span>
          )}
        </div>
        <div
          style={{
            font: "500 10px var(--font-mono)",
            letterSpacing: "0.1em",
            color: "var(--text-dim)",
          }}
        >
          {props.racing
            ? "W — THRUST · A/D — TURN · S — BRAKE · FLY THE GATES IN ORDER"
            : props.blasting
              ? "W — THRUST · A/D — TURN · S — BRAKE · SPACE — FIRE"
              : flying
                ? "W — THRUST · A/D — TURN · S — BRAKE · E — DOCK IN BAY"
                : "WASD / ARROWS — MOVE  ·  SCROLL — ZOOM  ·  DRAG — PAN"}
        </div>
      </div>

      {/* open-space pill, top center, only outside every zone */}
      {zoneId === null && (
        <div
          style={{
            ...centered,
            top: 20,
            zIndex: 18,
            padding: "8px 15px",
            borderRadius: 999,
            background: "rgba(10,15,28,.72)",
            border: "1px solid rgba(120,150,200,.14)",
            font: "500 10px var(--font-mono)",
            letterSpacing: "0.12em",
            color: "rgba(160,180,210,.65)",
          }}
        >
          {props.racing
            ? "SHUTTLE RACE · RACE COMMS OPEN — ONLY RACERS HEAR YOU"
            : props.blasting
              ? "SHUTTLE BLASTERS · MATCH COMMS OPEN — ONLY FIGHTERS HEAR YOU"
              : flying
                ? "IN FLIGHT · COMMS OFFLINE — RETURN TO THE FLIGHT DECK TO DOCK"
                : "OPEN SPACE · COMMS OFFLINE — ENTER A ZONE TO CONNECT"}
        </div>
      )}

      {/* zone transition toast, above the toolbar, auto-dismissed */}
      {toast && (
        <div
          style={{
            ...centered,
            bottom: 92,
            zIndex: 25,
            padding: "9px 16px",
            borderRadius: 10,
            background: "rgba(10,15,28,.92)",
            border: "1px solid var(--accent-dim)",
            color: "var(--accent)",
            font: "600 11px var(--font-mono)",
            letterSpacing: "0.16em",
            animation: "toastin .25s ease",
          }}
        >
          {toast}
        </div>
      )}

      {/* bottom toolbar */}
      <div
        style={{
          ...centered,
          bottom: 18,
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "9px 11px",
          background: "var(--surface-bg)",
          border: "1px solid var(--surface-border)",
          borderRadius: 15,
          backdropFilter: "blur(14px)",
          boxShadow: "0 14px 40px rgba(0,0,0,.5)",
        }}
      >
        <button
          className="hud-media-btn"
          style={mediaButtonStyle(micOn)}
          onClick={() => void toggleMic()}
          title="Toggle microphone"
        >
          <span style={mediaDotStyle(micOn)} />
          MIC {micOn ? "ON" : "OFF"}
        </button>
        <button
          className="hud-media-btn"
          style={mediaButtonStyle(camOn)}
          onClick={() => void toggleCam()}
          title="Toggle camera"
        >
          <span style={mediaDotStyle(camOn)} />
          CAM {camOn ? "ON" : "OFF"}
        </button>
        {/* cam/mic hardware picker, sits with the toggles it configures */}
        <DeviceMenu media={media} />
        {/* screen share + meeting mode, zone-only features (notes/003) */}
        <button
          className="hud-media-btn"
          style={zoneButtonStyle(props.sharing, shareDisabled)}
          disabled={shareDisabled}
          onClick={props.onToggleShare}
          title={
            zoneId === null
              ? "Enter a zone to share your screen"
              : !LocalScreen.supported()
                ? "Screen capture unavailable in this browser"
                : props.shareLocked && !props.sharing
                  ? "Someone else is presenting"
                  : props.sharing
                    ? "Stop sharing your screen"
                    : "Share your screen with this zone"
          }
        >
          {props.sharing ? "SHARING" : "SHARE"}
        </button>
        <button
          className="hud-media-btn"
          style={zoneButtonStyle(props.meeting, zoneId === null)}
          disabled={zoneId === null}
          onClick={props.onToggleMeeting}
          title={
            zoneId === null
              ? "Enter a zone to open the meeting view"
              : props.meeting
                ? "Back to the ship view"
                : "See everyone in this zone"
          }
        >
          MEETING
        </button>
        {/* contextual pod control: CLAIM in an unclaimed pod, armed RELEASE in
            your own; someone else's pod shows nothing — their name is on the
            canvas (notes/009) */}
        {zone?.pod && podClaim === null && !props.visiting && (
          <button
            className="hud-media-btn"
            style={zoneButtonStyle(false, haveOtherPod)}
            disabled={haveOtherPod}
            onClick={() => props.onClaimPod(zone.id)}
            title={
              haveOtherPod
                ? "You already have a pod — release it first"
                : "Claim this pod as yours"
            }
          >
            CLAIM POD
          </button>
        )}
        {podMine && (
          <button
            className="hud-media-btn"
            style={zoneButtonStyle(releaseArmed, false)}
            onClick={() => {
              if (!releaseArmed) {
                setReleaseArmed(true);
                return;
              }
              setReleaseArmed(false);
              props.onReleasePod();
            }}
            title={releaseArmed ? "Click again to release this pod" : "Give up this pod"}
          >
            {releaseArmed ? "SURE?" : "RELEASE POD"}
          </button>
        )}
        <div style={dividerStyle} />
        <div
          style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 6px", minWidth: 130 }}
        >
          <span
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 600, lineHeight: 1.1 }}
          >
            {/* own presence dot, same colors as the canvas pills (notes/004) */}
            <span
              title={`Status: ${props.status}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flex: "none",
                background: STATUS_COLOR[props.status],
                transition: "background .2s",
              }}
            />
            {self?.name}
          </span>
          {/* current zone, shuttle marker in flight, private marker in open space */}
          <span
            style={{
              font: "500 10px var(--font-mono)",
              letterSpacing: "0.12em",
              color: flying || zoneName ? "var(--accent)" : "var(--text-dim)",
              transition: "color .2s",
              whiteSpace: "nowrap",
            }}
          >
            {props.racing
              ? "SHUTTLE RACE · RACING"
              : props.blasting
                ? "SHUTTLE BLASTERS · IN THE FIGHT"
                : flying
                  ? "IN FLIGHT · SHUTTLE"
                  : (zoneName ?? "OPEN SPACE — PRIVATE")}
          </span>
        </div>
        <div style={dividerStyle} />
        {/* chat panel toggle with unread badge (notes/010) */}
        <button
          className="hud-media-btn"
          style={{ ...zoneButtonStyle(chatOpen, false), position: "relative" }}
          onClick={() => setChatOpen((v) => !v)}
          title={chatOpen ? "Close the chat panel" : "Chat with the ship or your zone"}
        >
          CHAT
          {!chatOpen && chatUnread > 0 && (
            <span
              style={{
                position: "absolute",
                top: -5,
                right: -5,
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 8,
                background: "var(--accent)",
                color: "var(--bg)",
                font: "700 9px var(--font-mono)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {chatUnread > 99 ? "99+" : chatUnread}
            </span>
          )}
        </button>
        {/* emote picker toggle (notes/010); keys 1-6 skip the picker */}
        <button
          className="hud-media-btn"
          style={zoneButtonStyle(reactOpen, false)}
          onClick={() => setReactOpen((v) => !v)}
          title={reactOpen ? "Close the emote picker" : "React with an emote (or press 1-6)"}
        >
          REACT
        </button>
        {/* crew panel toggle: statuses + waves (notes/004) */}
        <button
          className="hud-media-btn"
          style={zoneButtonStyle(crewOpen, false)}
          onClick={() => setCrewOpen((v) => !v)}
          title={crewOpen ? "Close the crew panel" : "See who's aboard, set status, wave"}
        >
          CREW
        </button>
        {/* decor tray: the prop library, open to everyone aboard — except
            Visitors, who leave no persistent footprint (notes/017, Q6) */}
        {!props.visiting && (
          <button
            className="hud-media-btn"
            style={zoneButtonStyle(props.decorOpen, false)}
            onClick={props.onToggleDecor}
            title={props.decorOpen ? "Close the decor tray" : "Place desks, plants and props"}
          >
            DECOR
          </button>
        )}
        {/* map editor, workspace creator only (notes/010 map editor) */}
        {props.owner && (
          <button
            className="hud-media-btn"
            style={zoneButtonStyle(false, false)}
            onClick={props.onOpenEditor}
            title="Edit this workspace's layout"
          >
            EDIT MAP
          </button>
        )}
        <button
          className="hud-media-btn"
          style={{
            height: 44,
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid var(--accent-dim)",
            background: "var(--accent-faint)",
            color: "var(--accent)",
            font: "600 11.5px var(--font-mono)",
            letterSpacing: "0.1em",
            cursor: "pointer",
            transition: "all .18s",
          }}
          onClick={() => setLockerOpen(true)}
          title="Customize character"
        >
          SUIT
        </button>
        <button className="hud-zoom-btn" style={zoomButtonStyle} onClick={props.onZoomOut} title="Zoom out">
          −
        </button>
        <button className="hud-zoom-btn" style={zoomButtonStyle} onClick={props.onZoomIn} title="Zoom in">
          +
        </button>
        <button
          className="hud-zoom-btn"
          style={zoomButtonStyle}
          onClick={props.onRecenter}
          title="Re-center on your character"
        >
          ⌖
        </button>
        <div style={dividerStyle} />
        <button
          className="hud-exit-btn"
          style={{
            height: 44,
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid rgba(255,77,77,.4)",
            background: "rgba(255,77,77,.1)",
            color: "var(--danger)",
            font: "600 11.5px var(--font-mono)",
            letterSpacing: "0.1em",
            cursor: "pointer",
            transition: "all .18s",
          }}
          onClick={props.onExit}
          title="Leave ship"
        >
          EXIT
        </button>
      </div>

      {/* emote strip above the toolbar: one click flashes it over the avatar
          and closes the strip; the number hints match the shortcuts (notes/010) */}
      {reactOpen && (
        <div
          style={{
            ...centered,
            bottom: 92,
            zIndex: 30,
            display: "flex",
            gap: 6,
            padding: "8px 10px",
            background: "var(--surface-bg)",
            border: "1px solid var(--surface-border)",
            borderRadius: 12,
            backdropFilter: "blur(14px)",
            boxShadow: "0 14px 40px rgba(0,0,0,.5)",
            animation: "toastin .2s ease",
          }}
        >
          {EMOTES.map((emote, i) => (
            <button
              key={emote}
              className="hud-media-btn"
              onClick={() => {
                props.onEmote(emote);
                setReactOpen(false);
              }}
              title={`React ${EMOTE_GLYPH[emote]} (key ${i + 1})`}
              style={{
                width: 42,
                height: 42,
                borderRadius: 9,
                border: "1px solid rgba(255,255,255,.14)",
                background: "rgba(255,255,255,.05)",
                fontSize: 19,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 0,
                lineHeight: 1,
              }}
            >
              {EMOTE_GLYPH[emote]}
              <span style={{ font: "600 7px var(--font-mono)", color: "var(--text-dim)" }}>{i + 1}</span>
            </button>
          ))}
        </div>
      )}

      {lockerOpen && (
        <CrewLocker
          conn={conn}
          onClose={() => setLockerOpen(false)}
          onRename={() => setNameVersion((v) => v + 1)}
        />
      )}
      {crewOpen && (
        <CrewPanel
          conn={conn}
          status={props.status}
          onSetStatus={props.onSetStatus}
          onLocate={props.onLocate}
          onBanVisitor={props.onBanVisitor}
          onClose={() => setCrewOpen(false)}
        />
      )}
      {chatOpen && <ChatPanel conn={conn} zoneId={zoneId} onClose={() => setChatOpen(false)} />}
    </>
  );
}

// toast on zone transitions: entering any zone (incl. zone→zone) announces it,
// leaving to open space announces comms closed. flight transitions announce
// launch/dock instead, and mute the zone flip the server echoes right after
// (boarding leaves the flight zone, docking re-enters it) — a suppressed rerun
// must not cancel a showing toast, so the timer lives in a ref, not a cleanup
function useZoneToast(conn: Connection, zoneId: string | null, flying: boolean): string | null {
  const [toast, setToast] = useState<string | null>(null);
  // seeded with the mount state so boarding the ship shows no toast
  const prevZone = useRef(zoneId);
  const prevFlying = useRef(flying);
  const flightFlipAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const show = (msg: string, ms: number): void => {
      clearTimeout(timer.current);
      setToast(msg);
      timer.current = setTimeout(() => setToast(null), ms);
    };
    if (flying !== prevFlying.current) {
      prevFlying.current = flying;
      prevZone.current = zoneId;
      flightFlipAt.current = Date.now();
      if (flying) show("LAUNCH CLEAR · W — THRUST · A/D — TURN", LAUNCH_TOAST_MS);
      else show("DOCKED · FLIGHT DECK", DOCK_TOAST_MS);
      return;
    }
    if (zoneId === prevZone.current) return;
    prevZone.current = zoneId;
    if (Date.now() - flightFlipAt.current < FLIGHT_ZONE_SUPPRESS_MS) return;
    const name = zoneId && (conn.map?.zones.find((z) => z.id === zoneId)?.name ?? zoneId);
    show(name ? `ENTERED · ${name}` : "LEFT ZONE · COMMS CLOSED", name ? ENTER_TOAST_MS : LEAVE_TOAST_MS);
  }, [conn, zoneId, flying]);
  // drop a pending dismissal with the hud
  useEffect(() => () => clearTimeout(timer.current), []);
  return toast;
}
