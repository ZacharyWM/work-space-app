// root component: join screen + ws connection lifecycle (step 1.5), canvas stage (step 1.6),
// zone hud (step 2.3), local media (step 3.1), webrtc peers (step 3.4), video tiles (step 3.5),
// speaking detection (step 3.6), clerk auth (notes/005), grace-window resume (step 5.2),
// workspace routing + picker (notes/006)
import {
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/clerk-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  audioGroupOf,
  BLAST_COUNTDOWN_MS,
  clampItemDepth,
  ITEM_DEPTH_STEP,
  ITEM_SCALE_DEFAULT,
  RACE_COUNTDOWN_MS,
  type BlastResult,
  type GameTableGame,
  type ItemKind,
  type PlacedItem,
  type MemberEntry,
  type PlayerStatus,
  type RaceResult,
  type SpaceLinkState,
  type WorkspaceInfo,
  type WorkspaceListEntry,
} from "shared";
import { playAnnounceChime, playWaveChime } from "./chime";
import { setIceServers } from "./media/iceConfig";
import { LocalMedia, type MediaToggles } from "./media/localMedia";
import { LocalScreen } from "./media/localScreen";
import { PeerManager } from "./media/peerManager";
import { SpeakingDetector } from "./media/speaking";
import {
  Connection,
  type BlastRejection,
  type DecorRejection,
  type InitialMessage,
  type ItemRejection,
  type JoinRequest,
  type KickReason,
  type LinkRejection,
  type MapRejection,
  type RaceRejection,
  type RejectionReason,
  type VisitRejection,
} from "./net/connection";
import {
  acceptInvite,
  approveRequest,
  cancelInvite,
  cancelRequest,
  createWorkspace,
  declineInvite,
  deleteWorkspace,
  denyRequest,
  listMembers,
  listPending,
  listWorkspaces,
  removeMember,
  requestJoin,
  sendInvite,
  unbanMember,
  type InviteReason,
  type MemberList,
  type PendingLists,
} from "./net/workspaces";
import { itemIsColorable, itemLabel } from "./render/items";
import { ShipCanvas } from "./render/ShipCanvas";
import type { Stage } from "./render/stage";
import { BlastHud, BlastResults } from "./ui/BlastHud";
import { BlastPanel } from "./ui/BlastPanel";
import { ColorPicker, DecorPanel, SizeSlider } from "./ui/DecorPanel";
import { Hud } from "./ui/Hud";
import { MapEditor } from "./ui/MapEditor";
import { MeetingView } from "./ui/MeetingView";
import { RaceHud, RaceResults, raceTime } from "./ui/RaceHud";
import { RacePanel } from "./ui/RacePanel";
import { SpaceLinkPanel } from "./ui/SpaceLinkPanel";
import { Tiles } from "./ui/Tiles";

// dev: vite and the ws server are separate origins, so target the server's port
// directly (hostname-relative so LAN clients work). production: Caddy serves the
// client and proxies /ws to the server on the same origin, TLS included (step 5.3)
const WS_URL = import.meta.env.DEV
  ? `ws://${location.hostname}:3000`
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// join = form visible; connecting = join sent, awaiting welcome;
// resuming = unexpected drop, auto-reconnecting with the resume token; aboard = welcomed
type Phase = "join" | "connecting" | "resuming" | "aboard";

// resume retry backoff cap; delays run 1s, 2s, 4s, then 8s repeating (step 5.2)
const RESUME_RETRY_CAP_MS = 8000;
// give up resuming after this long — matches the server grace window
// (GRACE_MS, default 30s); past it the parked session is gone and the token is
// certainly dead. also the value the reconnect countdown ticks down from
const RESUME_DEADLINE_MS = 30_000;

// how long the "X WAVED AT YOU" toast stays up (notes/004)
const WAVE_TOAST_MS = 5000;

// how long the all-hands announcement banner stays up (notes/010)
const ANNOUNCE_BANNER_MS = 9000;

// how long a pod/map rejection notice stays up (notes/009)
const DECOR_NOTICE_MS = 3200;

// server decor rejections as the notice toast shows them (notes/017); the
// client pre-checks placement, so these fire on races and cap hits
const ITEM_REJECTION_TEXT: Record<ItemRejection, string> = {
  offFloor: "PROPS HAVE TO STAND ON THE DECK",
  notYourPod: "THAT POD BELONGS TO SOMEONE ELSE",
  full: "THIS WORKSPACE IS FULL OF PROPS — CLEAR SOME FIRST",
  gone: "SOMEONE ELSE ALREADY CLEARED THAT",
  visitor: "VISITORS CAN'T CHANGE THE DECOR",
};

// server map-edit rejections as the notice toast shows them (notes/010 map
// editor); the editor pre-validates, so these fire only on races or forgeries
const MAP_REJECTION_TEXT: Record<MapRejection, string> = {
  notCreator: "ONLY THE WORKSPACE OWNER CAN EDIT THE MAP",
  invalidMap: "THAT LAYOUT WAS REFUSED — RELOAD AND TRY AGAIN",
};

// server race rejections as the notice toast shows them (shuttle race feature)
const RACE_REJECTION_TEXT: Record<RaceRejection, string> = {
  notNearTable: "STAND AT THE HOLOTABLE TO JOIN THE RACE",
  raceInProgress: "A RACE IS ALREADY RUNNING — WAIT FOR IT TO END",
  lobbyFull: "THE RACE LOBBY IS FULL",
  flying: "DOCK YOUR SHUTTLE FIRST",
  notInLobby: "JOIN THE RACE LOBBY FIRST",
  notAllReady: "EVERYONE MUST BE READY TO START",
};

// server blasters rejections as the notice toast shows them (shuttle blasters feature)
const BLAST_REJECTION_TEXT: Record<BlastRejection, string> = {
  notNearTable: "STAND AT THE BLASTERS HOLOTABLE TO JOIN",
  matchInProgress: "A MATCH IS ALREADY RUNNING — WAIT FOR IT TO END",
  lobbyFull: "THE BLASTERS LOBBY IS FULL",
  flying: "DOCK YOUR SHUTTLE FIRST",
  notInLobby: "JOIN THE BLASTERS LOBBY FIRST",
  notAllReady: "EVERYONE MUST BE READY TO START",
  needTwo: "A FIGHT TAKES AT LEAST TWO PILOTS",
};

// server pod-claim rejections as the notice toast shows them (notes/009)
const DECOR_REJECTION_TEXT: Record<DecorRejection, string> = {
  podTaken: "SOMEONE CLAIMED THIS POD FIRST",
  haveClaim: "YOU ALREADY HAVE A POD — RELEASE IT FIRST",
  notAPod: "ONLY PODS CAN BE CLAIMED",
  notInPod: "STAND INSIDE THE POD TO CLAIM IT",
  noClaim: "YOU HAVE NO POD TO RELEASE",
  visitor: "VISITORS CAN'T CLAIM PODS",
};

// server portal-traversal rejections as the notice toast shows them (space link)
const VISIT_REJECTION_TEXT: Record<VisitRejection, string> = {
  notFound: "THAT WORKSPACE IS GONE",
  notLinked: "THAT LINK IS GONE",
  removed: "YOU ARE BANNED FROM THAT WORKSPACE",
  full: "TOO MANY VISITORS ABOARD — TRY AGAIN LATER",
  flying: "DOCK YOUR SHUTTLE FIRST",
  notNearLink: "STAND AT THE SPACE LINK",
};

// server link-management rejections as the overlay's error line shows them
const LINK_REJECTION_TEXT: Record<LinkRejection, string> = {
  notFound: "no workspace by that name — or it's already gone",
  notCreator: "only the creator manages links, and only from home",
  self: "a workspace can't link to itself",
  alreadyLinked: "already linked",
  blocked: "that workspace refused the link",
  youBlocked: "you blocked that workspace — unblock it first",
  requestPending: "they already asked you — accept their request instead",
  linkLimit: "link limit reached (10 per workspace)",
};

// what survives a refresh in sessionStorage: the resume token, the HOME
// workspace it belongs to (notes/006), the room actually holding the parked
// session when a drop happened mid-Visit (space link, ADR 0004), and the last
// effective mic/cam toggles, so re-acquisition matches the pre-drop state (step 5.2)
type StoredResume = {
  token: string;
  workspace: string;
  visited?: string;
  micOn: boolean;
  camOn: boolean;
};
const RESUME_KEY = "resume";

// only a token minted for this HOME workspace counts — a refresh on /w/a must
// not resume into workspace b's session (notes/006); the URL always names home
function readStoredResume(workspace: string): StoredResume | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as StoredResume;
    if (typeof v?.token !== "string" || v.token === "") return null;
    if (v.workspace !== workspace) return null;
    return {
      token: v.token,
      workspace: v.workspace,
      ...(typeof v.visited === "string" && v.visited !== ""
        ? { visited: v.visited }
        : {}),
      micOn: v.micOn === true,
      camOn: v.camOn === true,
    };
  } catch {
    return null;
  }
}

function writeStoredResume(
  token: string,
  workspace: string,
  toggles: MediaToggles,
  visited?: string,
): void {
  sessionStorage.setItem(
    RESUME_KEY,
    JSON.stringify({ token, workspace, visited, ...toggles }),
  );
}

// path routing without a router library (notes/006): / is the workspace
// picker, /w/:slug is the board card for that workspace
function slugFromPath(pathname: string): string | null {
  const m = /^\/w\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

export function App() {
  // current route: the workspace slug from /w/:slug, or null on the picker (notes/006)
  const [slug, setSlug] = useState<string | null>(() =>
    slugFromPath(location.pathname),
  );
  const [phase, setPhase] = useState<Phase>("join");
  // set when the socket closes so the join screen can say why it's back
  const [notice, setNotice] = useState<string | null>(null);
  // set by a notMember rejection: the join screen offers request-to-join in
  // place (notes/015)
  const [requestable, setRequestable] = useState(false);
  // self zone from server-authoritative zoneChanged echoes; drives the hud label/toast/pill
  const [selfZoneId, setSelfZoneId] = useState<string | null>(null);
  // true while piloting a shuttle; the stage reports transitions (notes/003)
  const [flying, setFlying] = useState(false);
  // screen share on, mirrored from the LocalScreen track lifecycle (notes/003)
  const [sharing, setSharing] = useState(false);
  // the OS refused the capture (browser missing the screen-recording
  // permission) — shows the how-to-fix notice until dismissed (notes/003)
  const [shareBlocked, setShareBlocked] = useState(false);
  // meeting mode: the camera-grid overlay replaces the ship view (notes/003)
  const [meeting, setMeeting] = useState(false);
  // own presence status; the crew panel sets it, the toolbar dot shows it (notes/004)
  const [selfStatus, setSelfStatus] = useState<PlayerStatus>("available");
  // latest received wave: waver's name + a counter so repeat waves re-trigger
  // the toast entrance and its dismiss timer (notes/004)
  const [wave, setWave] = useState<{ name: string; n: number } | null>(null);
  // latest all-hands announcement banner; counter re-triggers like the wave toast (notes/010)
  const [announce, setAnnounce] = useState<{
    name: string;
    text: string;
    n: number;
  } | null>(null);
  // map editor overlay, owner-only (notes/010 map editor); closed on save
  // success (the mapChanged echo) and with the session
  const [editorOpen, setEditorOpen] = useState(false);
  // bumped on every mapChanged: rerenders anything reading conn.map
  const [mapVersion, setMapVersion] = useState(0);
  // decor build mode (notes/017): the tray, the armed library kind, the size
  // and color the tray stamps at, the prop picked on the canvas, the size and
  // color its controls are dragging that prop to (undefined = the stored one,
  // which for color is distinct from the null that means its authored art),
  // and whether DELETE is armed
  const [decorOpen, setDecorOpen] = useState(false);
  const [decorKind, setDecorKind] = useState<ItemKind | null>(null);
  const [decorScale, setDecorScale] = useState(ITEM_SCALE_DEFAULT);
  const [decorColor, setDecorColor] = useState<string | null>(null);
  const [decorPick, setDecorPick] = useState<PlacedItem | null>(null);
  const [pickScale, setPickScale] = useState<number | null>(null);
  const [pickColor, setPickColor] = useState<string | null | undefined>(undefined);
  const [deleteArmed, setDeleteArmed] = useState(false);
  // latest pod/map rejection notice; counter re-triggers like the wave toast
  const [decorNotice, setDecorNotice] = useState<{
    text: string;
    n: number;
  } | null>(null);
  // shuttle race (holotable game): true while we're out on the course, gates
  // we've passed, the GO moment (receipt + countdown) for the clock, whether
  // the scoreboard is up (opens at our finish or the race's end, stays until
  // CLOSE), and the final standings (null while the race still runs — the
  // board shows live standings until they arrive)
  const [racing, setRacing] = useState(false);
  const [raceGate, setRaceGate] = useState(0);
  const [raceGoAt, setRaceGoAt] = useState<number | null>(null);
  const [raceBoardOpen, setRaceBoardOpen] = useState(false);
  const [raceResults, setRaceResults] = useState<RaceResult[] | null>(null);
  // space link (workspace linking): the overlay's state (fetched at the
  // portal, refreshed after every management action), whether it's open, and
  // its inline error line
  const [linkState, setLinkState] = useState<SpaceLinkState | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // bumped on every welcome: a portal traversal re-welcomes this connection
  // into a different room, and the canvas stage must rebuild from the new map
  const [stageEpoch, setStageEpoch] = useState(0);
  // shuttle blasters (holotable game): true while we're out in the arena, the
  // FIGHT moment (receipt + countdown), and the scoreboard state like the race's
  const [blasting, setBlasting] = useState(false);
  const [blastGoAt, setBlastGoAt] = useState<number | null>(null);
  const [blastBoardOpen, setBlastBoardOpen] = useState(false);
  const [blastResults, setBlastResults] = useState<BlastResult[] | null>(null);
  // seconds left on the reconnect countdown while phase === "resuming"; ticks
  // down from RESUME_DEADLINE_MS toward the give-up deadline (resumeUntilRef)
  const [resumeSecondsLeft, setResumeSecondsLeft] = useState(
    RESUME_DEADLINE_MS / 1000,
  );
  const connRef = useRef<Connection | null>(null);
  // acquired device tracks; lives from before join until socket close (step 3.1)
  const mediaRef = useRef<LocalMedia | null>(null);
  // active peer connections, torn down on any socket close (step 3.4)
  const peersRef = useRef<PeerManager | null>(null);
  // local mic speaking detection; null when no mic track was acquired (step 3.6)
  const speakingRef = useRef<SpeakingDetector | null>(null);
  // local display capture; lives with the connection like the devices (notes/003)
  const screenRef = useRef<LocalScreen | null>(null);
  // set by ShipCanvas so the hud zoom buttons reach the stage camera
  const stageRef = useRef<Stage | null>(null);
  // rerender trigger for the tiles: bumped on roster changes (except the 15Hz
  // pos stream — the canvas reads positions per frame), remote stream arrival/
  // teardown, and self mic/cam flips (step 3.5)
  const [, setAvVersion] = useState(0);
  const bumpAv = () => setAvVersion((v) => v + 1);
  // true while EXIT closes the socket, so onClose skips the "connection closed" notice
  const leavingRef = useRef(false);
  // set by joinRejected so the close that follows shows why (steps 5.1, 5.2)
  const rejectedRef = useRef<RejectionReason | null>(null);
  // set by kicked: the server ended this session (boarded elsewhere /
  // workspace deleted) — the close that follows must not resume (notes/007)
  const kickedRef = useRef<KickReason | null>(null);
  // resume retry loop: give-up deadline (null = loop not running) + attempt count (step 5.2)
  const resumeUntilRef = useRef<number | null>(null);
  const resumeAttemptRef = useRef(0);

  // clerk session: mints the short-lived token the server verifies on join (notes/005)
  const { getToken } = useAuth();
  // clerk user id: pod claims are account-level, so ownership checks compare
  // against it, not the per-session player id (notes/009)
  const { user } = useUser();
  const selfUserId = user?.id ?? "";

  // back/forward must re-derive the route the same way a fresh load does (notes/006)
  useEffect(() => {
    const onPop = () => setSlug(slugFromPath(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  async function join(req: JoinRequest): Promise<void> {
    // the board card only renders on /w/:slug, so a null slug can't reach here
    if (slug === null) return;
    setNotice(null);
    setPhase("connecting");
    // fresh token per attempt — they expire in about a minute (notes/005)
    const token = await getToken();
    if (!token) {
      setNotice("sign-in expired — sign in again");
      setPhase("join");
      return;
    }
    await connect(req, (effective) => ({
      type: "join",
      token,
      workspace: slug,
      ...effective,
    }));
  }

  // begin or continue the resume retry loop after an unexpected close; false
  // when there's no token for this workspace or the deadline has passed (step 5.2)
  function scheduleResume(): boolean {
    const stored = slug === null ? null : readStoredResume(slug);
    if (!stored) return false;
    if (resumeUntilRef.current === null) {
      resumeUntilRef.current = Date.now() + RESUME_DEADLINE_MS;
      resumeAttemptRef.current = 0;
    }
    if (Date.now() >= resumeUntilRef.current) {
      // out of time: forfeit the token and fall back to a fresh join
      sessionStorage.removeItem(RESUME_KEY);
      resumeUntilRef.current = null;
      return false;
    }
    const delay = Math.min(
      1000 * 2 ** resumeAttemptRef.current,
      RESUME_RETRY_CAP_MS,
    );
    resumeAttemptRef.current += 1;
    setPhase("resuming");
    window.setTimeout(() => attemptResume(stored), delay);
    return true;
  }

  // one resume attempt: re-acquire media with the stored toggles, then present
  // the token; a failed connect lands in onClose, which schedules the next try
  function attemptResume(stored: StoredResume): void {
    void connect(stored, (effective) => ({
      type: "resume",
      token: stored.token,
      workspace: stored.workspace,
      // a drop mid-Visit resumes in place (space link, ADR 0004)
      ...(stored.visited !== undefined ? { visited: stored.visited } : {}),
      ...effective,
    }));
  }

  // a refresh inside the grace window resumes: the token survives in
  // sessionStorage (step 5.2, superseding decision 10's fresh-join semantics);
  // only a token minted for this route's workspace counts (notes/006)
  useEffect(() => {
    const stored = slug === null ? null : readStoredResume(slug);
    if (!stored) return;
    resumeUntilRef.current = Date.now() + RESUME_DEADLINE_MS;
    resumeAttemptRef.current = 1; // this immediate attempt counts as the first
    setPhase("resuming");
    attemptResume(stored);
    // mount-only: rerunning would open duplicate connections
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // drive the reconnect countdown: while resuming, tick the seconds-left down
  // from the give-up deadline so the red screen can show it. the resume loop
  // itself owns the actual give-up (scheduleResume); this only reflects it
  useEffect(() => {
    if (phase !== "resuming") return;
    const tick = () => {
      const until = resumeUntilRef.current;
      const left =
        until === null
          ? 0
          : Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setResumeSecondsLeft(left);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // acquire devices, build the peer/speaking machinery, and open the socket with
  // the given first message — shared by fresh joins and resumes (step 5.2)
  async function connect(
    requested: MediaToggles,
    makeInitial: (effective: MediaToggles) => InitialMessage,
  ): Promise<void> {
    // devices first, so the join message carries the *effective* toggles — a denied
    // cam boards as camOn=false and the roster is never wrong (decision 8)
    const media = await LocalMedia.acquire(requested);
    mediaRef.current = media;
    // signals route through whichever socket is current via the ref, so the
    // manager can be built before the connection whose handlers feed it
    const peers = new PeerManager(
      media.stream,
      (to, data) => connRef.current?.send({ type: "signal", to, data }),
      bumpAv,
    );
    peersRef.current = peers;
    // cam off/on stops/re-acquires the device (3.1); swap the track into live
    // pairs and rerender so the self tiles reflect the held track
    media.onVideoTrack = (track) => {
      peers.setVideoTrack(track);
      bumpAv();
    };
    // speaking changes go to the room and onto the self roster entry so the
    // canvas ring and self tile light from the same local detection (step 3.6)
    const onSpeaking = (on: boolean): void => {
      connRef.current?.send({ type: "speaking", on });
      const self = connRef.current?.roster.get(connRef.current.selfId ?? "");
      if (self) self.speaking = on;
      bumpAv();
    };
    // mic off/on stops/re-acquires the device too (3.1): swap the track into
    // live pairs and rebind speaking detection to it — a dropped mic must also
    // retract a live speaking flag, which the disposed detector can't emit
    media.onAudioTrack = (track) => {
      peers.setAudioTrack(track);
      speakingRef.current?.dispose();
      speakingRef.current =
        track === null
          ? null
          : SpeakingDetector.create(media.stream, onSpeaking);
      const self = connRef.current?.roster.get(connRef.current.selfId ?? "");
      if (track === null && self?.speaking) {
        connRef.current?.send({ type: "speaking", on: false });
        self.speaking = false;
      }
      bumpAv();
    };
    // share start/stop: swap the display track into every pair's screen m-line,
    // tell the room, keep the self roster entry truthful, and open the meeting
    // view on start — the point of presenting is that people see it (notes/003)
    const screen = new LocalScreen();
    screenRef.current = screen;
    screen.onTrack = (track) => {
      peers.setScreenTrack(track);
      const on = track !== null;
      connRef.current?.send({ type: "screenShare", on });
      const self = connRef.current?.roster.get(connRef.current.selfId ?? "");
      if (self) self.screenOn = on;
      setSharing(on);
      if (on) setMeeting(true);
      bumpAv();
    };
    // OS-level refusal (not a picker cancel): tell the user how to unblock,
    // since every further SHARE attempt is doomed until they do (notes/003)
    screen.onBlocked = () => setShareBlocked(true);
    speakingRef.current = SpeakingDetector.create(media.stream, onSpeaking);
    const conn = new Connection(WS_URL, makeInitial(media.state), {
      onWelcome: () => {
        // peer connections use the server-minted ICE list; peerConnect
        // directives only ever arrive after this point (step 5.4)
        setIceServers(conn.iceServers);
        // the token + HOME workspace + effective toggles survive a refresh for
        // the resume path (step 5.2, notes/006); a Visit additionally records
        // the visited room so a drop resumes in place (space link, ADR 0004)
        if (conn.resumeToken && conn.home) {
          writeStoredResume(
            conn.resumeToken,
            conn.home.slug,
            media.state,
            conn.visiting ? conn.workspace?.slug : undefined,
          );
        }
        resumeUntilRef.current = null;
        // a mid-session welcome is a portal traversal (space link): every old
        // peer pair is dead — the far side already got peerDisconnects, ours
        // tear down here and fresh directives follow the new roster. All the
        // per-room UI dies with the room; a first welcome resets nothing real
        peersRef.current?.dispose();
        screenRef.current?.stop();
        setMeeting(false);
        setEditorOpen(false);
        setDecorOpen(false);
        setDecorKind(null);
        setDecorPick(null);
        setLinkOpen(false);
        setLinkState(null);
        setLinkError(null);
        setFlying(false);
        setRacing(false);
        setRaceGate(0);
        setRaceGoAt(null);
        setRaceBoardOpen(false);
        setRaceResults(null);
        setBlasting(false);
        setBlastGoAt(null);
        setBlastBoardOpen(false);
        setBlastResults(null);
        // the stage rebuilds from the new room's map/roster
        setStageEpoch((e) => e + 1);
        // welcome roster carries the spawn zone (null today — the airlock is open
        // space) or, on resume, the zone the player dropped in
        setSelfZoneId(conn.roster.get(conn.selfId!)?.zoneId ?? null);
        // fresh joins are available; a resume keeps the pre-drop status (notes/004)
        setSelfStatus(conn.roster.get(conn.selfId!)?.status ?? "available");
        setPhase("aboard");
      },
      // the canvas stage reads conn.roster every frame; react only needs the
      // low-rate changes so the tiles track membership/media (step 3.5)
      onRosterChange: (change) => {
        if (change !== "pos") bumpAv();
      },
      onSelfZoneChanged: setSelfZoneId,
      // a share starting in the local zone opens the meeting view here too;
      // the roster entry is already updated when this fires (notes/003)
      onScreenShare: (id, on) => {
        if (!on) return;
        const selfZone = conn.roster.get(conn.selfId ?? "")?.zoneId ?? null;
        if (selfZone !== null && conn.roster.get(id)?.zoneId === selfZone)
          setMeeting(true);
      },
      // pods changed: rerender the hud/panel (notes/009)
      onDecorChange: () => {
        bumpAv();
      },
      // one of our pod actions was refused — say why (notes/009)
      onDecorRejected: (reason) => {
        setDecorNotice((d) => ({
          text: DECOR_REJECTION_TEXT[reason],
          n: (d?.n ?? 0) + 1,
        }));
      },
      // a prop was placed / moved / cleared by anyone: the canvas reads
      // conn.items per frame, so this only refreshes the pick popup (notes/017)
      onItemsChange: () => {
        setDecorPick((pick) =>
          pick === null ? null : (conn.items.get(pick.id) ?? null),
        );
      },
      // one of our own decor calls was refused — say why (notes/017)
      onItemRejected: (reason) => {
        setDecorNotice((d) => ({
          text: ITEM_REJECTION_TEXT[reason],
          n: (d?.n ?? 0) + 1,
        }));
      },
      // the owner replaced the map (possibly us): swap the stage's layout
      // (which teleports us home if our floor vanished) and close the
      // editor (notes/010 map editor)
      onMapChanged: () => {
        if (conn.map) stageRef.current?.setMap(conn.map);
        setEditorOpen(false);
        setMapVersion((v) => v + 1);
        bumpAv();
      },
      // our own map edit was refused — say why (notes/010 map editor)
      onMapRejected: (reason) => {
        setDecorNotice((d) => ({
          text: MAP_REJECTION_TEXT[reason],
          n: (d?.n ?? 0) + 1,
        }));
      },
      // the overlay's state landed (opened at the portal, or refreshed after a
      // management action) — show it (space link feature)
      onSpaceLinkState: (state) => {
        setLinkState(state);
        setLinkOpen(true);
      },
      // one of our link actions was refused — the overlay says why
      onLinkRejected: (reason) => {
        setLinkError(LINK_REJECTION_TEXT[reason]);
      },
      // one of our traversals was refused — say why
      onVisitRejected: (reason) => {
        setDecorNotice((d) => ({
          text: VISIT_REJECTION_TEXT[reason],
          n: (d?.n ?? 0) + 1,
        }));
      },
      // lobby/progress/quit changes: conn.race is current, rerender the panels
      onRaceChange: bumpAv,
      // the race is on: racers board their grid slot, everyone gets the gates
      onRaceStarted: (selfStart) => {
        if (selfStart) {
          stageRef.current?.startRace(conn.race.gates, selfStart);
          setRaceGoAt(Date.now() + RACE_COUNTDOWN_MS);
        }
        setRaceBoardOpen(false);
        setRaceResults(null);
        bumpAv();
      },
      // a finish line moment; ours gets the place/time toast and pops the
      // scoreboard — live standings until the race ends, and we stay in race
      // comms (the debrief) while it's up
      onRaceFinished: (id, place, timeMs) => {
        if (id === conn.selfId) {
          setRaceBoardOpen(true);
          setDecorNotice((d) => ({
            text: `FINISHED P${place} · ${raceTime(timeMs)}`,
            n: (d?.n ?? 0) + 1,
          }));
        }
        bumpAv();
      },
      // race over: land anyone still out (a no-op when we finished or never
      // raced) and show the final standings — participants only (self in the
      // results); spectators never get the board
      onRaceEnded: (results) => {
        stageRef.current?.endRace();
        setRaceGoAt(null);
        if (results.some((r) => r.id === conn.selfId)) {
          setRaceResults(results);
          setRaceBoardOpen(true);
        } else {
          setRaceBoardOpen(false);
        }
        bumpAv();
      },
      // one of our race actions was refused — say why
      onRaceRejected: (reason) => {
        setDecorNotice((d) => ({
          text: RACE_REJECTION_TEXT[reason],
          n: (d?.n ?? 0) + 1,
        }));
      },
      // blasters lobby/quit changes: conn.blast is current, rerender the panels
      onBlastChange: bumpAv,
      // the match is on: combatants board their spawn pose, everyone gets the arena
      onBlastStarted: (selfStart) => {
        if (selfStart && conn.blast.arena) {
          stageRef.current?.startBlast(conn.blast.arena, selfStart);
          setBlastGoAt(Date.now() + BLAST_COUNTDOWN_MS);
        }
        setBlastBoardOpen(false);
        setBlastResults(null);
        bumpAv();
      },
      // a laser bolt was fired somewhere — the stage simulates and draws it
      onBlastFire: (id, x, y, a) => stageRef.current?.spawnBolt(id, x, y, a),
      // a shuttle went down: explosion on the canvas; ours also lands us,
      // says who got us, and pops the scoreboard — live standings until the
      // match ends, and we stay in match comms (the debrief) while it's up
      onBlastEliminated: (id, by, x, y) => {
        stageRef.current?.blastExplode(x, y);
        if (id === conn.selfId) {
          stageRef.current?.endBlast();
          setBlastBoardOpen(true);
          const shooter = conn.roster.get(by)?.name ?? "?";
          setDecorNotice((d) => ({
            text: `BLASTED BY ${shooter.toUpperCase()} — YOU'RE OUT`,
            n: (d?.n ?? 0) + 1,
          }));
        }
        bumpAv();
      },
      // match over: land anyone still out (a no-op when we already fell or
      // never fought) and show the final standings — participants only (self
      // in the results); spectators never get the board
      onBlastEnded: (results) => {
        stageRef.current?.endBlast();
        setBlastGoAt(null);
        if (results.some((r) => r.id === conn.selfId)) {
          setBlastResults(results);
          setBlastBoardOpen(true);
        } else {
          setBlastBoardOpen(false);
        }
        bumpAv();
      },
      // one of our blasters actions was refused — say why
      onBlastRejected: (reason) => {
        setDecorNotice((d) => ({
          text: BLAST_REJECTION_TEXT[reason],
          n: (d?.n ?? 0) + 1,
        }));
      },
      // fresh best scores landed on conn.leaderboards — rerender the table panels
      onLeaderboards: bumpAv,
      // a chat message landed on conn.chat — rerender so the panel shows it
      // and the CHAT badge counts it; an announce also banners + chimes for
      // everyone, sender included (notes/010)
      onChat: (message) => {
        if (message.scope === "announce") {
          playAnnounceChime();
          setAnnounce((a) => ({
            name: message.name,
            text: message.text,
            n: (a?.n ?? 0) + 1,
          }));
        }
        bumpAv();
      },
      // another player emoted: bubble over their avatar on the canvas (notes/010)
      onEmote: (id, emote) => stageRef.current?.emote(id, emote),
      // someone waved at us: chime, toast their name, and pulse the locator
      // ring around their avatar on the canvas (notes/004)
      onWave: (from) => {
        const waver = conn.roster.get(from);
        if (!waver) return;
        playWaveChime();
        setWave((w) => ({ name: waver.name, n: (w?.n ?? 0) + 1 }));
        stageRef.current?.wave(from);
      },
      // pairing directives + relayed signaling drive the peer manager (step 3.4)
      onPeerConnect: (peerId, initiator) => peers.connect(peerId, initiator),
      onPeerDisconnect: (peerId) => peers.disconnect(peerId),
      onSignal: (from, data) => peers.signal(from, data),
      // typed rejection: the server closes next; flag it so onClose shows why (steps 5.1, 5.2)
      onJoinRejected: (reason) => {
        rejectedRef.current = reason;
      },
      // session ended server-side; flag it so onClose skips the resume loop (notes/007)
      onKicked: (reason) => {
        kickedRef.current = reason;
      },
      onClose: () => {
        connRef.current = null;
        // the effective toggles as of the drop, captured before the devices
        // release below — a visit-ended auto-rejoin re-acquires with them
        const lastToggles: MediaToggles = mediaRef.current?.state ?? {
          micOn: false,
          camOn: false,
        };
        // the shuttle (if any) is gone with the session (notes/003)
        setFlying(false);
        // any race run dies with the session too (shuttle race feature)
        setRacing(false);
        setRaceGate(0);
        setRaceGoAt(null);
        setRaceBoardOpen(false);
        setRaceResults(null);
        // and any blasters run (shuttle blasters feature)
        setBlasting(false);
        setBlastGoAt(null);
        setBlastBoardOpen(false);
        setBlastResults(null);
        // the decor tray dies with the session too (notes/017)
        setDecorOpen(false);
        setDecorKind(null);
        setDecorPick(null);
        // and the space link overlay (space link feature)
        setLinkOpen(false);
        setLinkState(null);
        setLinkError(null);
        // the map editor dies with the session (notes/010 map editor)
        setEditorOpen(false);
        // the display capture and the meeting view die with the session (notes/003)
        screenRef.current?.dispose();
        screenRef.current = null;
        setSharing(false);
        setShareBlocked(false);
        setMeeting(false);
        // close every peer connection (EXIT also lands here via the socket close)
        peersRef.current?.dispose();
        peersRef.current = null;
        // stop polling the mic before its track is released below
        speakingRef.current?.dispose();
        speakingRef.current = null;
        // release devices so the camera light goes out back at the join screen
        mediaRef.current?.dispose();
        mediaRef.current = null;
        if (leavingRef.current) {
          leavingRef.current = false;
          setNotice(null);
          setPhase("join");
          return;
        }
        // kicked: the resume token died server-side with the eviction (notes/007)
        const kicked = kickedRef.current;
        kickedRef.current = null;
        // the Visit died under us (link removed, banned there, or the visited
        // workspace deleted): a kicked Visitor is returned to their home
        // spawn point — re-board home on our own (space link feature, Q7)
        if (kicked === "visitEnded") {
          sessionStorage.removeItem(RESUME_KEY);
          resumeUntilRef.current = null;
          setDecorNotice((d) => ({
            text: "YOUR VISIT ENDED — RETURNED HOME",
            n: (d?.n ?? 0) + 1,
          }));
          void join(lastToggles);
          return;
        }
        if (kicked) {
          sessionStorage.removeItem(RESUME_KEY);
          resumeUntilRef.current = null;
          setNotice(
            kicked === "boardedElsewhere"
              ? "this account boarded another session — this one ended"
              : kicked === "workspaceDeleted"
                ? "this workspace was deleted"
                : "you were removed from this workspace",
          );
          setPhase("join");
          return;
        }
        const rejection = rejectedRef.current;
        rejectedRef.current = null;
        if (rejection === "unauthorized") {
          setNotice("authorization failed — sign in and try again");
          setPhase("join");
          return;
        }
        if (rejection === "resumeExpired") {
          // the token is dead; a fresh join is the only way back (step 5.2)
          sessionStorage.removeItem(RESUME_KEY);
          resumeUntilRef.current = null;
          setNotice("session expired");
          setPhase("join");
          return;
        }
        if (rejection === "workspaceNotFound") {
          // the slug names nothing — retrying can't help (notes/006)
          sessionStorage.removeItem(RESUME_KEY);
          resumeUntilRef.current = null;
          setNotice("workspace not found — check the link");
          setPhase("join");
          return;
        }
        if (rejection === "removed") {
          // this account was removed (banned) by the creator — retrying can't help (notes/008)
          sessionStorage.removeItem(RESUME_KEY);
          resumeUntilRef.current = null;
          setNotice("you were removed from this workspace");
          setPhase("join");
          return;
        }
        if (rejection === "notMember") {
          // no membership: boarding takes an invite or an approved join
          // request — offer request-to-join in place (notes/015)
          sessionStorage.removeItem(RESUME_KEY);
          resumeUntilRef.current = null;
          setNotice("you're not a member of this workspace");
          setRequestable(true);
          setPhase("join");
          return;
        }
        if (rejection === "workspaceFull") {
          // no member slot for a first-time boarder (notes/008)
          setNotice("this workspace is full — 20 member limit");
          setPhase("join");
          return;
        }
        // unexpected close: auto-resume with backoff while a token is held (step 5.2)
        if (scheduleResume()) return;
        setNotice("connection closed");
        setPhase("join");
      },
    });
    connRef.current = conn;
  }

  // any zone change ends a running share — carrying a live screen into a room
  // of new people without an explicit act would be a privacy surprise — and
  // leaving into open space (walking out, launching) exits meeting mode (notes/003)
  useEffect(() => {
    screenRef.current?.stop();
    if (selfZoneId === null) setMeeting(false);
  }, [selfZoneId]);

  // company: someone else shares the local audio group, so transmitting is
  // possible. the group is the zone on foot, or the ship-wide FLIGHT group
  // while piloting — so a fellow pilot is company too (flight comms). computed
  // per render — roster joins/leaves/zone flips/board+dock all bump a rerender
  const liveConn = connRef.current;
  const selfPlayer = liveConn?.roster.get(liveConn.selfId ?? "");
  const selfGroup = selfPlayer ? audioGroupOf(selfPlayer) : null;
  const company =
    phase === "aboard" &&
    liveConn !== null &&
    selfGroup !== null &&
    [...liveConn.roster.values()].some(
      (p) => p.id !== liveConn.selfId && audioGroupOf(p) === selfGroup,
    );

  // devices are held only while they can transmit: company in the group, or
  // meeting mode explicitly open. alone in a zone, alone in flight, or in open
  // space both devices are released so the OS in-use lights go dark; the
  // toggles keep the user's intent for when company arrives (privacy).
  // 'away' also parks both devices regardless of company/meeting, restoring
  // the user's intent when they come back (notes/010 away popup)
  useEffect(() => {
    if (phase !== "aboard") return;
    const media = mediaRef.current;
    const c = connRef.current;
    if (!media || !c) return;
    void media
      .setTransmitting((company || meeting) && selfStatus !== "away")
      .then(() => {
        // a re-acquire can fail (permission revoked, device unplugged): the
        // toggle lands back off — the room must hear about it like a hud flip
        const st = media.state;
        const self = c.roster.get(c.selfId ?? "");
        if (!self || (self.micOn === st.micOn && self.camOn === st.camOn))
          return;
        c.send({ type: "mediaState", ...st });
        self.micOn = st.micOn;
        self.camOn = st.camOn;
        bumpAv();
      });
  }, [phase, company, meeting, selfStatus]);

  // 'away' also silences incoming audio so the user hears nothing while gone;
  // returning to available/busy unmutes every peer (notes/010 away popup)
  useEffect(() => {
    if (phase !== "aboard") return;
    peersRef.current?.setOutputMuted(selfStatus === "away");
  }, [phase, selfStatus]);

  // build mode follows the tray: closing it drops the ghost and the pick, so
  // a stray click can't place or clear anything afterward (notes/017)
  useEffect(() => {
    stageRef.current?.setDecorMode(decorOpen);
    if (!decorOpen) {
      setDecorKind(null);
      setDecorPick(null);
    }
  }, [decorOpen]);

  // the armed kind rides to the stage, which draws its ghost under the cursor
  useEffect(() => {
    stageRef.current?.setDecorKind(decorKind);
  }, [decorKind]);

  // so do the tray's size and color, which the ghost is drawn at; reopening the
  // tray resets the stage's copy, so these re-send them
  useEffect(() => {
    stageRef.current?.setDecorScale(decorScale);
  }, [decorScale, decorOpen]);

  useEffect(() => {
    stageRef.current?.setDecorColor(decorColor);
  }, [decorColor, decorOpen]);

  // a freshly picked prop always starts with its DELETE unarmed and its size
  // and color controls reading what the prop is actually stored with
  useEffect(() => {
    setDeleteArmed(false);
    setPickScale(null);
    setPickColor(undefined);
  }, [decorPick?.id]);

  // meeting mode, the map editor, away mode, and an open game scoreboard own
  // the keyboard: suppress WASD/E so the player can't wander behind the
  // overlay, while away, or until they CLOSE the board (notes/003, notes/010)
  useEffect(() => {
    stageRef.current?.setKeysEnabled(
      !meeting &&
        !editorOpen &&
        selfStatus !== "away" &&
        !raceBoardOpen &&
        !blastBoardOpen &&
        !linkOpen,
    );
  }, [meeting, editorOpen, selfStatus, raceBoardOpen, blastBoardOpen, linkOpen]);

  // the rejection notice dismisses itself; a newer one restarts the clock
  useEffect(() => {
    if (!decorNotice) return;
    const t = setTimeout(() => setDecorNotice(null), DECOR_NOTICE_MS);
    return () => clearTimeout(t);
  }, [decorNotice]);

  // own status change from the crew panel: tell the room, keep the self roster
  // entry truthful (the canvas pill reads it next frame), rerender (notes/004)
  function setStatus(status: PlayerStatus): void {
    const conn = connRef.current;
    if (!conn) return;
    conn.send({ type: "status", status });
    const self = conn.roster.get(conn.selfId ?? "");
    if (self) self.status = status;
    setSelfStatus(status);
  }

  // the wave toast dismisses itself; a newer wave restarts the clock (notes/004)
  useEffect(() => {
    if (!wave) return;
    const t = setTimeout(() => setWave(null), WAVE_TOAST_MS);
    return () => clearTimeout(t);
  }, [wave]);

  // the announcement banner dismisses itself; a newer one restarts the clock (notes/010)
  useEffect(() => {
    if (!announce) return;
    const t = setTimeout(() => setAnnounce(null), ANNOUNCE_BANNER_MS);
    return () => clearTimeout(t);
  }, [announce]);

  // stage game callbacks, stable so ShipCanvas's effect doesn't remount the
  // stage on every render (shuttle race + blasters features)
  const onRacingChange = useCallback((on: boolean) => {
    setRacing(on);
    if (!on) setRaceGate(0);
  }, []);
  const onBlastingChange = useCallback(setBlasting, []);
  // E at a holotable: ask for a seat in that table's game lobby; the
  // raceLobby/blastLobby echo opens the panel
  const onGameTable = useCallback((game: GameTableGame) => {
    connRef.current?.send({
      type: game === "blast" ? "blastJoin" : "raceJoin",
    });
  }, []);
  // E at the Space Link portal: ask for the overlay's state; the
  // spaceLinkState reply opens it (space link feature)
  const onSpaceLink = useCallback(() => {
    connRef.current?.send({ type: "spaceLink" });
  }, []);

  // creator-only ban of a Visitor from the crew panel (space link, Q7): rides
  // the same removeMember round-trip the member panel uses — the server kicks
  // them home and the ban blocks future Visits even while the Link stands
  async function banVisitor(userId: string): Promise<void> {
    const conn = connRef.current;
    if (!conn?.workspace) return;
    try {
      const token = await getToken();
      if (!token) return;
      const result = await removeMember(WS_URL, token, conn.workspace.slug, userId);
      if (!result.ok) {
        setDecorNotice((d) => ({
          text: "COULD NOT BAN THAT VISITOR",
          n: (d?.n ?? 0) + 1,
        }));
      }
    } catch {
      setDecorNotice((d) => ({
        text: "COULD NOT REACH THE SERVER",
        n: (d?.n ?? 0) + 1,
      }));
    }
  }

  // drop out of the race: tell the server, then land immediately
  function quitRace(): void {
    connRef.current?.send({ type: "raceLeave" });
    stageRef.current?.endRace();
  }

  // forfeit the blasters match: tell the server, then land immediately
  function quitBlast(): void {
    connRef.current?.send({ type: "blastLeave" });
    stageRef.current?.endBlast();
  }

  // CLOSE on a game scoreboard: release the debrief comms hold server-side
  // (a no-op for spectators, who never held one) and clear our own roster
  // entry right away — the debriefEnded echo confirms
  function closeBoard(game: "race" | "blast"): void {
    const conn = connRef.current;
    if (conn) {
      conn.send({ type: "boardClose", game });
      const self = conn.roster.get(conn.selfId ?? "");
      if (self?.debrief === game) self.debrief = null;
    }
    if (game === "race") {
      setRaceBoardOpen(false);
      setRaceResults(null);
    } else {
      setBlastBoardOpen(false);
      setBlastResults(null);
    }
  }

  // SHARE toggle: start is async (the browser's picker); deny/cancel stays off
  function toggleShare(): void {
    const screen = screenRef.current;
    if (!screen) return;
    if (screen.on) screen.stop();
    else void screen.start();
  }

  // the blocked notice lingers long enough to read the fix, then clears; a new
  // failed attempt raises it again
  useEffect(() => {
    if (!shareBlocked) return;
    const t = setTimeout(() => setShareBlocked(false), 12_000);
    return () => clearTimeout(t);
  }, [shareBlocked]);

  // deliberate EXIT: close the socket (the server despawns the avatar via its
  // close handler) and forfeit the grace window — no auto-resume after a choice
  function exit(): void {
    leavingRef.current = true;
    sessionStorage.removeItem(RESUME_KEY);
    connRef.current?.close();
  }

  // keep the stored toggles current so a resume re-acquires what was live (step 5.2)
  function mediaChanged(): void {
    const stored = slug === null ? null : readStoredResume(slug);
    const media = mediaRef.current;
    if (stored && media)
      writeStoredResume(stored.token, stored.workspace, media.state, stored.visited);
    bumpAv();
  }

  // back to the picker at / — same-app navigation, no reload (notes/007)
  function toPicker(): void {
    history.pushState({}, "", "/");
    setNotice(null);
    setRequestable(false);
    setSlug(null);
  }

  // no slug: the workspace picker owns the page (notes/006); no connection is
  // opened here, so the phase machinery above stays idle
  if (slug === null) {
    return (
      <PickerScreen
        onOpen={(s) => {
          history.pushState({}, "", `/w/${s}`);
          setSlug(s);
        }}
      />
    );
  }
  if (
    phase === "aboard" &&
    connRef.current &&
    mediaRef.current &&
    peersRef.current
  ) {
    const conn = connRef.current;
    // someone else in the zone already presenting locks the SHARE button (notes/003)
    const shareLocked = [...conn.roster.values()].some(
      (p) =>
        p.id !== conn.selfId &&
        p.zoneId !== null &&
        p.zoneId === selfZoneId &&
        p.screenOn,
    );
    // a lobby seat shows its game's panel until the shuttles launch
    const inRaceLobby = conn.race.members.some((m) => m.id === conn.selfId);
    const inBlastLobby = conn.blast.members.some((m) => m.id === conn.selfId);
    return (
      <>
        {/* keyed by the welcome epoch: a portal traversal re-welcomes this
            connection into a different room, so the stage rebuilds (space link) */}
        <ShipCanvas
          key={stageEpoch}
          conn={conn}
          stageRef={stageRef}
          onFlyingChange={setFlying}
          onRacingChange={onRacingChange}
          onRaceGate={setRaceGate}
          onBlastingChange={onBlastingChange}
          onGameTable={onGameTable}
          onSpaceLink={onSpaceLink}
          onDecorSelect={setDecorPick}
          onDecorArmedChange={setDecorKind}
        />
        {/* race lobby panel while seated at the holotable (shuttle race feature) */}
        {inRaceLobby && !conn.race.racing && (
          <RacePanel
            conn={conn}
            onReady={(on) => conn.send({ type: "raceReady", on })}
            onStart={() => conn.send({ type: "raceStart" })}
            onLeave={() => conn.send({ type: "raceLeave" })}
          />
        )}
        {/* countdown + live standings while any race runs; the scoreboard pops
            at our finish (live) or the race's end (final) and stays until CLOSE */}
        <RaceHud
          conn={conn}
          racing={racing}
          selfGate={raceGate}
          goAt={raceGoAt}
          onQuit={quitRace}
        />
        {raceBoardOpen && (
          <RaceResults
            conn={conn}
            results={raceResults}
            selfId={conn.selfId}
            onClose={() => closeBoard("race")}
          />
        )}
        {/* blasters lobby panel while seated at its holotable (shuttle blasters feature) */}
        {inBlastLobby && !conn.blast.playing && (
          <BlastPanel
            conn={conn}
            onReady={(on) => conn.send({ type: "blastReady", on })}
            onStart={() => conn.send({ type: "blastStart" })}
            onLeave={() => conn.send({ type: "blastLeave" })}
          />
        )}
        {/* countdown + who's-alive board while any match runs; the scoreboard
            pops at our elimination (live) or the match's end (final) and stays
            until CLOSE */}
        <BlastHud
          conn={conn}
          blasting={blasting}
          goAt={blastGoAt}
          onQuit={quitBlast}
        />
        {blastBoardOpen && (
          <BlastResults
            conn={conn}
            results={blastResults}
            selfId={conn.selfId}
            onClose={() => closeBoard("blast")}
          />
        )}
        {/* the space link overlay: traversal for everyone, management for the
            home creator at home (space link feature) */}
        {linkOpen && linkState && (
          <SpaceLinkPanel
            state={linkState}
            currentSlug={conn.workspace?.slug ?? ""}
            error={linkError}
            send={(msg) => {
              setLinkError(null);
              conn.send(msg);
            }}
            onClose={() => {
              setLinkOpen(false);
              setLinkError(null);
            }}
          />
        )}
        {/* the meeting overlay replaces the tiles row while it's up (notes/003) */}
        {!meeting && (
          <Tiles
            conn={conn}
            peers={peersRef.current}
            localStream={mediaRef.current.stream}
            zoneId={selfZoneId}
          />
        )}
        {/* OS blocked the capture: name the switch to flip; click dismisses (notes/003) */}
        {shareBlocked && (
          <div
            onClick={() => setShareBlocked(false)}
            style={{
              position: "fixed",
              left: "50%",
              transform: "translateX(-50%)",
              bottom: 130,
              zIndex: 35,
              maxWidth: "min(560px, calc(100vw - 40px))",
              padding: "10px 16px",
              borderRadius: 10,
              background: "rgba(10,15,28,.95)",
              border: "1px solid rgba(255,77,77,.5)",
              color: "var(--danger)",
              font: "600 10.5px var(--font-mono)",
              letterSpacing: "0.1em",
              lineHeight: 1.6,
              textAlign: "center",
              cursor: "pointer",
              animation: "toastin .25s ease",
            }}
          >
            SCREEN CAPTURE BLOCKED BY THE SYSTEM — ALLOW THIS BROWSER UNDER
            PRIVACY &amp; SECURITY › SCREEN RECORDING, THEN RELAUNCH THE BROWSER
          </div>
        )}
        {/* all-hands announcement banner: prominent, top center, click to
            dismiss early (notes/010) */}
        {announce && (
          <div
            key={announce.n}
            onClick={() => setAnnounce(null)}
            style={{
              position: "fixed",
              left: "50%",
              transform: "translateX(-50%)",
              top: 64,
              zIndex: 36,
              maxWidth: "min(640px, calc(100vw - 40px))",
              padding: "12px 20px",
              borderRadius: 12,
              background: "rgba(10,15,28,.96)",
              border: "1px solid var(--accent)",
              boxShadow:
                "0 10px 36px rgba(0,0,0,.55), 0 0 24px rgba(62,224,138,.15)",
              cursor: "pointer",
              animation: "toastin .25s ease",
              textAlign: "center",
            }}
          >
            <div
              style={{
                font: "600 9.5px var(--font-mono)",
                letterSpacing: "0.24em",
                color: "var(--accent)",
                marginBottom: 4,
              }}
            >
              ALL HANDS · {announce.name.toUpperCase()}
            </div>
            <div
              style={{
                font: "500 13.5px var(--font-sans)",
                lineHeight: 1.45,
                overflowWrap: "anywhere",
              }}
            >
              {announce.text}
            </div>
          </div>
        )}
        {/* someone waved: toast their name; the canvas ring shows where (notes/004) */}
        {wave && (
          <div
            key={wave.n}
            style={{
              position: "fixed",
              left: "50%",
              transform: "translateX(-50%)",
              bottom: 140,
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
            {wave.name.toUpperCase()} WAVED AT YOU
          </div>
        )}
        {/* map editor overlay, owner-only (notes/010 map editor); keyed so a
            saved (or remotely changed) layout reopens from the fresh map */}
        {editorOpen && conn.map && (
          <MapEditor
            key={`editor-${mapVersion}`}
            map={conn.map}
            onSave={(m) => conn.send({ type: "editMap", map: m })}
            onClose={() => setEditorOpen(false)}
          />
        )}
        {/* decor tray + the picked prop's clear-away popup (notes/017) */}
        {decorOpen && (
          <DecorPanel
            armed={decorKind}
            onArm={setDecorKind}
            scale={decorScale}
            onScale={setDecorScale}
            color={decorColor}
            onColor={setDecorColor}
            onClose={() => setDecorOpen(false)}
          />
        )}
        {decorOpen && decorPick && (
          <div
            style={{
              position: "fixed",
              left: "50%",
              transform: "translateX(-50%)",
              bottom: 140,
              zIndex: 27,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px 8px 14px",
              borderRadius: 12,
              background: "var(--surface-bg)",
              // accent ring + glow, not another dim surface: the popup has to
              // read as "this prop is selected" the instant it appears
              border: "1px solid var(--accent)",
              backdropFilter: "blur(14px)",
              boxShadow:
                "0 0 0 4px var(--accent-faint), 0 0 30px var(--accent-faint), 0 18px 44px rgba(0,0,0,.55)",
              animation: "pickpop .28s ease",
            }}
          >
            <span
              style={{
                font: "600 10.5px var(--font-mono)",
                letterSpacing: "0.12em",
                color: "var(--accent)",
              }}
            >
              {itemLabel(decorPick.kind)}
            </span>
            <span
              style={{
                font: "500 9px var(--font-mono)",
                color: "var(--text-dim)",
              }}
            >
              DRAG TO MOVE
            </span>
            {/* resizing this prop: the canvas follows the thumb, the resize is
                sent once the thumb is let go, so a drag is one db write */}
            <div style={{ width: 150 }}>
              <SizeSlider
                scale={pickScale ?? decorPick.scale}
                label="SIZE"
                onChange={(scale) => {
                  setPickScale(scale);
                  stageRef.current?.setItemScalePreview({
                    id: decorPick.id,
                    scale,
                  });
                }}
                onCommit={(scale) =>
                  conn.send({ type: "scaleItem", id: decorPick.id, scale })
                }
              />
            </div>
            {/* recoloring this prop, on the same preview-then-commit contract
                as the size slider: the wheel repaints the canvas as it is
                dragged and the recolor is sent once, when it settles */}
            <div style={{ width: 168 }}>
              <ColorPicker
                color={pickColor === undefined ? decorPick.color : pickColor}
                label="COLOR"
                enabled={itemIsColorable(decorPick.kind)}
                onChange={(color) => {
                  setPickColor(color);
                  stageRef.current?.setItemColorPreview({
                    id: decorPick.id,
                    color,
                  });
                }}
                onCommit={(color) =>
                  conn.send({ type: "colorItem", id: decorPick.id, color })
                }
              />
            </div>
            {/* stacking: props draw back-to-front by the deck point they stand
                on, so a monitor set on a meeting table is covered by it. These
                nudge this prop's sort key without moving it — a crewmate
                walking past still covers it, since the nudge is bounded */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  font: "600 9px var(--font-mono)",
                  letterSpacing: "0.14em",
                  color: "var(--text-dim)",
                }}
              >
                STACK
              </span>
              {(
                [
                  {
                    label: "BACK",
                    step: -ITEM_DEPTH_STEP,
                    tip: "Send this prop behind the ones it overlaps",
                  },
                  {
                    label: "FRONT",
                    step: ITEM_DEPTH_STEP,
                    tip: "Bring this prop in front of the ones it overlaps",
                  },
                ] as const
              ).map(({ label, step, tip }) => {
                const depth = clampItemDepth(decorPick.depth + step);
                // already as far as the nudge goes in that direction
                const stuck = depth === decorPick.depth;
                return (
                  <button
                    key={label}
                    className="hud-media-btn"
                    disabled={stuck}
                    onClick={() =>
                      conn.send({ type: "raiseItem", id: decorPick.id, depth })
                    }
                    title={
                      stuck
                        ? `This prop is as far ${label.toLowerCase()} as it goes`
                        : tip
                    }
                    style={{
                      height: 30,
                      padding: "0 10px",
                      borderRadius: 8,
                      border: "1px solid var(--surface-border)",
                      background: "rgba(255,255,255,.04)",
                      color: stuck ? "var(--text-dim)" : "var(--text)",
                      font: "600 10px var(--font-mono)",
                      letterSpacing: "0.1em",
                      cursor: stuck ? "default" : "pointer",
                      opacity: stuck ? 0.45 : 1,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* two-click confirm, like the release-pod button: no accidents */}
            <button
              className="hud-media-btn"
              onClick={() => {
                if (!deleteArmed) {
                  setDeleteArmed(true);
                  return;
                }
                conn.send({ type: "deleteItem", id: decorPick.id });
                stageRef.current?.clearDecorSelection();
              }}
              style={{
                height: 30,
                padding: "0 12px",
                borderRadius: 8,
                border: `1px solid ${deleteArmed ? "var(--danger)" : "var(--surface-border)"}`,
                background: deleteArmed
                  ? "rgba(255,138,138,.12)"
                  : "rgba(255,255,255,.04)",
                color: deleteArmed ? "var(--danger)" : "var(--text)",
                font: "600 10px var(--font-mono)",
                letterSpacing: "0.1em",
                cursor: "pointer",
              }}
            >
              {deleteArmed ? "SURE?" : "DELETE"}
            </button>
            <button
              className="hud-zoom-btn"
              onClick={() => stageRef.current?.clearDecorSelection()}
              title="Leave it where it is"
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
        )}
        {/* pod/map rejection notice (notes/009) */}
        {decorNotice && (
          <div
            key={decorNotice.n}
            style={{
              position: "fixed",
              left: "50%",
              transform: "translateX(-50%)",
              bottom: 180,
              zIndex: 26,
              padding: "9px 16px",
              borderRadius: 10,
              background: "rgba(10,15,28,.92)",
              border: "1px solid rgba(255,180,84,.45)",
              color: "var(--dot-busy)",
              font: "600 10.5px var(--font-mono)",
              letterSpacing: "0.14em",
              animation: "toastin .25s ease",
            }}
          >
            {decorNotice.text}
          </div>
        )}
        {meeting && selfZoneId !== null && (
          <MeetingView
            conn={conn}
            peers={peersRef.current}
            localStream={mediaRef.current.stream}
            localScreen={screenRef.current?.stream ?? null}
            zoneId={selfZoneId}
            onClose={() => setMeeting(false)}
          />
        )}
        <Hud
          conn={conn}
          media={mediaRef.current}
          zoneId={selfZoneId}
          flying={flying}
          racing={racing}
          blasting={blasting}
          sharing={sharing}
          shareLocked={shareLocked}
          onToggleShare={toggleShare}
          meeting={meeting}
          onToggleMeeting={() => setMeeting((m) => !m)}
          status={selfStatus}
          onSetStatus={setStatus}
          decorOpen={decorOpen}
          onToggleDecor={() => setDecorOpen((v) => !v)}
          onEmote={(emote) => stageRef.current?.sendEmote(emote)}
          onLocate={(id) => stageRef.current?.locate(id)}
          selfUserId={selfUserId}
          visiting={conn.visiting}
          onBanVisitor={(userId) => void banVisitor(userId)}
          owner={conn.owner}
          onOpenEditor={() => setEditorOpen(true)}
          onClaimPod={(zoneId) =>
            connRef.current?.send({ type: "claimPod", zoneId })
          }
          onReleasePod={() => connRef.current?.send({ type: "releasePod" })}
          onMediaChanged={mediaChanged}
          onZoomIn={() => stageRef.current?.zoomIn()}
          onZoomOut={() => stageRef.current?.zoomOut()}
          onRecenter={() => stageRef.current?.recenter()}
          onExit={exit}
        />
        {/* away popup (notes/010): while away the camera, mic, incoming audio,
            and movement are all off, but the room stays visible around it. the
            backdrop is click-through so the user can still look around; only the
            card is interactive — picking a status re-enables media (App gates it) */}
        {selfStatus === "away" && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                pointerEvents: "auto",
                width: "min(360px, calc(100vw - 40px))",
                padding: 28,
                borderRadius: 16,
                // opaque so the room doesn't bleed through the popup (the
                // shared --surface-bg is only 86% opaque)
                background: "rgb(10,15,28)",
                border: "1px solid var(--surface-border)",
                boxShadow: "0 20px 56px rgba(0,0,0,.6)",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  font: "600 11px var(--font-mono)",
                  letterSpacing: "0.24em",
                  color: "var(--text-dim)",
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: "var(--dot-off)",
                  }}
                />
                YOU ARE AWAY
              </div>
              <div
                style={{
                  marginTop: 12,
                  font: "500 12.5px var(--font-sans)",
                  lineHeight: 1.55,
                  color: "var(--text-dim)",
                }}
              >
                Your camera, microphone, and audio are off. Pick a status to
                rejoin the room.
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
                <button
                  className="hud-media-btn"
                  onClick={() => setStatus("available")}
                  style={{
                    flex: 1,
                    height: 40,
                    borderRadius: 10,
                    border: "1px solid var(--accent-dim)",
                    background: "var(--accent-faint)",
                    color: "var(--accent)",
                    font: "600 10px var(--font-mono)",
                    letterSpacing: "0.12em",
                    cursor: "pointer",
                  }}
                >
                  AVAILABLE
                </button>
                <button
                  className="hud-media-btn"
                  onClick={() => setStatus("busy")}
                  style={{
                    flex: 1,
                    height: 40,
                    borderRadius: 10,
                    border: "1px solid rgba(255,180,84,.45)",
                    background: "rgba(255,180,84,.1)",
                    color: "var(--dot-busy)",
                    font: "600 10px var(--font-mono)",
                    letterSpacing: "0.12em",
                    cursor: "pointer",
                  }}
                >
                  BUSY
                </button>
              </div>
              {/* leave the ship entirely, same as the toolbar EXIT (notes/010) */}
              <button
                className="hud-media-btn"
                onClick={exit}
                style={{
                  width: "100%",
                  height: 36,
                  marginTop: 10,
                  borderRadius: 10,
                  border: "1px solid rgba(255,77,77,.35)",
                  background: "rgba(255,77,77,.08)",
                  color: "var(--danger)",
                  font: "600 10px var(--font-mono)",
                  letterSpacing: "0.12em",
                  cursor: "pointer",
                }}
              >
                EXIT SHIP
              </button>
            </div>
          </div>
        )}
      </>
    );
  }
  // dropped mid-session: hold the route and auto-reconnect while the retry loop
  // runs. a prominent red screen with a live countdown warns the user; when it
  // hits 0 the loop's deadline has passed and we fall back to the join card (step 5.2)
  if (phase === "resuming") {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            padding: "22px 34px",
            borderRadius: 14,
            background: "rgba(255,77,77,.08)",
            border: "2px solid var(--danger)",
            boxShadow: "0 0 40px rgba(255,77,77,.25)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            animation: "tilein .25s ease",
          }}
        >
          <div
            style={{
              font: "700 15px var(--font-mono)",
              letterSpacing: "0.28em",
              color: "var(--danger)",
            }}
          >
            SIGNAL LOST · RECONNECTING
          </div>
          <div
            style={{
              font: "700 40px var(--font-mono)",
              lineHeight: 1,
              color: "var(--danger)",
            }}
          >
            {resumeSecondsLeft}
          </div>
          <div
            style={{
              font: "500 10.5px var(--font-mono)",
              letterSpacing: "0.16em",
              color: "var(--danger)",
              opacity: 0.75,
            }}
          >
            LEAVING WORKSPACE AT 0
          </div>
        </div>
      </div>
    );
  }
  return (
    <JoinScreen
      slug={slug}
      busy={phase === "connecting"}
      notice={notice}
      requestable={requestable}
      onJoin={join}
      onBack={toPicker}
    />
  );
}

// full-viewport overlay shared by the picker and the join screen (notes/006)
const screenOverlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background:
    "radial-gradient(ellipse at 50% 42%,rgba(10,16,32,.55),rgba(5,7,13,.9))",
  backdropFilter: "blur(2.5px)",
} as const;

// card chrome shared by the picker and the join screen (notes/006)
const cardStyle = {
  width: 380,
  maxWidth: "calc(100vw - 40px)",
  background: "var(--card-bg)",
  border: "1px solid rgba(120,150,200,.18)",
  borderRadius: 16,
  padding: 28,
  boxShadow: "0 30px 80px rgba(0,0,0,.6)",
} as const;

// small mono action button on a picker row or member row; armed = the
// two-click confirm state, open = the members panel toggle while expanded
function rowButtonStyle(state: "idle" | "armed" | "open") {
  return {
    flex: "none",
    padding: "3px 8px",
    borderRadius: 6,
    border: `1px solid ${state === "armed" ? "rgba(255,77,77,.5)" : state === "open" ? "var(--accent-dim)" : "rgba(120,150,200,.22)"}`,
    background: "transparent",
    cursor: "pointer",
    font: "600 9px var(--font-mono)",
    letterSpacing: "0.1em",
    color:
      state === "armed"
        ? "var(--danger)"
        : state === "open"
          ? "var(--accent)"
          : "rgba(160,180,210,.55)",
  } as const;
}

// member panel chrome (notes/008)
const panelLabelStyle = {
  font: "600 9px var(--font-mono)",
  letterSpacing: "0.16em",
  color: "rgba(160,180,210,.55)",
} as const;

const memberRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
} as const;

const memberNameStyle = {
  fontSize: 12.5,
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

// account email under the name, smaller and muted; absent for accounts
// without one
const memberEmailStyle = {
  fontSize: 10.5,
  color: "rgba(160,180,210,.55)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

// name + optional email stacked on the left of a member row; minWidth lets
// both lines ellipsize instead of pushing the action button out
function MemberIdentity(props: { name: string; email?: string }) {
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={memberNameStyle}>{props.name}</div>
      {props.email && <div style={memberEmailStyle}>{props.email}</div>}
    </div>
  );
}

// typed member-action rejections as the panel shows them (notes/008)
function memberActionError(
  reason: "unauthorized" | "notFound" | "notCreator" | "isCreator",
): string {
  return reason === "notFound"
    ? "workspace is gone — refresh to update the list"
    : reason === "notCreator"
      ? "only the creator can manage members"
      : reason === "isCreator"
        ? "the creator can't be removed"
        : "authorization failed — sign in again";
}

// typed invite/join-request rejections as the picker and panel show them (notes/015)
function inviteActionError(reason: InviteReason): string {
  switch (reason) {
    case "notFound":
      return "that's gone — refresh to update the list";
    case "notCreator":
      return "only the creator can do that";
    case "removed":
      return "that account was removed from the workspace";
    case "alreadyMember":
      return "already a member";
    case "full":
      return "the workspace is full — 20 member limit";
    default:
      return "authorization failed — sign in again";
  }
}

// workspace picker at / (notes/006): signed-in accounts see their workspaces
// (from membership) and a create form; signed-out sees clerk's sign-in card
function PickerScreen(props: { onOpen: (slug: string) => void }) {
  return (
    <div style={screenOverlayStyle}>
      <SignedOut>
        <SignIn />
      </SignedOut>
      <SignedIn>
        <PickerCard onOpen={props.onOpen} />
      </SignedIn>
    </div>
  );
}

// the signed-in picker card; separate from PickerScreen so its clerk hooks
// only run with a session present (notes/006)
function PickerCard(props: { onOpen: (slug: string) => void }) {
  const { getToken } = useAuth();
  const { user } = useUser();
  // null while the list request is in flight
  const [workspaces, setWorkspaces] = useState<WorkspaceListEntry[] | null>(
    null,
  );
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // delete flow (notes/007): the first click arms a row (SURE?), the second
  // deletes; clicking another row's delete re-arms there instead
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // member management (notes/008): one owned row's panel open at a time; the
  // panel holds both lists, a two-click arm for REMOVE, and one busy id
  const [membersSlug, setMembersSlug] = useState<string | null>(null);
  const [memberData, setMemberData] = useState<MemberList | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [confirmMemberId, setConfirmMemberId] = useState<string | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  // which panel the in-flight list fetch belongs to, so a slow reply can't
  // render under a different row after a quick toggle
  const membersReqRef = useRef<string | null>(null);
  // pending invites for this account's email + its own join requests (notes/015);
  // null while the request is in flight
  const [pending, setPending] = useState<PendingLists | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  // one invite/request row action in flight at a time, keyed by slug
  const [busyPendingSlug, setBusyPendingSlug] = useState<string | null>(null);
  // request-to-join-by-name form (notes/015 Q7)
  const [requestName, setRequestName] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  // member modal invite form + pending-row actions (notes/015)
  const [inviteEmail, setInviteEmail] = useState("");
  const [sendingInvite, setSendingInvite] = useState(false);
  const [busyInviteEmail, setBusyInviteEmail] = useState<string | null>(null);

  // load the membership list and the pending invites/requests once; each
  // request carries a fresh token (notes/006, notes/015). The two fail
  // independently — a broken pending fetch must not blank the workspace list
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let token: string | null = null;
      try {
        token = await getToken();
        if (!token) throw new Error("no clerk session");
        const list = await listWorkspaces(WS_URL, token);
        if (!cancelled) setWorkspaces(list);
      } catch {
        if (!cancelled)
          setListError("could not load your workspaces — refresh to retry");
      }
      if (token === null) return;
      try {
        const lists = await listPending(WS_URL, token);
        if (!cancelled) setPending(lists);
      } catch {
        if (!cancelled)
          setPendingError("could not load your invites — refresh to retry");
      }
    })();
    return () => {
      cancelled = true;
    };
    // mount-only: one fetch per picker visit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const token = await getToken();
      if (!token) {
        setCreateError("sign-in expired — sign in again");
        return;
      }
      const result = await createWorkspace(WS_URL, token, trimmed);
      if (!result.ok) {
        setCreateError(
          result.reason === "slugTaken"
            ? "that name's link is taken — pick another"
            : result.reason === "invalidName"
              ? "the name needs at least one letter or number"
              : result.reason === "limitReached"
                ? "workspace limit reached (5) — delete one first"
                : "authorization failed — sign in again",
        );
        return;
      }
      // straight aboard: the creator lands on the new workspace's board card
      props.onOpen(result.workspace.slug);
    } catch {
      setCreateError("could not reach the server — try again");
    } finally {
      setCreating(false);
    }
  }

  // delete one of this account's workspaces; the server kicks anyone still
  // aboard and the row leaves the list on success (notes/007)
  async function remove(slug: string): Promise<void> {
    if (deletingSlug !== null) return;
    if (confirmSlug !== slug) {
      setConfirmSlug(slug);
      return;
    }
    setDeletingSlug(slug);
    setDeleteError(null);
    try {
      const token = await getToken();
      if (!token) {
        setDeleteError("sign-in expired — sign in again");
        return;
      }
      const result = await deleteWorkspace(WS_URL, token, slug);
      if (!result.ok) {
        setDeleteError(
          result.reason === "notFound"
            ? "already gone — refresh to update the list"
            : result.reason === "notCreator"
              ? "only the creator can delete a workspace"
              : "authorization failed — sign in again",
        );
        return;
      }
      setWorkspaces((ws) => ws?.filter((w) => w.slug !== slug) ?? ws);
    } catch {
      setDeleteError("could not reach the server — try again");
    } finally {
      setDeletingSlug(null);
      setConfirmSlug(null);
    }
  }

  // open an owned row's member modal; opening fetches both lists (notes/008)
  async function openMembers(slug: string): Promise<void> {
    setConfirmMemberId(null);
    setMemberError(null);
    setMemberData(null);
    setInviteEmail("");
    setMembersSlug(slug);
    membersReqRef.current = slug;
    try {
      const token = await getToken();
      if (!token) throw new Error("no clerk session");
      const list = await listMembers(WS_URL, token, slug);
      if (membersReqRef.current === slug) setMemberData(list);
    } catch {
      if (membersReqRef.current === slug)
        setMemberError("could not load members — try again");
    }
  }

  // close the member modal (backdrop click or the CLOSE button)
  function closeMembers(): void {
    membersReqRef.current = null;
    setMembersSlug(null);
    setMemberData(null);
    setMemberError(null);
    setConfirmMemberId(null);
    setInviteEmail("");
    setBusyInviteEmail(null);
  }

  // remove (ban) a member: first click arms the row (SURE?), the second sends;
  // the server kicks them if aboard and blocks rejoins until unbanned (notes/008)
  async function removeMemberRow(
    slug: string,
    member: MemberEntry,
  ): Promise<void> {
    if (busyMemberId !== null) return;
    if (confirmMemberId !== member.id) {
      setConfirmMemberId(member.id);
      return;
    }
    setBusyMemberId(member.id);
    setMemberError(null);
    try {
      const token = await getToken();
      if (!token) {
        setMemberError("sign-in expired — sign in again");
        return;
      }
      const result = await removeMember(WS_URL, token, slug, member.id);
      if (!result.ok) {
        setMemberError(memberActionError(result.reason));
        return;
      }
      // the row moves to the removed list, where UNBAN lives
      setMemberData(
        (d) =>
          d && {
            ...d,
            members: d.members.filter((m) => m.id !== member.id),
            banned: [...d.banned, { ...member, creator: false }],
          },
      );
    } catch {
      setMemberError("could not reach the server — try again");
    } finally {
      setBusyMemberId(null);
      setConfirmMemberId(null);
    }
  }

  // lift a ban; the row leaves the removed list — rejoining happens via the
  // workspace link, taking a free member slot like anyone else (notes/008)
  async function unbanMemberRow(
    slug: string,
    member: MemberEntry,
  ): Promise<void> {
    if (busyMemberId !== null) return;
    setBusyMemberId(member.id);
    setMemberError(null);
    try {
      const token = await getToken();
      if (!token) {
        setMemberError("sign-in expired — sign in again");
        return;
      }
      const result = await unbanMember(WS_URL, token, slug, member.id);
      if (!result.ok) {
        setMemberError(memberActionError(result.reason));
        return;
      }
      setMemberData(
        (d) =>
          d && { ...d, banned: d.banned.filter((m) => m.id !== member.id) },
      );
    } catch {
      setMemberError("could not reach the server — try again");
    } finally {
      setBusyMemberId(null);
    }
  }

  // drop one pending row client-side after it resolved (notes/015); accepting
  // also clears a matching join request — the server deleted both artifacts
  function dropPending(
    kind: "invites" | "requests" | "both",
    slug: string,
  ): void {
    setPending(
      (p) =>
        p && {
          invites:
            kind === "requests"
              ? p.invites
              : p.invites.filter((w) => w.slug !== slug),
          requests:
            kind === "invites"
              ? p.requests
              : p.requests.filter((w) => w.slug !== slug),
        },
    );
  }

  // accept an invite: the membership lands and the workspace joins the list —
  // boarding stays a separate click, like any listed workspace (notes/015 Q3)
  async function acceptInviteRow(w: WorkspaceInfo): Promise<void> {
    if (busyPendingSlug !== null) return;
    setBusyPendingSlug(w.slug);
    setPendingError(null);
    try {
      const token = await getToken();
      if (!token) {
        setPendingError("sign-in expired — sign in again");
        return;
      }
      const result = await acceptInvite(WS_URL, token, w.slug);
      if (!result.ok) {
        if (result.reason === "notFound") {
          // the invite was cancelled (or the workspace deleted) under us
          dropPending("invites", w.slug);
          setPendingError("that invite is no longer available");
        } else {
          setPendingError(
            result.reason === "removed"
              ? "you were removed from this workspace"
              : inviteActionError(result.reason),
          );
        }
        return;
      }
      dropPending("both", w.slug);
      setWorkspaces((ws) =>
        ws === null || ws.some((x) => x.slug === w.slug)
          ? ws
          : [{ slug: w.slug, name: w.name, mine: false }, ...ws],
      );
    } catch {
      setPendingError("could not reach the server — try again");
    } finally {
      setBusyPendingSlug(null);
    }
  }

  // decline an invite: the pending row goes away, nothing else changes (notes/015)
  async function declineInviteRow(w: WorkspaceInfo): Promise<void> {
    if (busyPendingSlug !== null) return;
    setBusyPendingSlug(w.slug);
    setPendingError(null);
    try {
      const token = await getToken();
      if (!token) {
        setPendingError("sign-in expired — sign in again");
        return;
      }
      const result = await declineInvite(WS_URL, token, w.slug);
      // notFound just means it already resolved — the row leaves either way
      if (result.ok || result.reason === "notFound")
        dropPending("invites", w.slug);
      else setPendingError(inviteActionError(result.reason));
    } catch {
      setPendingError("could not reach the server — try again");
    } finally {
      setBusyPendingSlug(null);
    }
  }

  // withdraw one of this account's own join requests (notes/015)
  async function cancelRequestRow(w: WorkspaceInfo): Promise<void> {
    if (busyPendingSlug !== null) return;
    setBusyPendingSlug(w.slug);
    setPendingError(null);
    try {
      const token = await getToken();
      if (!token) {
        setPendingError("sign-in expired — sign in again");
        return;
      }
      const result = await cancelRequest(WS_URL, token, w.slug);
      if (result.ok || result.reason === "notFound")
        dropPending("requests", w.slug);
      else setPendingError(inviteActionError(result.reason));
    } catch {
      setPendingError("could not reach the server — try again");
    } finally {
      setBusyPendingSlug(null);
    }
  }

  // petition to join a workspace by its typed name; the server resolves it
  // through the same slug derivation as creation (notes/015 Q7)
  async function requestByName(): Promise<void> {
    const trimmed = requestName.trim();
    if (trimmed === "" || requesting) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const token = await getToken();
      if (!token) {
        setRequestError("sign-in expired — sign in again");
        return;
      }
      const result = await requestJoin(WS_URL, token, trimmed);
      if (!result.ok) {
        setRequestError(
          result.reason === "notFound"
            ? "no workspace by that name"
            : result.reason === "alreadyMember"
              ? "you're already a member — it's in your list"
              : result.reason === "removed"
                ? "you were removed from that workspace"
                : inviteActionError(result.reason),
        );
        return;
      }
      setRequestName("");
      // re-requesting is idempotent server-side; keep the list deduped too
      setPending(
        (p) =>
          p && {
            invites: p.invites,
            requests: p.requests.some((r) => r.slug === result.workspace.slug)
              ? p.requests
              : [result.workspace, ...p.requests],
          },
      );
    } catch {
      setRequestError("could not reach the server — try again");
    } finally {
      setRequesting(false);
    }
  }

  // send an invite from the member modal to one email address (notes/015)
  async function sendInviteRow(slug: string): Promise<void> {
    const email = inviteEmail.trim().toLowerCase();
    if (email === "" || sendingInvite) return;
    setSendingInvite(true);
    setMemberError(null);
    try {
      const token = await getToken();
      if (!token) {
        setMemberError("sign-in expired — sign in again");
        return;
      }
      const result = await sendInvite(WS_URL, token, slug, email);
      if (!result.ok) {
        setMemberError(
          result.reason === "removed"
            ? "that account was removed — unban it first"
            : result.reason === "alreadyMember"
              ? "that account is already a member"
              : inviteActionError(result.reason),
        );
        return;
      }
      setInviteEmail("");
      setMemberData(
        (d) =>
          d && {
            ...d,
            invites: d.invites.includes(email)
              ? d.invites
              : [...d.invites, email],
          },
      );
    } catch {
      setMemberError("could not reach the server — try again");
    } finally {
      setSendingInvite(false);
    }
  }

  // cancel a pending invite from the member modal; idempotent (notes/015)
  async function cancelInviteRow(slug: string, email: string): Promise<void> {
    if (busyInviteEmail !== null) return;
    setBusyInviteEmail(email);
    setMemberError(null);
    try {
      const token = await getToken();
      if (!token) {
        setMemberError("sign-in expired — sign in again");
        return;
      }
      const result = await cancelInvite(WS_URL, token, slug, email);
      if (!result.ok) {
        setMemberError(inviteActionError(result.reason));
        return;
      }
      setMemberData(
        (d) => d && { ...d, invites: d.invites.filter((e) => e !== email) },
      );
    } catch {
      setMemberError("could not reach the server — try again");
    } finally {
      setBusyInviteEmail(null);
    }
  }

  // adjudicate a join request from the member modal (notes/015): approve
  // creates the membership (bans + cap checked now), deny removes the row
  async function decideRequestRow(
    slug: string,
    member: MemberEntry,
    approve: boolean,
  ): Promise<void> {
    if (busyMemberId !== null) return;
    setBusyMemberId(member.id);
    setMemberError(null);
    try {
      const token = await getToken();
      if (!token) {
        setMemberError("sign-in expired — sign in again");
        return;
      }
      const result = approve
        ? await approveRequest(WS_URL, token, slug, member.id)
        : await denyRequest(WS_URL, token, slug, member.id);
      if (!result.ok) {
        if (result.reason === "notFound") {
          // the request was withdrawn under us — the row leaves either way
          setMemberData(
            (d) =>
              d && {
                ...d,
                requests: d.requests.filter((r) => r.id !== member.id),
              },
          );
          setMemberError("that request was withdrawn");
        } else {
          setMemberError(
            result.reason === "removed"
              ? "that account was removed — unban it first"
              : inviteActionError(result.reason),
          );
        }
        return;
      }
      // approval also resolved any invite to the same account's email
      const email = (member.email ?? "").toLowerCase();
      setMemberData(
        (d) =>
          d && {
            members: approve ? [...d.members, member] : d.members,
            banned: d.banned,
            invites:
              approve && email !== ""
                ? d.invites.filter((e) => e !== email)
                : d.invites,
            requests: d.requests.filter((r) => r.id !== member.id),
          },
      );
    } catch {
      setMemberError("could not reach the server — try again");
    } finally {
      setBusyMemberId(null);
    }
  }

  return (
    <div style={cardStyle}>
      <div
        style={{
          font: "600 10.5px var(--font-mono)",
          letterSpacing: "0.24em",
          color: "var(--accent)",
        }}
      >
        BLIP-A · WORKSPACES
      </div>
      <h1
        style={{
          margin: "10px 0 6px",
          fontSize: 25,
          fontWeight: 700,
          letterSpacing: "-0.01em",
        }}
      >
        Pick a workspace
      </h1>
      <p
        style={{
          margin: "0 0 18px",
          fontSize: 13,
          lineHeight: 1.5,
          color: "rgba(170,190,215,.65)",
        }}
      >
        Each workspace is its own ship: separate crew, separate comms. Boarding
        takes an invite from the workspace&rsquo;s creator, or an approved join
        request.
      </p>
      {/* signed-in account chip, same as the board card (notes/005) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(120,150,200,.22)",
          background: "rgba(255,255,255,.04)",
        }}
      >
        <UserButton />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {user?.fullName ?? user?.username ?? "Signed in"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "rgba(160,180,210,.55)",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {user?.primaryEmailAddress?.emailAddress}
          </div>
        </div>
      </div>
      {/* pending invites for this account's email: accept creates the
          membership, decline just clears the row (notes/015) */}
      {(pendingError !== null ||
        (pending !== null && pending.invites.length > 0)) && (
        <>
          <div
            style={{
              font: "600 10px var(--font-mono)",
              letterSpacing: "0.18em",
              color: "rgba(160,180,210,.55)",
            }}
          >
            INVITES
          </div>
          <div
            style={{
              margin: "8px 0 16px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {pendingError && (
              <div
                style={{
                  font: "600 10px var(--font-mono)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--danger)",
                }}
              >
                {pendingError}
              </div>
            )}
            {pending?.invites.map((w) => (
              <div
                key={w.slug}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--accent-dim)",
                  background: "rgba(255,255,255,.04)",
                }}
              >
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {w.name}
                </span>
                <button
                  type="button"
                  disabled={busyPendingSlug !== null}
                  onClick={() => void acceptInviteRow(w)}
                  style={{
                    ...rowButtonStyle("open"),
                    cursor: busyPendingSlug !== null ? "default" : "pointer",
                  }}
                >
                  {busyPendingSlug === w.slug ? "…" : "ACCEPT"}
                </button>
                <button
                  type="button"
                  disabled={busyPendingSlug !== null}
                  onClick={() => void declineInviteRow(w)}
                  style={{
                    ...rowButtonStyle("idle"),
                    cursor: busyPendingSlug !== null ? "default" : "pointer",
                  }}
                >
                  DECLINE
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {/* this account's own pending join requests, cancellable (notes/015) */}
      {pending !== null && pending.requests.length > 0 && (
        <>
          <div
            style={{
              font: "600 10px var(--font-mono)",
              letterSpacing: "0.18em",
              color: "rgba(160,180,210,.55)",
            }}
          >
            YOUR JOIN REQUESTS
          </div>
          <div
            style={{
              margin: "8px 0 16px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {pending.requests.map((w) => (
              <div
                key={w.slug}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(120,150,200,.22)",
                  background: "rgba(255,255,255,.04)",
                }}
              >
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {w.name}
                </span>
                <span
                  style={{
                    font: "500 9.5px var(--font-mono)",
                    letterSpacing: "0.1em",
                    color: "rgba(160,180,210,.55)",
                    flex: "none",
                  }}
                >
                  PENDING
                </span>
                <button
                  type="button"
                  disabled={busyPendingSlug !== null}
                  onClick={() => void cancelRequestRow(w)}
                  style={{
                    ...rowButtonStyle("idle"),
                    cursor: busyPendingSlug !== null ? "default" : "pointer",
                  }}
                >
                  {busyPendingSlug === w.slug ? "…" : "CANCEL"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {/* your workspaces, newest membership first; links double as shareable URLs */}
      <div
        style={{
          font: "600 10px var(--font-mono)",
          letterSpacing: "0.18em",
          color: "rgba(160,180,210,.55)",
        }}
      >
        YOUR WORKSPACES
      </div>
      <div
        style={{
          margin: "8px 0 16px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {listError && (
          <div
            style={{
              font: "600 10px var(--font-mono)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--danger)",
            }}
          >
            {listError}
          </div>
        )}
        {deleteError && (
          <div
            style={{
              font: "600 10px var(--font-mono)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--danger)",
            }}
          >
            {deleteError}
          </div>
        )}
        {workspaces === null && !listError && (
          <div style={{ fontSize: 12, color: "rgba(160,180,210,.5)" }}>
            Loading…
          </div>
        )}
        {workspaces !== null && workspaces.length === 0 && (
          <div style={{ fontSize: 12, color: "rgba(160,180,210,.5)" }}>
            None yet — create one below, or open a link a colleague shared.
          </div>
        )}
        {workspaces?.map((w) => (
          <a
            key={w.slug}
            href={`/w/${w.slug}`}
            onClick={(e) => {
              // same-app navigation: swap the route without a full reload
              e.preventDefault();
              props.onOpen(w.slug);
            }}
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(120,150,200,.22)",
              background: "rgba(255,255,255,.04)",
              color: "var(--text)",
              textDecoration: "none",
            }}
          >
            {/* nowrap: two row buttons can squeeze the name — truncate, don't wrap (notes/008) */}
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {w.name}
            </span>
            <span
              style={{
                font: "500 10px var(--font-mono)",
                letterSpacing: "0.08em",
                color: "rgba(160,180,210,.55)",
                flex: "none",
              }}
            >
              /w/{w.slug}
            </span>
            {/* creator-only member management modal (notes/008) */}
            {w.mine && (
              <button
                type="button"
                onClick={(e) => {
                  // the row is a link; opening the modal must not navigate
                  e.preventDefault();
                  e.stopPropagation();
                  void openMembers(w.slug);
                }}
                style={rowButtonStyle(membersSlug === w.slug ? "open" : "idle")}
              >
                MEMBERS
              </button>
            )}
            {/* creator-only delete; armed rows ask once more before the request (notes/007) */}
            {w.mine && (
              <button
                type="button"
                disabled={deletingSlug !== null}
                onClick={(e) => {
                  // the row is a link; deleting must not navigate
                  e.preventDefault();
                  e.stopPropagation();
                  void remove(w.slug);
                }}
                style={{
                  ...rowButtonStyle(confirmSlug === w.slug ? "armed" : "idle"),
                  cursor: deletingSlug !== null ? "default" : "pointer",
                }}
              >
                {deletingSlug === w.slug
                  ? "DELETING…"
                  : confirmSlug === w.slug
                    ? "SURE?"
                    : "DELETE"}
              </button>
            )}
          </a>
        ))}
      </div>
      {/* create form: name in, server derives the slug (notes/006) */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div
          style={{
            font: "600 10px var(--font-mono)",
            letterSpacing: "0.18em",
            color: "rgba(160,180,210,.55)",
          }}
        >
          NEW WORKSPACE
        </div>
        {createError && (
          <div
            style={{
              margin: "8px 0 0",
              font: "600 10px var(--font-mono)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--danger)",
            }}
          >
            {createError}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="Workspace name"
            style={{
              flex: 1,
              minWidth: 0,
              height: 44,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid rgba(120,150,200,.22)",
              background: "rgba(255,255,255,.04)",
              color: "var(--text)",
              fontSize: 13.5,
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={creating || name.trim() === ""}
            style={{
              height: 44,
              padding: "0 16px",
              borderRadius: 10,
              border: "none",
              cursor: creating || name.trim() === "" ? "default" : "pointer",
              font: "600 11.5px var(--font-mono)",
              letterSpacing: "0.12em",
              background:
                creating || name.trim() === ""
                  ? "rgba(255,255,255,.07)"
                  : "var(--accent)",
              color:
                creating || name.trim() === ""
                  ? "rgba(200,215,235,.35)"
                  : "var(--bg)",
              transition: "all .2s",
              flex: "none",
            }}
          >
            CREATE
          </button>
        </div>
      </form>
      {/* request to join a workspace by its name; the server resolves the name
          the same way creation derives slugs (notes/015) */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void requestByName();
        }}
        style={{ marginTop: 16 }}
      >
        <div
          style={{
            font: "600 10px var(--font-mono)",
            letterSpacing: "0.18em",
            color: "rgba(160,180,210,.55)",
          }}
        >
          REQUEST TO JOIN
        </div>
        {requestError && (
          <div
            style={{
              margin: "8px 0 0",
              font: "600 10px var(--font-mono)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--danger)",
            }}
          >
            {requestError}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            value={requestName}
            onChange={(e) => setRequestName(e.target.value)}
            maxLength={40}
            placeholder="Workspace name"
            style={{
              flex: 1,
              minWidth: 0,
              height: 44,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid rgba(120,150,200,.22)",
              background: "rgba(255,255,255,.04)",
              color: "var(--text)",
              fontSize: 13.5,
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={requesting || requestName.trim() === ""}
            style={{
              height: 44,
              padding: "0 16px",
              borderRadius: 10,
              border: "1px solid rgba(120,150,200,.22)",
              cursor:
                requesting || requestName.trim() === "" ? "default" : "pointer",
              font: "600 11.5px var(--font-mono)",
              letterSpacing: "0.12em",
              background: "rgba(255,255,255,.04)",
              color:
                requesting || requestName.trim() === ""
                  ? "rgba(200,215,235,.35)"
                  : "var(--text)",
              transition: "all .2s",
              flex: "none",
            }}
          >
            REQUEST
          </button>
        </div>
      </form>
      {/* member management modal: members with REMOVE, removed users with
          UNBAN — creator-only, one open at a time; backdrop or CLOSE dismisses (notes/008) */}
      {membersSlug !== null && (
        <div
          onClick={closeMembers}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
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
              ...cardStyle,
              width: 340,
              padding: 20,
              maxHeight: "min(70vh, 560px)",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div
                style={{
                  font: "600 10.5px var(--font-mono)",
                  letterSpacing: "0.2em",
                  color: "var(--accent)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {(
                  workspaces?.find((w) => w.slug === membersSlug)?.name ??
                  membersSlug
                ).toUpperCase()}
              </div>
              <button
                type="button"
                onClick={closeMembers}
                style={rowButtonStyle("idle")}
              >
                CLOSE
              </button>
            </div>
            {memberError && (
              <div
                style={{
                  font: "600 10px var(--font-mono)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--danger)",
                }}
              >
                {memberError}
              </div>
            )}
            {memberData === null && !memberError && (
              <div style={{ fontSize: 12, color: "rgba(160,180,210,.5)" }}>
                Loading…
              </div>
            )}
            {memberData && (
              <>
                {/* the cap is server-enforced; 20 mirrors MAX_MEMBERS_PER_WORKSPACE */}
                <div style={panelLabelStyle}>
                  MEMBERS · {memberData.members.length}/20
                </div>
                {memberData.members.map((m) => (
                  <div key={m.id} style={memberRowStyle}>
                    <MemberIdentity name={m.name} email={m.email} />
                    {m.creator ? (
                      <span style={{ ...panelLabelStyle, flex: "none" }}>
                        OWNER
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busyMemberId !== null}
                        onClick={() => void removeMemberRow(membersSlug, m)}
                        style={{
                          ...rowButtonStyle(
                            confirmMemberId === m.id ? "armed" : "idle",
                          ),
                          cursor: busyMemberId !== null ? "default" : "pointer",
                        }}
                      >
                        {busyMemberId === m.id
                          ? "REMOVING…"
                          : confirmMemberId === m.id
                            ? "SURE?"
                            : "REMOVE"}
                      </button>
                    )}
                  </div>
                ))}
                {memberData.banned.length > 0 && (
                  <>
                    <div style={{ ...panelLabelStyle, marginTop: 4 }}>
                      REMOVED
                    </div>
                    {memberData.banned.map((m) => (
                      <div key={m.id} style={memberRowStyle}>
                        <MemberIdentity name={m.name} email={m.email} />
                        <button
                          type="button"
                          disabled={busyMemberId !== null}
                          onClick={() => void unbanMemberRow(membersSlug, m)}
                          style={{
                            ...rowButtonStyle("idle"),
                            cursor:
                              busyMemberId !== null ? "default" : "pointer",
                          }}
                        >
                          {busyMemberId === m.id ? "UNBANNING…" : "UNBAN"}
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {/* pending join requests: approve admits (bans + cap checked
                    now), deny clears the row (notes/015) */}
                {memberData.requests.length > 0 && (
                  <>
                    <div style={{ ...panelLabelStyle, marginTop: 4 }}>
                      JOIN REQUESTS
                    </div>
                    {memberData.requests.map((m) => (
                      <div key={m.id} style={memberRowStyle}>
                        <MemberIdentity name={m.name} email={m.email} />
                        <button
                          type="button"
                          disabled={busyMemberId !== null}
                          onClick={() =>
                            void decideRequestRow(membersSlug, m, true)
                          }
                          style={{
                            ...rowButtonStyle("open"),
                            cursor:
                              busyMemberId !== null ? "default" : "pointer",
                          }}
                        >
                          {busyMemberId === m.id ? "…" : "APPROVE"}
                        </button>
                        <button
                          type="button"
                          disabled={busyMemberId !== null}
                          onClick={() =>
                            void decideRequestRow(membersSlug, m, false)
                          }
                          style={{
                            ...rowButtonStyle("idle"),
                            cursor:
                              busyMemberId !== null ? "default" : "pointer",
                          }}
                        >
                          DENY
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {/* pending invites this creator sent, cancellable (notes/015) */}
                {memberData.invites.length > 0 && (
                  <>
                    <div style={{ ...panelLabelStyle, marginTop: 4 }}>
                      PENDING INVITES
                    </div>
                    {memberData.invites.map((email) => (
                      <div key={email} style={memberRowStyle}>
                        <div
                          style={{ ...memberEmailStyle, minWidth: 0, flex: 1 }}
                        >
                          {email}
                        </div>
                        <button
                          type="button"
                          disabled={busyInviteEmail !== null}
                          onClick={() =>
                            void cancelInviteRow(membersSlug, email)
                          }
                          style={{
                            ...rowButtonStyle("idle"),
                            cursor:
                              busyInviteEmail !== null ? "default" : "pointer",
                          }}
                        >
                          {busyInviteEmail === email ? "…" : "CANCEL"}
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {/* invite by email — the only address a creator can know for
                    someone who never signed in (notes/015, ADR 0003) */}
                <div style={{ ...panelLabelStyle, marginTop: 4 }}>
                  INVITE BY EMAIL
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendInviteRow(membersSlug);
                  }}
                  style={{ display: "flex", gap: 6 }}
                >
                  <input
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    type="email"
                    maxLength={254}
                    placeholder="crew@example.com"
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
                    disabled={sendingInvite || inviteEmail.trim() === ""}
                    style={{
                      ...rowButtonStyle("open"),
                      height: 34,
                      cursor:
                        sendingInvite || inviteEmail.trim() === ""
                          ? "default"
                          : "pointer",
                    }}
                  >
                    {sendingInvite ? "SENDING…" : "SEND"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// join screen styled per the prototype card (step 4.3); identity now comes
// from clerk — signed out shows the sign-in card, signed in shows the board
// card with the account chip (notes/005). Labeled with the route's workspace
// slug — the real name arrives with the welcome (notes/006)
function JoinScreen(props: {
  slug: string;
  busy: boolean;
  notice: string | null;
  // a notMember rejection landed: offer request-to-join in place (notes/015)
  requestable: boolean;
  onJoin: (req: JoinRequest) => void;
  // back to the picker — where workspaces are listed and created (notes/007)
  onBack: () => void;
}) {
  // requested toggles; join() acquires devices from these (step 3.1)
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  // clerk account, shown on the card so it's clear who is boarding
  const { user } = useUser();
  // request-to-join flow (notes/015): the slug is a fixed point of the
  // server's name→slug derivation, so it rides the requestJoin name field.
  // sent flips after this session's request lands; earlier requests are still
  // pending server-side (re-requesting is idempotent) and cancellable from
  // the picker
  const { getToken } = useAuth();
  const [reqBusy, setReqBusy] = useState(false);
  const [reqSent, setReqSent] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);

  async function sendJoinRequest(): Promise<void> {
    if (reqBusy) return;
    setReqBusy(true);
    setReqError(null);
    try {
      const token = await getToken();
      if (!token) {
        setReqError("sign-in expired — sign in again");
        return;
      }
      const result = await requestJoin(WS_URL, token, props.slug);
      if (!result.ok) {
        setReqError(
          result.reason === "alreadyMember"
            ? "you're already a member — board away"
            : result.reason === "removed"
              ? "you were removed from this workspace"
              : result.reason === "notFound"
                ? "workspace not found — check the link"
                : "authorization failed — sign in again",
        );
        return;
      }
      setReqSent(true);
    } catch {
      setReqError("could not reach the server — try again");
    } finally {
      setReqBusy(false);
    }
  }

  async function withdrawJoinRequest(): Promise<void> {
    if (reqBusy) return;
    setReqBusy(true);
    setReqError(null);
    try {
      const token = await getToken();
      if (!token) {
        setReqError("sign-in expired — sign in again");
        return;
      }
      const result = await cancelRequest(WS_URL, token, props.slug);
      if (!result.ok && result.reason !== "notFound") {
        setReqError("authorization failed — sign in again");
        return;
      }
      setReqSent(false);
    } catch {
      setReqError("could not reach the server — try again");
    } finally {
      setReqBusy(false);
    }
  }

  return (
    <div style={screenOverlayStyle}>
      {/* not signed in: clerk's sign-in/sign-up card replaces the board card */}
      <SignedOut>
        <SignIn />
      </SignedOut>
      <SignedIn>
        <form
          onSubmit={(e) => {
            // form submit covers both the button and Enter
            e.preventDefault();
            props.onJoin({ micOn, camOn });
          }}
          style={cardStyle}
        >
          {/* back to the picker: list, create, or delete workspaces (notes/007) */}
          <a
            href="/"
            onClick={(e) => {
              // same-app navigation: swap the route without a full reload
              e.preventDefault();
              props.onBack();
            }}
            style={{
              display: "inline-block",
              marginBottom: 14,
              font: "700 13px var(--font-mono)",
              letterSpacing: "0.18em",
              color: "rgba(200,215,235,.9)",
              textDecoration: "none",
            }}
          >
            ← ALL WORKSPACES
          </a>
          <div
            style={{
              font: "600 10.5px var(--font-mono)",
              letterSpacing: "0.24em",
              color: "var(--accent)",
            }}
          >
            BLIP-A · {props.slug.toUpperCase()}
          </div>
          <h1
            style={{
              margin: "10px 0 6px",
              fontSize: 25,
              fontWeight: 700,
              letterSpacing: "-0.01em",
            }}
          >
            Board the ship
          </h1>
          <p
            style={{
              margin: "0 0 18px",
              fontSize: 13,
              lineHeight: 1.5,
              color: "rgba(170,190,215,.65)",
            }}
          >
            One deck, zone-based comms. Walk into a zone to see and hear
            whoever&rsquo;s standing there. Step out to go private.
          </p>
          {/* why the user is back at the join screen (not in the prototype) */}
          {props.notice && (
            <p
              style={{
                margin: "0 0 16px",
                font: "600 10px var(--font-mono)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--danger)",
              }}
            >
              {props.notice}
            </p>
          )}
          {/* not a member: petition the creator from right here (notes/015) */}
          {props.requestable && (
            <div
              style={{
                marginBottom: 16,
                padding: "12px 14px",
                borderRadius: 10,
                border: "1px solid var(--accent-dim)",
                background: "var(--accent-faint)",
              }}
            >
              {reqError && (
                <div
                  style={{
                    marginBottom: 8,
                    font: "600 10px var(--font-mono)",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--danger)",
                  }}
                >
                  {reqError}
                </div>
              )}
              {reqSent ? (
                <>
                  <div
                    style={{
                      font: "600 10px var(--font-mono)",
                      letterSpacing: "0.14em",
                      color: "var(--accent)",
                    }}
                  >
                    REQUEST SENT — A CREATOR APPROVAL LETS YOU BOARD
                  </div>
                  <button
                    type="button"
                    disabled={reqBusy}
                    onClick={() => void withdrawJoinRequest()}
                    style={{
                      ...rowButtonStyle("idle"),
                      marginTop: 8,
                      cursor: reqBusy ? "default" : "pointer",
                    }}
                  >
                    {reqBusy ? "CANCELLING…" : "CANCEL REQUEST"}
                  </button>
                </>
              ) : (
                <>
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "rgba(170,190,215,.75)",
                    }}
                  >
                    Only members can board. Ask the workspace&rsquo;s creator to
                    let you in:
                  </div>
                  <button
                    type="button"
                    disabled={reqBusy}
                    onClick={() => void sendJoinRequest()}
                    style={{
                      ...rowButtonStyle("open"),
                      marginTop: 8,
                      cursor: reqBusy ? "default" : "pointer",
                    }}
                  >
                    {reqBusy ? "REQUESTING…" : "REQUEST TO JOIN"}
                  </button>
                </>
              )}
            </div>
          )}
          {/* signed-in account chip: clerk's user button (manage/sign out) + identity */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(120,150,200,.22)",
              background: "rgba(255,255,255,.04)",
            }}
          >
            <UserButton />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {user?.fullName ?? user?.username ?? "Signed in"}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(160,180,210,.55)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {user?.primaryEmailAddress?.emailAddress}
              </div>
            </div>
          </div>
          <ToggleRow
            title="Microphone"
            hint={micOn ? "Join with mic live" : "Join muted"}
            on={micOn}
            onToggle={() => setMicOn((v) => !v)}
            divider
          />
          <ToggleRow
            title="Camera"
            hint={camOn ? "Join with camera on" : "Join with camera off"}
            on={camOn}
            onToggle={() => setCamOn((v) => !v)}
          />
          {/* points at the crew locker; callsign + outfit live on the profile now (notes/005) */}
          <div
            style={{
              marginTop: 14,
              fontSize: 11,
              color: "rgba(160,180,210,.5)",
            }}
          >
            Customize your callsign and character from the toolbar once aboard.
          </div>
          <button
            type="submit"
            className="join-board-btn"
            disabled={props.busy}
            style={{
              marginTop: 20,
              width: "100%",
              height: 47,
              borderRadius: 11,
              border: "none",
              cursor: "pointer",
              font: "600 12.5px var(--font-mono)",
              letterSpacing: "0.18em",
              background: props.busy
                ? "rgba(255,255,255,.07)"
                : "var(--accent)",
              // ready text is dark-on-accent (prototype uses the page background color)
              color: props.busy ? "rgba(200,215,235,.35)" : "var(--bg)",
              transition: "all .2s",
            }}
          >
            BOARD SHIP →
          </button>
        </form>
      </SignedIn>
    </div>
  );
}

// labeled mic/cam switch row on the join card (prototype toggle switches)
function ToggleRow(props: {
  title: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
  // the mic row carries the between-rows divider
  divider?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: props.divider ? "14px 0 12px" : "12px 0 4px",
        borderBottom: props.divider
          ? "1px solid rgba(255,255,255,.06)"
          : "none",
        marginTop: props.divider ? 10 : 0,
      }}
    >
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{props.title}</div>
        <div
          style={{ fontSize: 11, color: "rgba(160,180,210,.55)", marginTop: 1 }}
        >
          {props.hint}
        </div>
      </div>
      {/* type=button so the switch never submits the surrounding form */}
      <button
        type="button"
        title={`Toggle ${props.title.toLowerCase()}`}
        onClick={props.onToggle}
        style={{
          width: 44,
          height: 25,
          borderRadius: 999,
          border: "none",
          cursor: "pointer",
          position: "relative",
          background: props.on
            ? "var(--accent-strong)"
            : "rgba(255,255,255,.14)",
          transition: "background .2s",
          flex: "none",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: props.on ? 22 : 3,
            width: 19,
            height: 19,
            borderRadius: "50%",
            background: "white",
            transition: "left .2s",
            boxShadow: "0 1px 3px rgba(0,0,0,.4)",
          }}
        />
      </button>
    </div>
  );
}
