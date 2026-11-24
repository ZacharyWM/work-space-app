// local media manager (step 3.1): getUserMedia per the join toggles.
// two axes decide whether a device is physically held: the user's mic/cam
// toggles (intent, shown in the hud and reported to the room) and whether
// transmitting is even possible — someone else shares the zone, or meeting
// mode is open (App drives that gate). a device is acquired only when its
// toggle is on AND transmitting; otherwise its track is stopped and dropped
// so the OS in-use indicator goes dark. mic off therefore releases the device
// (no warm track.enabled mute), and every on-flip is an async re-acquisition
// that can land the toggle back off on deny/unplug

import { BackgroundProcessor, type BackgroundEffect } from "./backgroundEffect";

// mic/cam on-state as shown to the user and the room
export type MediaToggles = { micOn: boolean; camOn: boolean };

// chosen input hardware, by enumerateDevices() deviceId; null = browser default.
// a machine-level preference (which mic/cam is plugged in), so it persists in
// localStorage rather than travelling with the account or the tab session
export type DeviceSelection = { micDeviceId: string | null; camDeviceId: string | null };

// one enumerated input the picker can offer
export type MediaDeviceOption = { deviceId: string; label: string };

// `voiceIsolation` isn't in the DOM lib yet, so widen the constraint/settings
// types here rather than casting at every use
type AudioConstraints = MediaTrackConstraints & { voiceIsolation?: boolean };
type AudioSettings = MediaTrackSettings & { voiceIsolation?: boolean };

// audio-processing constraints applied to every mic acquisition. a bare
// `audio: true` leaves these at browser defaults (inconsistent, often weak),
// so background noise leaks in — here we explicitly ask the browser's DSP to
// gate it out. echoCancellation stops peer audio feeding back through the mic;
// autoGainControl evens out talk volume. voiceIsolation asks the platform for
// its ML denoiser (a far stronger filter than noiseSuppression, tuned for one
// near voice) where it exists; browsers that don't support the name drop it
// during constraint matching, so it costs nothing where it's unavailable —
// it stays a plain hint, never `exact`, so it can never fail an acquisition
const AUDIO_CONSTRAINTS: AudioConstraints = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  voiceIsolation: true,
};

// report what the browser actually applied. every constraint above is a hint,
// so any of them can be silently ignored — and which ones land varies by
// platform, browser and device. reading it back is the only way to know
function logAudioSettings(track: MediaStreamTrack): void {
  const s = track.getSettings() as AudioSettings;
  console.log(
    `mic dsp: noiseSuppression=${s.noiseSuppression} voiceIsolation=${s.voiceIsolation} ` +
      `echoCancellation=${s.echoCancellation} autoGainControl=${s.autoGainControl}`,
  );
}

// build the getUserMedia constraints for one kind, pinning the chosen device
// when set. deviceId is `ideal`, not `exact`: a stale saved id (device since
// unplugged) then falls back to the default instead of failing the whole
// acquisition and flipping the toggle off
function audioConstraints(deviceId: string | null): AudioConstraints {
  return deviceId ? { ...AUDIO_CONSTRAINTS, deviceId: { ideal: deviceId } } : AUDIO_CONSTRAINTS;
}
function videoConstraints(deviceId: string | null): MediaTrackConstraints | boolean {
  return deviceId ? { deviceId: { ideal: deviceId } } : true;
}

// device selection persistence — a browser-level preference (see DeviceSelection)
const DEVICE_PREFS_KEY = "devicePrefs";
function loadDevicePrefs(): DeviceSelection {
  try {
    const raw = localStorage.getItem(DEVICE_PREFS_KEY);
    if (raw === null) return { micDeviceId: null, camDeviceId: null };
    const v = JSON.parse(raw) as Partial<DeviceSelection>;
    return {
      micDeviceId: typeof v.micDeviceId === "string" ? v.micDeviceId : null,
      camDeviceId: typeof v.camDeviceId === "string" ? v.camDeviceId : null,
    };
  } catch {
    return { micDeviceId: null, camDeviceId: null };
  }
}
function saveDevicePrefs(sel: DeviceSelection): void {
  try {
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(sel));
  } catch {
    // private-mode / disabled storage: selection just won't survive a reload
  }
}

// background effect persistence — a browser-level preference like the device
// selection, so it lives in localStorage rather than travelling with the account
const BG_EFFECT_KEY = "backgroundEffect";
function loadBackgroundEffect(): BackgroundEffect {
  try {
    const raw = localStorage.getItem(BG_EFFECT_KEY);
    if (raw === null) return { mode: "none" };
    const v = JSON.parse(raw) as Partial<BackgroundEffect> & { color?: unknown };
    if (v.mode === "blur") return { mode: "blur" };
    if (v.mode === "solid" && typeof v.color === "string") return { mode: "solid", color: v.color };
    return { mode: "none" };
  } catch {
    return { mode: "none" };
  }
}
function saveBackgroundEffect(effect: BackgroundEffect): void {
  try {
    localStorage.setItem(BG_EFFECT_KEY, JSON.stringify(effect));
  } catch {
    // private-mode / disabled storage: the choice just won't survive a reload
  }
}

// enumerate the mics and cams the picker can offer. labels are only populated
// after a media permission grant, so this is only useful aboard (post-acquire)
export async function listInputDevices(): Promise<{
  mics: MediaDeviceOption[];
  cams: MediaDeviceOption[];
}> {
  if (!navigator.mediaDevices?.enumerateDevices) return { mics: [], cams: [] };
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics: MediaDeviceOption[] = [];
  const cams: MediaDeviceOption[] = [];
  for (const d of devices) {
    if (d.kind === "audioinput") mics.push({ deviceId: d.deviceId, label: d.label || "Microphone" });
    else if (d.kind === "videoinput") cams.push({ deviceId: d.deviceId, label: d.label || "Camera" });
  }
  return { mics, cams };
}

export class LocalMedia {
  // one stream carrying whatever tracks are currently held; peers attach it in 3.4
  readonly stream: MediaStream;

  // fired when a device track is dropped (null) or re-acquired, so App can
  // swap it into every live connection (and rebind speaking detection for audio)
  onAudioTrack: ((track: MediaStreamTrack | null) => void) | null = null;
  onVideoTrack: ((track: MediaStreamTrack | null) => void) | null = null;

  // the user's toggles — kept even while the device is parked by the gate
  private readonly desired: MediaToggles;
  // the transmitting gate; false parks both devices regardless of the toggles
  private transmitting = true;
  private audio: MediaStreamTrack | null;
  // the published video track peers and the local preview see. with no effect
  // it IS the camera track; with blur/solid it's the processor's canvas capture
  private video: MediaStreamTrack | null;
  // the raw camera device track — owns the OS in-use light. equals `video` when
  // no effect is active; otherwise it stays private, feeding the processor
  private camera: MediaStreamTrack | null;
  // the running background pipeline, or null when the effect is "none"
  private processor: BackgroundProcessor | null = null;
  // the chosen effect (intent); syncNow reconciles the pipeline to match it
  private effect: BackgroundEffect;
  // chosen hardware (null = browser default); the deviceId each held track was
  // acquired with is tracked separately so syncNow can spot a selection change
  // and re-acquire the parked/live track against the new device
  private wantMicDeviceId: string | null;
  private wantCamDeviceId: string | null;
  private audioDeviceId: string | null;
  private videoDeviceId: string | null;
  // serializes device flips so overlapping toggles/zone changes can't
  // interleave getUserMedia calls; each step reads the latest desired/gate,
  // so a stale step is corrected by the one queued behind it
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(
    audio: MediaStreamTrack | null,
    video: MediaStreamTrack | null,
    sel: DeviceSelection,
    effect: BackgroundEffect,
  ) {
    this.audio = audio;
    // board publishing the raw camera track; if an effect is saved, acquire()
    // runs one sync afterward to swap in the processed track (needs async init)
    this.video = video;
    this.camera = video;
    this.effect = effect;
    this.wantMicDeviceId = sel.micDeviceId;
    this.wantCamDeviceId = sel.camDeviceId;
    // a held track was acquired against the saved selection; a null track has none
    this.audioDeviceId = audio ? sel.micDeviceId : null;
    this.videoDeviceId = video ? sel.camDeviceId : null;
    // effective toggles at boarding: a denied/missing device reads off (decision 8)
    this.desired = { micOn: audio !== null, camOn: video !== null };
    this.stream = new MediaStream([audio, video].filter((t) => t !== null));
  }

  // request devices per the join toggles against the saved hardware selection;
  // never throws — deny/no-device boards without that track (decision 8)
  static async acquire(requested: MediaToggles): Promise<LocalMedia> {
    const sel = loadDevicePrefs();
    const effect = loadBackgroundEffect();
    const { audio, video } = await acquireTracks(requested, sel);
    const media = new LocalMedia(audio, video, sel, effect);
    // a saved effect needs the async processor built; one sync swaps the raw
    // camera track we boarded with for the processed one before App reads .stream
    if (video && effect.mode !== "none") await media.sync();
    return media;
  }

  // the toggles as the hud and the room see them: intent, not possession —
  // a parked device still reads on, so it comes back when company arrives
  get state(): MediaToggles {
    return { ...this.desired };
  }

  // off releases the device (light out); on re-acquires — deny/unplug lands
  // the toggle back off, mirroring acquire's never-throw rule
  async setMicOn(on: boolean): Promise<MediaToggles> {
    this.desired.micOn = on;
    await this.sync();
    return this.state;
  }

  async setCamOn(on: boolean): Promise<MediaToggles> {
    this.desired.camOn = on;
    await this.sync();
    return this.state;
  }

  // App's presence gate: devices are held only while transmitting is possible
  // (a co-zone occupant exists, or meeting mode is explicitly open)
  async setTransmitting(on: boolean): Promise<void> {
    this.transmitting = on;
    await this.sync();
  }

  // the chosen hardware, as the picker shows it (null = browser default)
  get devices(): DeviceSelection {
    return { micDeviceId: this.wantMicDeviceId, camDeviceId: this.wantCamDeviceId };
  }

  // pick a mic/cam: persist the choice, then reconcile — a currently-held track
  // is stopped and re-acquired on the new device; a parked one just adopts it on
  // its next acquisition. null selects the browser default
  async setMicDevice(deviceId: string | null): Promise<void> {
    this.wantMicDeviceId = deviceId;
    saveDevicePrefs(this.devices);
    await this.sync();
  }

  async setCamDevice(deviceId: string | null): Promise<void> {
    this.wantCamDeviceId = deviceId;
    saveDevicePrefs(this.devices);
    await this.sync();
  }

  // the chosen background effect, as the picker shows it
  get backgroundEffect(): BackgroundEffect {
    return this.effect;
  }

  // pick a background effect: persist, then reconcile — syncNow builds, swaps,
  // or tears down the processor to match. blur<->solid and color changes are a
  // live paint swap on the same output track (no renegotiation); on<->off swaps
  // the published track (raw <-> canvas) via a bare replaceTrack downstream.
  // returns what actually applied — a processor that can't start (offline /
  // CDN blocked) falls back to none, and the picker must reflect that
  async setBackgroundEffect(effect: BackgroundEffect): Promise<BackgroundEffect> {
    this.effect = effect;
    saveBackgroundEffect(effect);
    await this.sync();
    return this.effect;
  }

  // stop every track (all device lights go out); used on exit and socket close
  dispose(): void {
    this.disposed = true;
    // the processor and its raw camera feed sit outside this.stream when an
    // effect is active, so stop them explicitly before the published tracks
    this.processor?.stop();
    this.camera?.stop();
    for (const track of this.stream.getTracks()) track.stop();
  }

  // queue one reconcile pass; the returned promise resolves after it ran
  private sync(): Promise<void> {
    this.queue = this.queue.then(() => this.syncNow());
    return this.queue;
  }

  // reconcile held tracks with desired ∧ transmitting, one device at a time. a
  // held track is also dropped when its device no longer matches the selection,
  // so the re-acquire below picks up the newly chosen hardware
  private async syncNow(): Promise<void> {
    if (this.disposed) return;
    const wantMic = this.desired.micOn && this.transmitting;
    if (this.audio && (!wantMic || this.audioDeviceId !== this.wantMicDeviceId)) {
      this.audio.stop();
      this.stream.removeTrack(this.audio);
      this.audio = null;
      this.onAudioTrack?.(null);
    }
    if (wantMic && this.audio === null) {
      const deviceId = this.wantMicDeviceId;
      const track = await soloTrack("audio", deviceId);
      // disposed while the request was in flight: don't resurrect the light
      if (this.disposed) {
        track?.stop();
        return;
      }
      if (track) {
        this.audio = track;
        this.audioDeviceId = deviceId;
        this.stream.addTrack(track);
        this.onAudioTrack?.(track);
      } else {
        this.desired.micOn = false;
      }
    }
    // video reconciles in two layers: the camera device first, then the effect
    // pipeline over it. drop the camera when unwanted or its selection changed —
    // teardownVideo also stops any processor and the published track it fed
    const wantCam = this.desired.camOn && this.transmitting;
    if (this.camera && (!wantCam || this.videoDeviceId !== this.wantCamDeviceId)) {
      this.teardownVideo();
    }
    if (wantCam && this.camera === null) {
      const deviceId = this.wantCamDeviceId;
      const camera = await soloTrack("video", deviceId);
      if (this.disposed) {
        camera?.stop();
        return;
      }
      if (!camera) {
        this.desired.camOn = false;
      } else {
        this.camera = camera;
        this.videoDeviceId = deviceId;
        // publish the raw camera, or a processor output built over it
        const published = await this.buildPublishedVideo(camera);
        if (this.disposed) return;
        this.video = published;
        this.stream.addTrack(published);
        this.onVideoTrack?.(published);
      }
    } else if (wantCam && this.camera) {
      // camera already held: reconcile only the effect pipeline against it
      await this.reconcileEffect();
    }
  }

  // stop the camera and any processor, then drop the published track. covers
  // both shapes: with no effect the published track IS the camera (stopped
  // here); with an effect it's the processor's output (stopped by stop())
  private teardownVideo(): void {
    this.processor?.stop();
    this.processor = null;
    this.camera?.stop();
    this.camera = null;
    if (this.video) {
      this.stream.removeTrack(this.video);
      this.video = null;
      this.onVideoTrack?.(null);
    }
  }

  // pick the published track for a freshly acquired camera: the raw track when
  // there's no effect, else a processor output. a processor that can't start
  // (offline / CDN blocked) falls back to raw and drops the effect to none
  private async buildPublishedVideo(camera: MediaStreamTrack): Promise<MediaStreamTrack> {
    if (this.effect.mode === "none") return camera;
    try {
      const proc = new BackgroundProcessor(camera, this.effect);
      await proc.start();
      if (this.disposed) {
        proc.stop();
        return camera; // caller returns early on disposed; this value is unused
      }
      this.processor = proc;
      return proc.outputTrack;
    } catch (err) {
      console.warn("background effect unavailable, publishing raw camera:", err);
      this.effect = { mode: "none" };
      return camera;
    }
  }

  // reconcile the processor against the current effect for an already-held
  // camera. blur<->solid and color changes are a live paint swap on the same
  // output track; on<->off swaps the published track (raw <-> canvas)
  private async reconcileEffect(): Promise<void> {
    if (!this.camera || !this.video) return;
    const wantOn = this.effect.mode !== "none";
    const haveOn = this.processor !== null;
    if (wantOn && haveOn) {
      this.processor!.setEffect(this.effect);
    } else if (wantOn && !haveOn) {
      try {
        const proc = new BackgroundProcessor(this.camera, this.effect);
        await proc.start();
        if (this.disposed) {
          proc.stop();
          return;
        }
        this.stream.removeTrack(this.video);
        this.processor = proc;
        this.video = proc.outputTrack;
        this.stream.addTrack(this.video);
        this.onVideoTrack?.(this.video);
      } catch (err) {
        console.warn("background effect unavailable, keeping raw camera:", err);
        this.effect = { mode: "none" };
      }
    } else if (!wantOn && haveOn) {
      this.stream.removeTrack(this.video);
      this.processor!.stop();
      this.processor = null;
      this.video = this.camera;
      this.stream.addTrack(this.video);
      this.onVideoTrack?.(this.video);
    }
  }
}

// request the tracks the join toggles ask for; every failure path yields null
// tracks instead of throwing so boarding is never blocked on media
async function acquireTracks(
  req: MediaToggles,
  sel: DeviceSelection,
): Promise<{ audio: MediaStreamTrack | null; video: MediaStreamTrack | null }> {
  const none = { audio: null, video: null };
  if (!req.micOn && !req.camOn) return none;
  // insecure origins (plain http over LAN) expose no mediaDevices at all
  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn("mediaDevices unavailable (insecure context?), boarding without media");
    return none;
  }
  try {
    // one combined request = one permission prompt when both are wanted
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: req.micOn ? audioConstraints(sel.micDeviceId) : false,
      video: req.camOn ? videoConstraints(sel.camDeviceId) : false,
    });
    const audio = stream.getAudioTracks()[0] ?? null;
    if (audio) logAudioSettings(audio);
    return { audio, video: stream.getVideoTracks()[0] ?? null };
  } catch (err) {
    console.warn("getUserMedia failed:", err);
  }
  // a combined request rejects wholesale when either kind is denied or missing;
  // if both were wanted, retry each alone so the surviving one still boards
  if (!(req.micOn && req.camOn)) return none;
  return {
    audio: await soloTrack("audio", sel.micDeviceId),
    video: await soloTrack("video", sel.camDeviceId),
  };
}

// single-kind getUserMedia against the chosen device; null on deny/no-device
async function soloTrack(
  kind: "audio" | "video",
  deviceId: string | null,
): Promise<MediaStreamTrack | null> {
  try {
    const constraint = kind === "audio" ? audioConstraints(deviceId) : videoConstraints(deviceId);
    const stream = await navigator.mediaDevices.getUserMedia({ [kind]: constraint });
    const track = stream.getTracks()[0] ?? null;
    if (kind === "audio" && track) logAudioSettings(track);
    return track;
  } catch (err) {
    console.warn(`${kind} unavailable, boarding without it:`, err);
    return null;
  }
}
