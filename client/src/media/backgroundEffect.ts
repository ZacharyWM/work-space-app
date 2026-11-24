// background effect processor: runs the local camera track through MediaPipe
// selfie segmentation and composites each frame onto a canvas, then captures the
// canvas back as a MediaStreamTrack that LocalMedia publishes in the camera's
// place. one segmentation mask drives two paint modes — blur (a blurred copy of
// the frame behind a sharp cutout of the person) and solid (a flat color behind
// the same cutout). the "none" mode never reaches here: LocalMedia publishes the
// raw camera track directly then, so there's zero cost when no effect is chosen.
//
// ownership: the raw camera track is LocalMedia's and stays alive to feed our
// hidden <video>; stop() never touches it. we own only the <video>, the
// canvases, the frame loop, and the captured output track.

// the chosen effect. "none" is handled entirely in LocalMedia (raw passthrough);
// this module only ever runs for "blur" or "solid". color is the solid fill.
export type BackgroundEffect =
  | { mode: "none" }
  | { mode: "blur" }
  | { mode: "solid"; color: string };

// segmentation is expensive to init (wasm + model fetch), so build one segmenter
// lazily and share it across processor instances — only one local camera exists,
// so uses are sequential and a single VIDEO-mode segmenter is safe to reuse
const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

// gaussian radius for the blurred backdrop; enough to abstract a room, not so
// much it costs a second full-frame pass of note
const BLUR_PX = 12;
// output capture rate; segmentation realistically sustains ~25-30fps on the mask
const OUTPUT_FPS = 30;

// the CDN module and its ImageSegmenter are untyped here (dynamic remote import),
// so this boundary is `any`; kept narrow so the rest of the file stays honest
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let segmenterPromise: Promise<any> | null = null;

// resolve (and cache) the shared ImageSegmenter; the @vite-ignore keeps Vite from
// trying to bundle a remote URL at build time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSegmenter(): Promise<any> {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    const vision = await import(/* @vite-ignore */ `${VISION_CDN}/vision_bundle.mjs`);
    const { ImageSegmenter, FilesetResolver } = vision;
    const fileset = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
    return ImageSegmenter.createFromOptions(fileset, {
      // GPU delegate keeps segmentation off the main thread's critical path where
      // supported; MediaPipe falls back to CPU on its own if unavailable
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      // a float confidence mask (person probability per pixel) gives soft edges;
      // the category mask would hard-cut and alias
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  })().catch((err) => {
    // a failed load must not poison the cache — clear it so a later effect can retry
    segmenterPromise = null;
    throw err;
  });
  return segmenterPromise;
}

export class BackgroundProcessor {
  // the composited track LocalMedia publishes; stable across blur<->solid swaps
  private output: MediaStreamTrack | null = null;

  // hidden source: the raw camera track plays here so we can sample frames
  private readonly video = document.createElement("video");
  // out = what we capture; fg = the person cut out of the sharp frame; mask =
  // the confidence mask rendered as an alpha channel to drive that cutout
  private readonly out = document.createElement("canvas");
  private readonly fg = document.createElement("canvas");
  private readonly mask = document.createElement("canvas");
  private outCtx: CanvasRenderingContext2D | null = null;
  private fgCtx: CanvasRenderingContext2D | null = null;
  private maskCtx: CanvasRenderingContext2D | null = null;
  // reused per-frame alpha buffer, sized to the *mask's* native resolution (the
  // model's, e.g. 256x256 — not the video's); drawImage scales it to frame size.
  // reallocated if the mask dims ever change
  private maskImage: ImageData | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private segmenter: any = null;
  private running = false;
  // monotonic timestamp segmentForVideo requires; performance.now is fine
  private lastTs = -1;
  // guards against parallel scheduling chains: the visibility handler restarts
  // the loop on a new path, and the callback left pending on the old path may
  // still fire later — only the callback holding the latest token may run
  private scheduleToken = 0;

  constructor(
    // LocalMedia's live camera track; we read it, never stop it
    private readonly camera: MediaStreamTrack,
    // current paint mode; swapped live via setEffect without rebuilding anything
    private effect: BackgroundEffect,
  ) {}

  // the published track; only valid between start() resolving and stop()
  get outputTrack(): MediaStreamTrack {
    if (!this.output) throw new Error("BackgroundProcessor.outputTrack read before start()");
    return this.output;
  }

  // swap paint mode (blur<->solid, or a new solid color) with no track change —
  // the loop simply reads the latest effect next frame
  setEffect(effect: BackgroundEffect): void {
    this.effect = effect;
  }

  // load the segmenter, start playback, size the canvases, and begin the loop.
  // resolves once the output track is producing frames; throws if the segmenter
  // can't load (offline / CDN blocked) so LocalMedia can fall back to raw
  async start(): Promise<void> {
    this.segmenter = await getSegmenter();

    this.video.srcObject = new MediaStream([this.camera]);
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();

    // out and fg render at frame resolution; the mask canvas is sized lazily to
    // the model's mask dims on the first frame (see ensureMaskSize)
    const w = this.video.videoWidth || 640;
    const h = this.video.videoHeight || 480;
    this.out.width = w;
    this.out.height = h;
    this.fg.width = w;
    this.fg.height = h;
    this.outCtx = this.out.getContext("2d");
    this.fgCtx = this.fg.getContext("2d");
    this.maskCtx = this.mask.getContext("2d");

    // captureStream drives from our manual draws; the fps is the ceiling, not a
    // guarantee — we paint as fast as segmentation lets us
    this.output = this.out.captureStream(OUTPUT_FPS).getVideoTracks()[0];
    this.running = true;
    // rVFC/rAF stop firing in a hidden tab; watch visibility so the loop can
    // hop between the frame path and the timer path (see schedule)
    document.addEventListener("visibilitychange", this.onVisibility);
    this.loop();
  }

  // stop the loop and release everything we own; the camera track is LocalMedia's
  stop(): void {
    this.running = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.output?.stop();
    this.output = null;
    this.video.pause();
    this.video.srcObject = null;
  }

  // one frame: segment, cut the person out of the sharp frame, paint the chosen
  // backdrop, then stamp the person on top. scheduled off the camera's own frame
  // cadence where available so we never segment a frame twice
  private loop = (): void => {
    if (!this.running) return;
    // track the camera's real dimensions: they read 0 before the first frame
    // in some browsers (start() falls back to 640x480 then) and can change if
    // the device reconfigures — without this the output stays stretched
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw && vh && (vw !== this.out.width || vh !== this.out.height)) {
      this.out.width = vw;
      this.out.height = vh;
      this.fg.width = vw;
      this.fg.height = vh;
    }
    const w = this.out.width;
    const h = this.out.height;
    const ts = performance.now();
    // segmentForVideo rejects a non-increasing timestamp; skip the rare dup
    if (ts <= this.lastTs) {
      this.schedule();
      return;
    }
    this.lastTs = ts;

    this.segmenter.segmentForVideo(this.video, ts, (result: unknown) => {
      // MediaPipe's result/masks are only valid inside this callback; copy the
      // alpha out and close the mask before returning
      const masks = (result as { confidenceMasks?: unknown[] }).confidenceMasks;
      const mask = masks?.[0] as
        | { getAsFloat32Array(): Float32Array; width: number; height: number; close(): void }
        | undefined;
      if (!mask) return;
      if (!this.outCtx || !this.fgCtx || !this.maskCtx) {
        mask.close();
        return;
      }

      // paint the confidence mask (person probability) as an alpha channel at the
      // mask's own resolution; drawImage below scales it up to the frame. rgb is
      // irrelevant here — the destination-in composite only reads alpha
      const maskImage = this.ensureMaskSize(mask.width, mask.height);
      const px = maskImage.data;
      const prob = mask.getAsFloat32Array();
      for (let i = 0; i < prob.length; i++) px[i * 4 + 3] = prob[i] * 255;
      mask.close();
      this.maskCtx.putImageData(maskImage, 0, 0);

      // foreground = sharp camera frame kept only where the mask says "person"
      this.fgCtx.globalCompositeOperation = "copy";
      this.fgCtx.drawImage(this.video, 0, 0, w, h);
      this.fgCtx.globalCompositeOperation = "destination-in";
      this.fgCtx.drawImage(this.mask, 0, 0, w, h);
      this.fgCtx.globalCompositeOperation = "source-over";

      // backdrop then person
      if (this.effect.mode === "solid") {
        this.outCtx.filter = "none";
        this.outCtx.fillStyle = this.effect.color;
        this.outCtx.fillRect(0, 0, w, h);
      } else {
        this.outCtx.filter = `blur(${BLUR_PX}px)`;
        this.outCtx.drawImage(this.video, 0, 0, w, h);
        this.outCtx.filter = "none";
      }
      this.outCtx.drawImage(this.fg, 0, 0, w, h);
    });

    this.schedule();
  };

  // size the mask canvas + alpha buffer to the model's mask dims, reallocating
  // only when they change (first frame, or a model that varies output size)
  private ensureMaskSize(w: number, h: number): ImageData {
    if (!this.maskImage || this.maskImage.width !== w || this.maskImage.height !== h) {
      this.mask.width = w;
      this.mask.height = h;
      this.maskImage = this.maskCtx!.createImageData(w, h);
    }
    return this.maskImage;
  }

  // queue the next frame. visible: prefer the camera's own frame callback so
  // we track its real cadence, rAF where unsupported. hidden: neither ever
  // fires, which would freeze the published track for every peer — a timer
  // keeps frames flowing (background throttling degrades it to ~1fps, but
  // degraded beats frozen). the token invalidates whichever callback the
  // previous path left pending, so only one chain is ever live
  private schedule(): void {
    if (!this.running) return;
    const token = ++this.scheduleToken;
    const tick = (): void => {
      if (token === this.scheduleToken) this.loop();
    };
    if (document.hidden) {
      setTimeout(tick, 1000 / OUTPUT_FPS);
      return;
    }
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => void;
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  // tab hidden: the pending rVFC/rAF will never fire, so restart on the timer
  // path. tab visible: restart on the frame path instead of waiting out a
  // throttled timer. schedule() supersedes the stale pending callback either way
  private onVisibility = (): void => {
    this.schedule();
  };
}
