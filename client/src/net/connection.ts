// ws client wrapper: typed send/receive over the shared protocol, owns roster + self id (step 1.5)
import {
  decodeServerMessage,
  encodeMessage,
  type BlastArena,
  type BlastResult,
  type ChatMessage,
  type ClientMessage,
  type Emote,
  type IceServer,
  type Leaderboards,
  type MapData,
  type PlacedItem,
  type Player,
  type PodClaim,
  type Point,
  type RaceMember,
  type RaceResult,
  type RaceStart,
  type ServerMessage,
  type SpaceLinkState,
  type WorkspaceInfo,
} from "shared";

// client-side chat retention: the welcome's ship history plus everything
// received live this session; oldest rolls off past this (notes/010)
const CHAT_KEEP_MAX = 200;

// initial join payload gathered by the join screen; identity comes from the
// clerk session, not a typed name (notes/005)
export type JoinRequest = {
  micOn: boolean;
  camOn: boolean;
};

// the first message sent on open: a fresh join, or a grace-window resume (step 5.2)
export type InitialMessage = Extract<ClientMessage, { type: "join" | "resume" }>;

// why the server refused to board this connection (steps 5.1, 5.2)
export type RejectionReason = Extract<ServerMessage, { type: "joinRejected" }>["reason"];

// why the server ended an established session; the resume token is dead
// either way, so the client must not retry (notes/007)
export type KickReason = Extract<ServerMessage, { type: "kicked" }>["reason"];

// why a pod claim / release was refused (notes/009)
export type DecorRejection = Extract<ServerMessage, { type: "decorRejected" }>["reason"];

// why a place / move / delete of a prop was refused (notes/017)
export type ItemRejection = Extract<ServerMessage, { type: "itemRejected" }>["reason"];

// why an owner map edit was refused (notes/010 map editor)
export type MapRejection = Extract<ServerMessage, { type: "mapRejected" }>["reason"];

// why a link management action was refused (space link feature)
export type LinkRejection = Extract<ServerMessage, { type: "linkRejected" }>["reason"];

// why a portal traversal was refused (space link feature)
export type VisitRejection = Extract<ServerMessage, { type: "visitRejected" }>["reason"];

// why a shuttle race action was refused (shuttle race feature)
export type RaceRejection = Extract<ServerMessage, { type: "raceRejected" }>["reason"];

// the shuttle race as this client tracks it: the lobby (members), a running
// race (gates + live progress), and the finishers so far (shuttle race feature)
export type RaceView = {
  racing: boolean;
  members: RaceMember[];
  gates: Point[];
  // gates passed per still-running racer id (leaderboard)
  progress: Map<string, number>;
  // finishers in place order; name captured at finish time
  finishes: { id: string; name: string; place: number; timeMs: number }[];
};

const emptyRace = (): RaceView => ({
  racing: false,
  members: [],
  gates: [],
  progress: new Map(),
  finishes: [],
});

// why a shuttle blasters action was refused (shuttle blasters feature)
export type BlastRejection = Extract<ServerMessage, { type: "blastRejected" }>["reason"];

// shuttle blasters as this client tracks it: the lobby (members), a running
// match (arena + who's still flying), and the fallen so far, newest last
export type BlastView = {
  playing: boolean;
  members: RaceMember[];
  arena: BlastArena | null;
  // ids still flying
  alive: Set<string>;
  // destroyed (or forfeited) players in elimination order; names captured at
  // the moment they fell so the list survives departures
  eliminated: { id: string; name: string }[];
};

const emptyBlast = (): BlastView => ({
  playing: false,
  members: [],
  arena: null,
  alive: new Set(),
  eliminated: [],
});

const emptyLeaderboards = (): Leaderboards => ({ race: [], blast: [] });

// the message kinds that mutate the roster, passed to onRosterChange so
// consumers can ignore the high-rate `pos` stream (the canvas reads it per frame)
export type RosterChange =
  | "playerJoined"
  | "playerLeft"
  | "pos"
  | "mediaState"
  | "speaking"
  | "screenShare"
  | "character"
  | "status"
  | "rename"
  | "zoneChanged"
  | "ship"
  | "debriefEnded";

export type ConnectionHandlers = {
  // welcome received: selfId/map/roster are now populated
  onWelcome: () => void;
  // roster mutated after welcome (join/leave/pos/media/speaking/zone)
  onRosterChange: (change: RosterChange) => void;
  // the local player's zone changed — server-authoritative echo, drives the hud (step 2.3)
  onSelfZoneChanged?: (zoneId: string | null) => void;
  // another player's screen share flipped, after the roster entry was updated —
  // drives the auto-enter into meeting mode (notes/003)
  onScreenShare?: (id: string, on: boolean) => void;
  // someone waved at the local player — drives the chime/toast/ring (notes/004)
  onWave?: (from: string) => void;
  // a chat message arrived (self echo included), already appended to conn.chat —
  // drives the panel rerender + unread badge (notes/010)
  onChat?: (message: ChatMessage) => void;
  // another player emoted — drives the canvas bubble (notes/010)
  onEmote?: (id: string, emote: Emote) => void;
  // pods changed (claim/release) — the canvas reads the map per frame, react
  // needs a rerender for the hud/panel (notes/009)
  onDecorChange?: () => void;
  // a prop was placed, dragged, or cleared by anyone (us included) —
  // conn.items already holds the change (notes/017)
  onItemsChange?: () => void;
  // one of our own place/move/delete calls was refused; drives the toast
  onItemRejected?: (reason: ItemRejection) => void;
  // a pod action of ours was refused; drives the notice toast (notes/009)
  onDecorRejected?: (reason: DecorRejection) => void;
  // the workspace's map was replaced by an owner edit — conn.map/pods
  // already hold the new layout when this fires (notes/010 map editor)
  onMapChanged?: () => void;
  // our own map edit was refused; drives the notice toast (notes/010 map editor)
  onMapRejected?: (reason: MapRejection) => void;
  // the Space Link overlay's state arrived (requested at the portal, and
  // refreshed after every management action) — drives the overlay (space link)
  onSpaceLinkState?: (state: SpaceLinkState) => void;
  // one of our link management actions was refused; drives the overlay error
  onLinkRejected?: (reason: LinkRejection) => void;
  // one of our portal traversals was refused; drives the notice toast
  onVisitRejected?: (reason: VisitRejection) => void;
  // the race lobby, a racer's progress, or a quit changed — conn.race and the
  // roster are already updated; drives panel/leaderboard rerenders
  onRaceChange?: () => void;
  // the race started; selfStart is our grid slot when we're racing, null when
  // spectating — the stage boards the race shuttle from it
  onRaceStarted?: (selfStart: RaceStart | null) => void;
  // a racer crossed the last gate (self included — this carries our place)
  onRaceFinished?: (id: string, place: number, timeMs: number) => void;
  // the race is over; conn.race is already reset to the empty lobby
  onRaceEnded?: (results: RaceResult[]) => void;
  // a race action of ours was refused; drives the notice toast
  onRaceRejected?: (reason: RaceRejection) => void;
  // the blasters lobby or a quit changed — conn.blast and the roster are
  // already updated; drives panel/standings rerenders
  onBlastChange?: () => void;
  // the match started; selfStart is our spawn pose when we're fighting, null
  // when spectating — the stage boards the match shuttle from it
  onBlastStarted?: (selfStart: RaceStart | null) => void;
  // a player fired a laser bolt — the stage draws it from origin + heading
  onBlastFire?: (id: string, x: number, y: number, a: number) => void;
  // a shuttle was destroyed; x/y is where it was (for the explosion). Fires
  // for our own shuttle too — that's how we learn we're out
  onBlastEliminated?: (id: string, by: string, x: number, y: number) => void;
  // the match is over; conn.blast is already reset to the empty lobby
  onBlastEnded?: (results: BlastResult[]) => void;
  // a blasters action of ours was refused; drives the notice toast
  onBlastRejected?: (reason: BlastRejection) => void;
  // the persisted leaderboards changed (a race/match just ended) —
  // conn.leaderboards already holds the fresh lists; drives panel rerenders
  onLeaderboards?: () => void;
  // server pairing directives + relayed SDP/ICE, fed to the peer manager (step 3.4)
  onPeerConnect?: (peerId: string, initiator: boolean) => void;
  onPeerDisconnect?: (peerId: string) => void;
  onSignal?: (from: string, data: unknown) => void;
  // join or resume refused; the server closes the socket next (steps 5.1, 5.2)
  onJoinRejected?: (reason: RejectionReason) => void;
  // established session ended server-side (boarded elsewhere / workspace
  // deleted); the server closes the socket next — no resume (notes/007)
  onKicked?: (reason: KickReason) => void;
  // socket closed for any reason — caller returns to the join screen (fresh-join semantics)
  onClose: () => void;
};

export class Connection {
  private readonly socket: WebSocket;
  private readonly handlers: ConnectionHandlers;

  // populated by the welcome message; null until then
  selfId: string | null = null;
  map: MapData | null = null;
  // true when this account created the workspace — shows the map editor
  // entry point; the server re-checks every edit (notes/010 map editor)
  owner = false;
  // the room this session stands in — the visited workspace during a Visit
  // (space link feature); labels the hud (notes/006)
  workspace: WorkspaceInfo | null = null;
  // the session's home workspace: the one boarded via URL/picker. Equals
  // workspace except while visiting (space link feature, ADR 0004)
  home: WorkspaceInfo | null = null;
  // token that resumes this session within the grace window (step 5.2)
  resumeToken: string | null = null;
  // ICE servers minted for this session — STUN + optional TURN (step 5.4)
  iceServers: IceServer[] = [];
  // live roster keyed by player id, kept in sync by server messages
  readonly roster = new Map<string, Player>();
  // pod claims keyed by pod zone id, kept in sync by pod messages (notes/009)
  readonly pods = new Map<string, PodClaim>();
  // placed decor props keyed by id, insertion-ordered so everyone draws the
  // same z-order; seeded by the welcome, live-updated after (notes/017)
  readonly items = new Map<string, PlacedItem>();
  // chat this session can show, oldest first: the welcome's ship history plus
  // live messages (zone-scoped ones only ever arrive for our zone) (notes/010)
  readonly chat: ChatMessage[] = [];
  // the shuttle race lobby / running race, kept in sync by race messages
  race: RaceView = emptyRace();
  // the shuttle blasters lobby / running match, kept in sync by blast messages
  blast: BlastView = emptyBlast();
  // both games' persisted best scores, seeded by the welcome and replaced
  // whenever a race/match ends (leaderboard feature)
  leaderboards: Leaderboards = emptyLeaderboards();

  constructor(url: string, initial: InitialMessage, handlers: ConnectionHandlers) {
    this.handlers = handlers;
    this.socket = new WebSocket(url);
    // join or resume immediately on open; the server replies with welcome
    this.socket.onopen = () => this.send(initial);
    this.socket.onmessage = (ev) => this.handleMessage(String(ev.data));
    // fires for clean closes, drops, and failed connects alike
    this.socket.onclose = () => this.handlers.onClose();
  }

  // true while this session stands somewhere other than home — a Visit
  // (space link feature)
  get visiting(): boolean {
    return (
      this.home !== null &&
      this.workspace !== null &&
      this.home.slug !== this.workspace.slug
    );
  }

  // serialize + send one typed message; silently dropped if the socket isn't open
  send(msg: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(encodeMessage(msg));
    }
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(raw: string): void {
    // decode + validate; bad input is logged and dropped, never crashes
    let msg;
    try {
      msg = decodeServerMessage(raw);
    } catch (err) {
      console.warn(`dropped bad message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    switch (msg.type) {
      case "joinRejected":
        this.handlers.onJoinRejected?.(msg.reason);
        return;
      // session ended server-side; the close that follows must not resume (notes/007)
      case "kicked":
        this.handlers.onKicked?.(msg.reason);
        return;
      case "welcome": {
        this.selfId = msg.selfId;
        this.map = msg.map;
        this.owner = msg.owner;
        this.workspace = msg.workspace;
        this.home = msg.home;
        this.resumeToken = msg.resumeToken;
        this.iceServers = msg.iceServers;
        this.roster.clear();
        for (const player of msg.roster) this.roster.set(player.id, player);
        // pods arrive with the welcome and live-update after (notes/009)
        this.pods.clear();
        for (const pod of msg.pods) this.pods.set(pod.zoneId, pod);
        // props arrive with the welcome and live-update after (notes/017)
        this.items.clear();
        for (const item of msg.items) this.items.set(item.id, item);
        // ship chat history seeds the log; live messages append after (notes/010)
        this.chat.length = 0;
        this.chat.push(...msg.chat);
        // the race snapshot seeds lobby + gates; per-racer progress fills in live
        this.race = { ...emptyRace(), ...msg.race };
        // the blasters snapshot likewise; eliminations fill in live
        this.blast = { ...emptyBlast(), ...msg.blast };
        // best scores arrive whole and are replaced whole
        this.leaderboards = msg.leaderboards;
        this.handlers.onWelcome();
        return;
      }
      case "playerJoined":
        this.roster.set(msg.player.id, msg.player);
        break;
      case "playerLeft":
        this.roster.delete(msg.id);
        break;
      case "pos":
      case "mediaState":
      case "speaking":
      case "screenShare":
      case "character":
      case "status":
      case "rename":
      case "zoneChanged":
      case "ship":
      case "debriefEnded": {
        // field updates for an existing player; unknown ids are logged and dropped
        const player = this.roster.get(msg.id);
        if (!player) {
          console.warn(`${msg.type} for unknown player ${msg.id}, dropped`);
          return;
        }
        if (msg.type === "pos") {
          player.x = msg.x;
          player.y = msg.y;
          // shuttle heading, present only while the player is flying (notes/003)
          if (msg.a !== undefined) player.shipA = msg.a;
        } else if (msg.type === "ship") {
          player.shipPad = msg.pad;
        } else if (msg.type === "mediaState") {
          player.micOn = msg.micOn;
          player.camOn = msg.camOn;
        } else if (msg.type === "speaking") {
          player.speaking = msg.on;
        } else if (msg.type === "screenShare") {
          player.screenOn = msg.on;
          this.handlers.onScreenShare?.(msg.id, msg.on);
        } else if (msg.type === "character") {
          player.character = msg.character;
        } else if (msg.type === "status") {
          player.status = msg.status;
        } else if (msg.type === "rename") {
          player.name = msg.name;
        } else if (msg.type === "debriefEnded") {
          // their post-game scoreboard closed (or the next match reclaimed
          // the channel): they leave the game's comms group
          player.debrief = null;
        } else {
          player.zoneId = msg.zoneId;
          if (msg.id === this.selfId) this.handlers.onSelfZoneChanged?.(msg.zoneId);
        }
        break;
      }
      // a wave is an event, not roster state — hand off and return (notes/004)
      case "wave":
        this.handlers.onWave?.(msg.from);
        return;
      // chat appends to the log (echo included — the send has no local append),
      // rolling the oldest off past the cap (notes/010)
      case "chat":
        this.chat.push(msg.message);
        if (this.chat.length > CHAT_KEEP_MAX) this.chat.shift();
        this.handlers.onChat?.(msg.message);
        return;
      // an emote is an event like a wave — hand off and return (notes/010)
      case "emote":
        this.handlers.onEmote?.(msg.id, msg.emote);
        return;
      // pod claims mutate their own map, not the roster (notes/009)
      case "podClaimed":
        this.pods.set(msg.pod.zoneId, msg.pod);
        this.handlers.onDecorChange?.();
        return;
      case "podReleased":
        this.pods.delete(msg.zoneId);
        this.handlers.onDecorChange?.();
        return;
      case "decorRejected":
        this.handlers.onDecorRejected?.(msg.reason);
        return;
      // decor props: every client (the actor included) renders from these
      // broadcasts, so nothing is optimistic (notes/017)
      case "itemPlaced":
        this.items.set(msg.item.id, msg.item);
        this.handlers.onItemsChange?.();
        return;
      case "itemMoved": {
        const item = this.items.get(msg.id);
        if (item) this.items.set(msg.id, { ...item, x: msg.x, y: msg.y });
        this.handlers.onItemsChange?.();
        return;
      }
      case "itemScaled": {
        const item = this.items.get(msg.id);
        if (item) this.items.set(msg.id, { ...item, scale: msg.scale });
        this.handlers.onItemsChange?.();
        return;
      }
      case "itemColored": {
        const item = this.items.get(msg.id);
        if (item) this.items.set(msg.id, { ...item, color: msg.color });
        this.handlers.onItemsChange?.();
        return;
      }
      case "itemRaised": {
        const item = this.items.get(msg.id);
        if (item) this.items.set(msg.id, { ...item, depth: msg.depth });
        this.handlers.onItemsChange?.();
        return;
      }
      case "itemDeleted":
        this.items.delete(msg.id);
        this.handlers.onItemsChange?.();
        return;
      case "itemRejected":
        this.handlers.onItemRejected?.(msg.reason);
        return;
      // the map was replaced by an owner edit: swap layout + the pods the
      // edit may have pruned, then tell the app (notes/010 map editor)
      case "mapChanged": {
        this.map = msg.map;
        this.pods.clear();
        for (const pod of msg.pods) this.pods.set(pod.zoneId, pod);
        // the edit may have stranded props off the deck; the server already
        // pruned those, so replace the whole set (notes/017)
        this.items.clear();
        for (const item of msg.items) this.items.set(item.id, item);
        this.handlers.onMapChanged?.();
        return;
      }
      case "mapRejected":
        this.handlers.onMapRejected?.(msg.reason);
        return;
      // space link: overlay state + typed refusals (a successful visit
      // arrives as a fresh welcome instead)
      case "spaceLinkState":
        this.handlers.onSpaceLinkState?.(msg);
        return;
      case "linkRejected":
        this.handlers.onLinkRejected?.(msg.reason);
        return;
      case "visitRejected":
        this.handlers.onVisitRejected?.(msg.reason);
        return;
      // --- shuttle race (holotable game) ---
      case "raceLobby":
        this.race.members = msg.members;
        this.handlers.onRaceChange?.();
        return;
      case "raceStarted": {
        // gates + racers replace the lobby view; every racer's roster entry
        // flips to racing at its grid slot so the canvas shows the grid
        this.race.racing = true;
        this.race.gates = msg.gates;
        this.race.progress = new Map(msg.racers.map((r) => [r.id, 0]));
        this.race.finishes = [];
        let selfStart: RaceStart | null = null;
        for (const st of msg.racers) {
          const racer = this.roster.get(st.id);
          if (racer) {
            racer.racing = true;
            // racing supersedes any lingering debrief hold
            racer.debrief = null;
            racer.x = st.x;
            racer.y = st.y;
            racer.shipA = st.a;
          }
          if (st.id === this.selfId) selfStart = st;
        }
        this.handlers.onRaceStarted?.(selfStart);
        return;
      }
      case "raceProgress":
        this.race.progress.set(msg.id, msg.gate);
        this.handlers.onRaceChange?.();
        return;
      case "raceFinished": {
        // the finisher is back on foot but stays in race comms (the debrief)
        // while their scoreboard is up; their own client teleports home and
        // reports the position
        const finisher = this.roster.get(msg.id);
        if (finisher) {
          finisher.racing = false;
          finisher.debrief = "race";
        }
        this.race.progress.delete(msg.id);
        this.race.finishes.push({
          id: msg.id,
          name: finisher?.name ?? "?",
          place: msg.place,
          timeMs: msg.timeMs,
        });
        this.handlers.onRaceFinished?.(msg.id, msg.place, msg.timeMs);
        return;
      }
      case "raceLeft": {
        // a racer quit mid-race — back on foot, out of the standings
        const quitter = this.roster.get(msg.id);
        if (quitter) quitter.racing = false;
        this.race.progress.delete(msg.id);
        this.handlers.onRaceChange?.();
        return;
      }
      case "raceEnded":
        // everyone still flagged is back on foot but keeps race comms (the
        // debrief) while their scoreboard is up; the lobby resets empty
        for (const p of this.roster.values()) {
          if (p.racing) {
            p.racing = false;
            p.debrief = "race";
          }
        }
        this.race = emptyRace();
        this.handlers.onRaceEnded?.(msg.results);
        return;
      case "raceRejected":
        this.handlers.onRaceRejected?.(msg.reason);
        return;
      // --- shuttle blasters (holotable game) ---
      case "blastLobby":
        this.blast.members = msg.members;
        this.handlers.onBlastChange?.();
        return;
      case "blastStarted": {
        // arena + combatants replace the lobby view; every player's roster
        // entry flips to blasting at its spawn pose so the canvas shows the ring
        this.blast.playing = true;
        this.blast.arena = msg.arena;
        this.blast.alive = new Set(msg.players.map((p) => p.id));
        this.blast.eliminated = [];
        let selfStart: RaceStart | null = null;
        for (const st of msg.players) {
          const combatant = this.roster.get(st.id);
          if (combatant) {
            combatant.blasting = true;
            // fighting supersedes any lingering debrief hold
            combatant.debrief = null;
            combatant.x = st.x;
            combatant.y = st.y;
            combatant.shipA = st.a;
          }
          if (st.id === this.selfId) selfStart = st;
        }
        this.handlers.onBlastStarted?.(selfStart);
        return;
      }
      case "blastFire":
        // a bolt is an event like a wave — the stage simulates it locally
        this.handlers.onBlastFire?.(msg.id, msg.x, msg.y, msg.a);
        return;
      case "blastEliminated": {
        // the fallen player is back on foot; their own client teleports home
        // and reports the position. Capture where the shuttle was first — the
        // explosion renders there
        const victim = this.roster.get(msg.id);
        const at = { x: victim?.x ?? 0, y: victim?.y ?? 0 };
        // the fallen stay in match comms (the debrief) while their scoreboard is up
        if (victim) {
          victim.blasting = false;
          victim.debrief = "blast";
        }
        this.blast.alive.delete(msg.id);
        this.blast.eliminated.push({ id: msg.id, name: victim?.name ?? "?" });
        this.handlers.onBlastEliminated?.(msg.id, msg.by, at.x, at.y);
        return;
      }
      case "blastLeft": {
        // a player quit mid-match — a forfeit, no explosion
        const quitter = this.roster.get(msg.id);
        if (quitter) quitter.blasting = false;
        this.blast.alive.delete(msg.id);
        this.blast.eliminated.push({ id: msg.id, name: quitter?.name ?? "?" });
        this.handlers.onBlastChange?.();
        return;
      }
      case "blastEnded":
        // everyone still flagged is back on foot but keeps match comms (the
        // debrief) while their scoreboard is up; the lobby resets empty
        for (const p of this.roster.values()) {
          if (p.blasting) {
            p.blasting = false;
            p.debrief = "blast";
          }
        }
        this.blast = emptyBlast();
        this.handlers.onBlastEnded?.(msg.results);
        return;
      case "blastRejected":
        this.handlers.onBlastRejected?.(msg.reason);
        return;
      case "leaderboards":
        // a race/match just ended somewhere aboard — replace both lists whole
        this.leaderboards = { race: msg.race, blast: msg.blast };
        this.handlers.onLeaderboards?.();
        return;
      // peer directives and signaling don't touch the roster — hand off and return
      case "peerConnect":
        this.handlers.onPeerConnect?.(msg.peerId, msg.initiator);
        return;
      case "peerDisconnect":
        this.handlers.onPeerDisconnect?.(msg.peerId);
        return;
      case "signal":
        this.handlers.onSignal?.(msg.from, msg.data);
        return;
      // picker replies belong to the pre-join helper socket (notes/006); on a
      // boarded connection they mean nothing — drop them
      case "workspaceList":
      case "workspaceCreated":
      case "createRejected":
      case "workspaceDeleted":
      case "deleteRejected":
      case "memberList":
      case "memberRemoved":
      case "memberUnbanned":
      case "memberRejected":
      case "inviteSent":
      case "inviteCancelled":
      case "inviteAccepted":
      case "inviteDeclined":
      case "inviteRejected":
      case "requestSent":
      case "requestCancelled":
      case "requestApproved":
      case "requestDenied":
      case "requestRejected":
      case "pendingList":
        console.warn(`${msg.type} on a boarded connection, dropped`);
        return;
    }
    this.handlers.onRosterChange(msg.type);
  }
}
