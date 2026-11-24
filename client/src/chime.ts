// wave chime (notes/004): a short two-tone ping synthesized with the Web Audio
// API — no asset files. The context is created lazily on first use (the join
// click already unlocked audio for the page) and resumed per chime in case the
// browser suspended it while the tab was idle.

// the two notes: A5 then D6, a rising "someone wants you" interval
const NOTE_HZ = [880, 1174.7];
const NOTE_GAP_S = 0.12; // second note starts this far in
const NOTE_LEN_S = 0.35; // each note's decay length
const NOTE_GAIN = 0.08; // peak volume, deliberately quiet

// announcement chime (notes/010): a bosun-call triple — same synthesis, a
// lower, longer figure so it reads "all hands" rather than "look at me"
const ANNOUNCE_HZ = [587.3, 587.3, 880]; // D5 D5 A5
const ANNOUNCE_GAP_S = 0.16;
const ANNOUNCE_LEN_S = 0.45;

let ctx: AudioContext | null = null;

// shared tone sequencer: each note starts gap*i in, decays over len
function playNotes(notes: readonly number[], gapS: number, lenS: number): void {
  ctx ??= new AudioContext();
  void ctx.resume();
  const t0 = ctx.currentTime;
  notes.forEach((hz, i) => {
    const start = t0 + i * gapS;
    const osc = ctx!.createOscillator();
    osc.type = "sine";
    osc.frequency.value = hz;
    const gain = ctx!.createGain();
    // fast attack, exponential decay to silence
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(NOTE_GAIN, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + lenS);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(start);
    osc.stop(start + lenS);
  });
}

export function playWaveChime(): void {
  playNotes(NOTE_HZ, NOTE_GAP_S, NOTE_LEN_S);
}

export function playAnnounceChime(): void {
  playNotes(ANNOUNCE_HZ, ANNOUNCE_GAP_S, ANNOUNCE_LEN_S);
}
