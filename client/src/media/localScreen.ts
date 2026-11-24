// local screen capture (notes/003): getDisplayMedia lifecycle for the SHARE
// toggle. video only — system audio capture is flaky across platforms, and the
// zone's voice already flows through the mic path. the browser's own "stop
// sharing" bar ends the capture through track.onended, same as the toggle.
export class LocalScreen {
  // fired on capture start (track) and stop (null); App swaps it into the
  // peers' screen m-lines and tells the room, mirroring LocalMedia.onVideoTrack
  onTrack: ((track: MediaStreamTrack | null) => void) | null = null;

  // fired when the OS (not the user) refused the capture — e.g. macOS with the
  // browser missing the Screen Recording permission; App surfaces a hint,
  // because the picker can never succeed until it's granted and relaunched
  onBlocked: (() => void) | null = null;

  // wraps the live display track for the local meeting-view preview
  stream: MediaStream | null = null;

  private track: MediaStreamTrack | null = null;
  // true while the browser's picker is up; extra SHARE clicks must not stack
  // concurrent getDisplayMedia calls (each one re-prompts the OS on macOS)
  private pending = false;

  // whether this browser/context can capture a display at all
  static supported(): boolean {
    return typeof navigator.mediaDevices?.getDisplayMedia === "function";
  }

  get on(): boolean {
    return this.track !== null;
  }

  // pick-and-capture; never throws — a deny/cancel just stays off (the same
  // rule LocalMedia.acquire follows for devices)
  async start(): Promise<void> {
    if (this.track || this.pending) return;
    this.pending = true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      this.track = track;
      this.stream = stream;
      // the browser's stop-sharing bar ends the track outside our UI
      track.onended = () => this.stop();
      this.onTrack?.(track);
    } catch (err) {
      console.warn("screen capture unavailable:", err);
      // chrome words an OS-level refusal as "Permission denied by system",
      // distinct from the user cancelling the picker (plain "Permission denied")
      if (err instanceof DOMException && err.name === "NotAllowedError" && /system/i.test(err.message)) {
        this.onBlocked?.();
      }
    } finally {
      this.pending = false;
    }
  }

  // stop + drop the capture; safe to call when not sharing (zone exits call it
  // unconditionally)
  stop(): void {
    if (!this.track) return;
    this.track.onended = null;
    this.track.stop();
    this.track = null;
    this.stream = null;
    this.onTrack?.(null);
  }

  // release the capture on exit and socket close
  dispose(): void {
    this.stop();
  }
}
