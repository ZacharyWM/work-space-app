// webrtc peer manager (step 3.4): one RTCPeerConnection per active pair, driven
// by the shared peer state machine (3.2) — this is the impure layer that performs
// its emitted effects against real connections and relays SDP/ICE over `signal`
import { initialPeerPhase, transitionPeer, type PeerEvent, type PeerPhase } from "shared";
import { rtcConfig } from "./iceConfig";

// JSON-safe signaling payload carried opaquely in protocol `signal.data`.
// type aliases (not the DOM interfaces) so they satisfy the protocol's z.json() type
export type SignalPayload =
  | { kind: "description"; sdpType: "offer" | "answer"; sdp: string }
  | {
      kind: "candidate";
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    };

// one live pair: the machine phase plus the real connection it governs
type PeerEntry = {
  phase: PeerPhase;
  pc: RTCPeerConnection;
  // serializes async signaling work (offer/answer/candidates) in arrival order
  queue: Promise<void>;
  // hidden playback so remote audio is audible; 3.5's tiles render the video
  audio: HTMLAudioElement;
};

export class PeerManager {
  // remote media keyed by peer id; the 3.5 video tiles read this
  readonly remoteStreams = new Map<string, MediaStream>();

  // remote screen shares keyed by peer id; the meeting view reads this (notes/003)
  readonly remoteScreens = new Map<string, MediaStream>();

  private readonly entries = new Map<string, PeerEntry>();

  // the local display track while sharing; attached to every pair's screen m-line
  private screenTrack: MediaStreamTrack | null = null;

  // 'away' silences all remote playback locally; held so pairs formed while
  // away start muted too (notes/010 away popup)
  private outputMuted = false;

  constructor(
    // local tracks attached to every connection (a missing track offers recvonly)
    private readonly localStream: MediaStream,
    // sends `signal {to, data}` through the live socket
    private readonly sendSignal: (to: string, data: SignalPayload) => void,
    // fired when remoteStreams gains or loses an entry; the 3.5 tiles rerender on it
    private readonly onStreamsChanged?: () => void,
  ) {}

  // server directive `peerConnect`: open a connection
  connect(peerId: string, initiator: boolean): void {
    this.dispatch(peerId, { type: "connectRequested", initiator });
  }

  // server directive `peerDisconnect`: tear down
  disconnect(peerId: string): void {
    this.dispatch(peerId, { type: "disconnectRequested" });
  }

  // relayed SDP/ICE from a peer
  signal(from: string, data: unknown): void {
    this.dispatch(from, { type: "signalReceived", data });
  }

  // tear down every pair — socket drop and EXIT
  dispose(): void {
    for (const peerId of [...this.entries.keys()]) {
      this.dispatch(peerId, { type: "disconnectRequested" });
    }
  }

  // cam toggle (3.1): swap the stopped/re-acquired video track into every live
  // pair — plain replaceTrack, no renegotiation, because every video m-line is
  // negotiated send-capable even when the local track is missing
  setVideoTrack(track: MediaStreamTrack | null): void {
    for (const [peerId, entry] of this.entries) {
      const tx = entry.pc.getTransceivers().find((t) => t.receiver.track.kind === "video");
      tx?.sender
        .replaceTrack(track)
        .catch((err) => console.warn(`peer ${peerId} video track swap failed:`, err));
    }
  }

  // mic toggle / presence gate (3.1): same bare replaceTrack as setVideoTrack,
  // against the single audio m-line — the mic device is released when off and
  // re-acquired when on, so its track comes and goes mid-pair too
  setAudioTrack(track: MediaStreamTrack | null): void {
    for (const [peerId, entry] of this.entries) {
      const tx = entry.pc.getTransceivers().find((t) => t.receiver.track.kind === "audio");
      tx?.sender
        .replaceTrack(track)
        .catch((err) => console.warn(`peer ${peerId} audio track swap failed:`, err));
    }
  }

  // 'away' output gate (notes/010): mute or unmute every live peer's playback
  // so the away user hears nothing; the flag also seeds new entries
  setOutputMuted(muted: boolean): void {
    this.outputMuted = muted;
    for (const entry of this.entries.values()) entry.audio.muted = muted;
  }

  // share start/stop (notes/003): same replaceTrack pattern as setVideoTrack,
  // against the dedicated screen m-line; also held for pairs formed mid-share
  setScreenTrack(track: MediaStreamTrack | null): void {
    this.screenTrack = track;
    for (const [peerId, entry] of this.entries) {
      this.screenTransceiver(entry.pc)
        ?.sender.replaceTrack(track)
        .catch((err) => console.warn(`peer ${peerId} screen track swap failed:`, err));
    }
  }

  // the screen m-line is always the *second* video m-line: the initiator adds
  // it last in createEntry, and setRemoteDescription associates/creates the
  // answerer's transceivers in that same m-line order — so on both sides the
  // video transceivers order as [camera, screen] (notes/003)
  private screenTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | undefined {
    return pc.getTransceivers().filter((t) => t.receiver.track.kind === "video")[1];
  }

  // feed one event through the pure machine and perform its emitted effects
  private dispatch(peerId: string, event: PeerEvent): void {
    const before = this.entries.get(peerId);
    const { phase, effects } = transitionPeer(before?.phase ?? initialPeerPhase, event);
    for (const effect of effects) {
      switch (effect.type) {
        case "createConnection":
          this.entries.set(peerId, this.createEntry(peerId, effect.initiator));
          break;
        case "deliverSignal": {
          const entry = this.entries.get(peerId);
          if (!entry) break;
          const payload = parseSignalPayload(effect.data);
          if (!payload) {
            console.warn(`peer ${peerId}: malformed signal payload, dropped`);
            break;
          }
          this.enqueue(peerId, entry, () => this.applySignal(peerId, entry.pc, payload));
          break;
        }
        case "closeConnection": {
          const entry = this.entries.get(peerId);
          if (!entry) break;
          // detach handlers so a closing connection can't dispatch stale events
          entry.pc.onicecandidate = null;
          entry.pc.ontrack = null;
          entry.pc.onconnectionstatechange = null;
          entry.pc.close();
          entry.audio.pause();
          entry.audio.srcObject = null;
          this.entries.delete(peerId);
          // drop both surfaces; one notification covers the pair (notes/003)
          const hadStream = this.remoteStreams.delete(peerId);
          const hadScreen = this.remoteScreens.delete(peerId);
          if (hadStream || hadScreen) this.onStreamsChanged?.();
          break;
        }
      }
    }
    // a deleted entry *is* the disconnected phase; only live entries carry one
    const live = this.entries.get(peerId);
    if (live) live.phase = phase;
  }

  // build the RTCPeerConnection for one pair; the initiator kicks off the offer
  private createEntry(peerId: string, initiator: boolean): PeerEntry {
    const pc = new RTCPeerConnection(rtcConfig());
    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    // the offer must carry an m-line per kind even when the local track is
    // missing (denied device, toggle off, or parked while alone) or the peer's
    // media could never flow back; the answerer's m-lines mirror the offer for
    // free. both kinds stay sendrecv so a later device re-acquire (mic on, cam
    // on, company arriving) is a bare replaceTrack, with no renegotiation
    if (initiator) {
      for (const kind of ["audio", "video"] as const) {
        if (!this.localStream.getTracks().some((t) => t.kind === kind)) {
          pc.addTransceiver(kind, { direction: "sendrecv" });
        }
      }
      // dedicated screen m-line, added last so it's the second video m-line on
      // both sides; carries the live display track when a pair forms mid-share,
      // and a later share start is a bare replaceTrack (notes/003)
      pc.addTransceiver(this.screenTrack ?? "video", { direction: "sendrecv" });
    }

    pc.onicecandidate = (ev) => {
      // null marks end-of-candidates; peers don't need the marker
      if (!ev.candidate) return;
      this.sendSignal(peerId, {
        kind: "candidate",
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      });
    };

    pc.ontrack = (ev) => {
      const entry = this.entries.get(peerId);
      // guard events from a connection already replaced or torn down
      if (entry?.pc !== pc) return;
      // the screen m-line's track renders on its own surface, never folded into
      // the camera/audio stream; roster screenOn gates its display (notes/003)
      if (ev.transceiver === this.screenTransceiver(pc)) {
        this.remoteScreens.set(peerId, new MediaStream([ev.track]));
        this.onStreamsChanged?.();
        return;
      }
      // fires once per track (audio + video); fold each into one stream we own
      // per peer — a video m-line negotiated while the sender's cam was off
      // carries no remote stream id, so ev.streams can't be trusted here
      let stream = this.remoteStreams.get(peerId);
      const first = stream === undefined;
      if (stream === undefined) {
        stream = new MediaStream();
        this.remoteStreams.set(peerId, stream);
      }
      stream.addTrack(ev.track);
      if (first) {
        entry.audio.srcObject = stream;
        entry.audio
          .play()
          .catch((err) => console.warn(`peer ${peerId} audio playback failed:`, err));
        this.onStreamsChanged?.();
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.entries.get(peerId)?.pc !== pc) return;
      // the 3.4 manual verify watches these logs (enter → connected, exit → teardown)
      console.log(`peer ${peerId} connectionState: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        this.dispatch(peerId, { type: "iceConnected" });
      } else if (pc.connectionState === "failed") {
        // `disconnected` can recover on its own; only `failed` is terminal.
        // no retry here — reconnection is server-driven pairing (3.3)
        this.dispatch(peerId, { type: "failed" });
      }
    };

    const audio = new Audio();
    // a pair formed while away must start silent (notes/010)
    audio.muted = this.outputMuted;
    const entry: PeerEntry = {
      phase: initialPeerPhase,
      pc,
      queue: Promise.resolve(),
      audio,
    };
    if (initiator) this.enqueue(peerId, entry, () => this.sendOffer(peerId, pc));
    return entry;
  }

  // chain async signaling onto the pair's queue; a step that throws fails the pair
  private enqueue(peerId: string, entry: PeerEntry, work: () => Promise<void>): void {
    entry.queue = entry.queue.then(work).catch((err) => {
      console.warn(`peer ${peerId} signaling failed:`, err);
      // only fail the pair this queue still governs, not a successor connection
      if (this.entries.get(peerId)?.pc === entry.pc) {
        this.dispatch(peerId, { type: "failed" });
      }
    });
  }

  private async sendOffer(peerId: string, pc: RTCPeerConnection): Promise<void> {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal(peerId, { kind: "description", sdpType: "offer", sdp: offer.sdp ?? "" });
  }

  // apply one relayed payload; answers an offer, absorbs an answer or candidate
  private async applySignal(
    peerId: string,
    pc: RTCPeerConnection,
    payload: SignalPayload,
  ): Promise<void> {
    // torn down (or replaced) while queued — drop, matching the machine's stale-signal rule
    if (this.entries.get(peerId)?.pc !== pc) return;
    if (payload.kind === "description") {
      await pc.setRemoteDescription({ type: payload.sdpType, sdp: payload.sdp });
      if (payload.sdpType === "offer") {
        // keep every m-line send-capable in the answer even without a local
        // track (device off or parked at pairing time) so a later mic/cam
        // re-acquire is a bare replaceTrack
        for (const t of pc.getTransceivers()) {
          if (t.direction === "recvonly") t.direction = "sendrecv";
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(peerId, { kind: "description", sdpType: "answer", sdp: answer.sdp ?? "" });
        // pair formed mid-share on the answering side: the offer created the
        // screen m-line, so attach the live display track to it now (notes/003)
        if (this.screenTrack) {
          await this.screenTransceiver(pc)?.sender.replaceTrack(this.screenTrack);
        }
      }
    } else {
      await pc.addIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
      });
    }
  }
}

// runtime guard for the opaque `signal.data`; malformed payloads are dropped
function parseSignalPayload(data: unknown): SignalPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (
    d.kind === "description" &&
    (d.sdpType === "offer" || d.sdpType === "answer") &&
    typeof d.sdp === "string"
  ) {
    return { kind: "description", sdpType: d.sdpType, sdp: d.sdp };
  }
  if (
    d.kind === "candidate" &&
    typeof d.candidate === "string" &&
    (typeof d.sdpMid === "string" || d.sdpMid === null) &&
    (typeof d.sdpMLineIndex === "number" || d.sdpMLineIndex === null)
  ) {
    return {
      kind: "candidate",
      candidate: d.candidate,
      sdpMid: d.sdpMid,
      sdpMLineIndex: d.sdpMLineIndex,
    };
  }
  return null;
}
