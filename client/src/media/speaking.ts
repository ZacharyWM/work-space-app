// speaking detection: AnalyserNode on the local mic, RMS vs threshold with a
// hold time; emits boolean changes only — the change-plus-hold cadence is the
// send throttle (step 3.6)

// polled RMS above this counts as speech; below it, room hum and mic noise
const RMS_THRESHOLD = 0.04;
// speaking stays on until the signal has been below threshold this long,
// so inter-word gaps don't flicker the indicator
const HOLD_MS = 400;
// poll cadence; with network relay this keeps remote indicators inside ~200ms
const POLL_MS = 80;
// ~21ms window at 48kHz — enough samples for a stable RMS per poll
const FFT_SIZE = 1024;

export class SpeakingDetector {
  private readonly ctx: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private readonly timer: ReturnType<typeof setInterval>;
  private speaking = false;
  // timestamp of the last above-threshold poll; drives the hold window
  private lastAbove = 0;

  // null when the stream has no mic track (denied, absent, mic off, or parked
  // alone — App disposes and recreates the detector as the track comes and goes)
  static create(
    stream: MediaStream,
    onChange: (on: boolean) => void,
  ): SpeakingDetector | null {
    const track = stream.getAudioTracks()[0];
    if (!track) return null;
    return new SpeakingDetector(stream, track, onChange);
  }

  private constructor(
    stream: MediaStream,
    private readonly track: MediaStreamTrack,
    private readonly onChange: (on: boolean) => void,
  ) {
    this.ctx = new AudioContext();
    // the context may start suspended despite the join click; resume is async
    // and safe to fire-and-forget — polls just read silence until it lands
    void this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.timer = setInterval(this.poll, POLL_MS);
  }

  private poll = (): void => {
    const now = performance.now();
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    const rms = Math.sqrt(sum / this.buf.length);
    // track.enabled read directly each poll: muting kills speaking on the next
    // poll with no wiring to the hud (a disabled track also renders silence)
    const live = this.track.enabled;
    const above = live && rms >= RMS_THRESHOLD;
    if (above) this.lastAbove = now;
    const next = above || (this.speaking && live && now - this.lastAbove < HOLD_MS);
    if (next !== this.speaking) {
      this.speaking = next;
      this.onChange(next);
    }
  };

  // stop polling and release the audio graph; used on exit and socket close
  dispose(): void {
    clearInterval(this.timer);
    this.source.disconnect();
    void this.ctx.close();
  }
}
