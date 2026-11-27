/**
 * Fireplace's events and the roar's noise, and the param mappings the rest of
 * the sound uses: pure code with no Web Audio globals, run by
 * `fireplace.worklet.ts` and checked in Node.
 *
 * The worklet makes the roar's noise too, already flickering, and the drift
 * that moves its band (`FireplaceGenerator`): every worklet node has a fixed
 * cost, so one node does it all, and the native graph does the filtering.
 *
 * **Events**, each type from its own hash stream, after Rain's pattern (block
 * hashing, latched params, look-back, a fixed voice pool per type):
 *
 * - **Crackles** come in clusters: parents from `eventsInBlock`, each with
 *   2–9 children (3–12 on softwood) within 40–350 ms of it. Each child is a
 *   tiny burst of counter-hashed noise through a band-pass at 1.8–5 kHz.
 * - **Pops**: a 0.5 ms noise transient that rings a resonant band at
 *   350–1 100 Hz, so it has a woody body, plus a little of the transient's snap.
 * - **Sap hiss**: a few seconds of pink-ish noise at 3–5.5 kHz, faded in and
 *   out, with a fast, irregular flutter.
 * - **Log shifts**: a soft, low thump and a short rustle of extra crackle
 *   clusters as the fire settles.
 *
 * **Block events.** When the kernel enters block `b` it lists every event that
 * starts in it, sorted: the children that land in `b` of the clusters of
 * blocks `b − 1` and `b` (a cluster lasts under a block), and of the rustles of
 * shifts up to `SHIFT_LOOK_BACK` blocks back, and the pops, hisses and thumps of
 * `b`. Each block's rates are latched when the kernel enters it and kept in a
 * short history, so a cluster or rustle that crosses into the next block keeps
 * the rates it started with.
 *
 * **Look-back.** At the first render, and whenever the absolute time jumps,
 * the kernel renders the last `WARM_UP` seconds silently (longer than any
 * event but a hiss), and starts any hiss still sounding then part-way through:
 * a hiss's envelope and flutter are functions of its own time, and its filters
 * settle within the warm-up. So chunked renders join seamlessly.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { expDecayCoef } from "../../audio/dsp/envelopes";
import { blockOf, createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { OnePoleLowpass } from "../../audio/dsp/onepole";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { Svf } from "../../audio/dsp/svf";
import { VoicePool, type PoolVoice } from "../../audio/dsp/voices";
import { NoiseGenerator } from "../../audio/noise-dsp";
import { hashStep, UINT32_SCALE } from "../../audio/random";

export const FIREPLACE_PROCESSOR = "aural-fireplace";

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;
/** Evenly in log between the range's ends. */
const logLerp = (range: readonly [number, number], u: number) =>
  range[0] * (range[1] / range[0]) ** u;

/** Random streams: the roar's two noises and two drifts, and each event type. */
const BROWN_STREAM = 1;
const PINK_STREAM = 2;
const FLICKER_STREAM = 3;
const BAND_STREAM = 4;
export const CRACKLE_STREAM = 10;
export const POP_STREAM = 11;
export const HISS_STREAM = 12;
export const SHIFT_STREAM = 13;

/**
 * The worklet's output channels: the roar's stereo brown and pink noise (both
 * under the flicker), the events' stereo mix, and the band's drift in cents.
 */
export const BROWN_CHANNEL = 0;
export const PINK_CHANNEL = 2;
export const EVENTS_CHANNEL = 4;
export const BAND_CHANNEL = 6;
export const FIREPLACE_CHANNELS = 7;

/** The flicker: a lively drift (rate in Hz, octaves) moving the roar's level by ±3 dB. */
const FLICKER = { rate: 1.2, octaves: 3, db: 3 } as const;
/** The band's drift: a slow one moving the roar's band-pass by ±25 %. */
const BAND_DRIFT = { rate: 0.07, octaves: 2 } as const;
const BAND_SWING_CENTS = 1200 * Math.log2(1.25);

/** Keys for each event's own random properties: `hashStep(eventHash(…), key)`. */
const AMPLITUDE = 1;
const PAN = 2;
const CENTRE = 3;
const QUALITY = 4;
const LENGTH = 5;
const NOISE = 6;
const COUNT = 7;
const SPAN = 8;
const TIME = 9;
const RATE = 10;
/** A cluster's children, and a rustle's parents, hash from these keys on. */
const CHILD_KEY = 100;

/** Events pan within ±0.5. */
const PAN_WIDTH = 0.5;

/** A cluster's span, in seconds, and its children, by wood. */
const CLUSTER_SPAN = [0.04, 0.35] as const;
const CLUSTER_SIZE = { hardwood: [2, 9], softwood: [3, 12] } as const;
/** The most children a cluster can have. */
export const MAX_CLUSTER = CLUSTER_SIZE.softwood[1];
/** A crackle's length (its decay's time constant is a third of it), in seconds. */
const CRACKLE_LENGTH = [0.0002, 0.0015] as const;
const CRACKLE_CENTRE = [1800, 5000] as const;
const CRACKLE_Q = [0.7, 1.5] as const;
/**
 * The loudest crackle's envelope peak, in dBFS: its band-pass and pan leave
 * about a third of that at the output, so the loudest crackles peak near
 * −10 dBFS, under the biggest pops, and the busier half of a second's
 * crackles near −15.
 */
const CRACKLE_PEAK_DB = -1;
/** Crackles under this amplitude (−40 dB against the loudest) are skipped: lost under the roar. */
const CRACKLE_SILENT = dbToGain(-40);
/** A crackle ends 40 dB under its peak. */
const CRACKLE_END = dbToGain(-40);

/** A pop's transient, in seconds, and its body's centre (Hz) and Q. */
const POP_TRANSIENT = 0.0005;
const POP_CENTRE = [350, 1100] as const;
const POP_Q = [6, 10] as const;
/** The biggest pop's body peaks here, in dBFS; pops range over its top 6 dB. */
export const POP_PEAK_DB = -8;
const POP_RANGE_DB = 6;
/** The transient's snap: its band (Hz, Q) and level against the body's peak. */
const SNAP_CENTRE = 2500;
const SNAP_Q = 0.8;
const SNAP_MIX = 1;
/** A pop ends 50 dB under its peak. */
const POP_END = dbToGain(-50);

/** A hiss's fade in, body and fade out, in seconds; its band (Hz, Q); its flutter, in Hz. */
const HISS_RISE = 0.5;
const HISS_BODY = [1.5, 5] as const;
const HISS_FALL = 1;
const HISS_CENTRE = [3000, 5500] as const;
const HISS_Q = 1.2;
const HISS_FLUTTER = [8, 20] as const;
/** The noise's low-pass before the band, which tilts it towards pink, in Hz. */
const HISS_TILT = 1500;
/** The flutter's steps lie in this range, and are smoothed over this share of a step. */
const FLUTTER_DEPTH = [0.25, 1] as const;
const FLUTTER_SMOOTHING = 0.3;
/**
 * A hiss's RMS level at full body, in dBFS: about 14 dB under the roar at the
 * default fire size.
 */
const HISS_DB = -38;
/** Hisses range over their top 4 dB. */
const HISS_RANGE_DB = 4;
/** The longest a hiss lasts, in seconds, and how many blocks back one can still be sounding. */
const HISS_LONGEST = HISS_RISE + HISS_BODY[1] + HISS_FALL;
const HISS_LOOK_BACK = Math.ceil(HISS_LONGEST);

/** A shift's thump: noise low-passed at this (Hz), rising over this, decaying with this (s). */
const THUMP_CUTOFF = 120;
const THUMP_RISE = 0.03;
const THUMP_DECAY = 0.1;
/**
 * The thump's level, in dBFS: its noise's RMS level at its peak, about 6 dB
 * under the roar's at the default fire size. Its peaks stay under the
 * biggest pop's.
 */
export const THUMP_DB = -30;
/** A thump ends 50 dB under its peak. */
const THUMP_END = dbToGain(-50);
/** A shift's rustle: extra crackle clusters at this rate, for this long (s). */
const RUSTLE_RATE = 8;
const RUSTLE_LENGTH = [1, 2] as const;
/** The blocks back a shift's rustle can still reach (its length plus a cluster's span). */
const SHIFT_LOOK_BACK = Math.ceil(RUSTLE_LENGTH[1] + CLUSTER_SPAN[1]);

/** Voices per event type. */
const CRACKLE_VOICES = 24;
const POP_VOICES = 4;
const HISS_VOICES = 2;
const THUMP_VOICES = 1;
/** Seconds rendered silently before a render that starts afresh: longer than any event but a hiss. */
export const WARM_UP = 0.8;
/** The most event starts a block can hold, and parents a block can have: far above the busiest fire. */
const START_CAPACITY = 4096;
const PARENT_CAPACITY = 512;
/** The blocks whose rates the kernel remembers: enough for the longest look-back. */
const HISTORY = 16;
/** The scratch buffer the warm-up renders into, in samples. */
const SCRATCH = 128;
/** Noise has the same spectral density at any sample rate: its level is set at this one. */
const REFERENCE_RATE = 48000;
/** The standard deviation of uniform noise in [−1, 1). */
const UNIFORM_SD = 1 / Math.sqrt(3);

/** An event's own random property `key`, in [0, 1). */
const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;
/** Counter-hashed white noise in [−1, 1): sample `n` of the noise `hash` seeds. */
const white = (hash: number, n: number) => hashStep(hash, n) * UINT32_SCALE * 2 - 1;

/** Cluster parents per second at `size` and `crackle` (0–100): 0.5 to 6, evenly in log. */
export function clusterRate(size: number, crackle: number): number {
  return 0.5 * 12 ** clamp01(0.6 * (crackle / 100) + 0.4 * (size / 100));
}

/** Pops per second at `crackle` (0–100): 0.05–0.3 on hardwood, twice that on softwood. */
export function popRate(crackle: number, softwood: boolean): number {
  return 0.05 * 6 ** clamp01(crackle / 100) * (softwood ? 2 : 1);
}

/** Sap hisses per second: one every 75 s on hardwood, three times as many on softwood. */
export function hissRate(softwood: boolean): number {
  return (softwood ? 3 : 1) / 75;
}

/** Log shifts per second at `size` (0–100): one every 5.3 min for embers to 3.2 min for a blaze. */
export function shiftRate(size: number): number {
  return (0.75 + 0.5 * clamp01(size / 100)) / 240;
}

/** Every event's level at `size` (0–100), in dB: embers' crackles are 6 dB quieter than a blaze's. */
export function eventsDb(size: number): number {
  return -6 + 6 * clamp01(size / 100);
}

/**
 * The roar's level at `size` (0–100), in dB: −20 for embers, −6 at 55 and 0 for
 * a roaring fire. It rises fastest from the embers, so a blaze is only 6 dB
 * over the default fire.
 */
export function roarDb(size: number): number {
  return -20 * (1 - clamp01(size / 100)) ** 1.5;
}

/** The roar's low-pass at `size` (0–100), in Hz: 160 to 320, evenly in log. */
export function roarCutoff(size: number): number {
  return 160 * 2 ** clamp01(size / 100);
}

/** The room reverb send at `room` (0–100), in dB: −36 close to −14 across a large room. */
export function sendDb(room: number): number {
  return -36 + 22 * clamp01(room / 100);
}

/** The high shelf at `room` (0–100), in dB: −2 close to −6 far back. */
export function shelfDb(room: number): number {
  return -2 - 4 * clamp01(room / 100);
}

/** The hash cluster child `child` of the cluster `hash` derives from. */
const childHash = (hash: number, child: number) => hashStep(hash, CHILD_KEY + child);

/**
 * Fills `out` with the children of the cluster whose hash is `hash`, in
 * seconds after its parent (unsorted), and returns how many: 2–9 (3–12 on
 * softwood), within a span of 40–350 ms.
 */
export function clusterChildren(hash: number, softwood: boolean, out: Float64Array): number {
  const [least, most] = softwood ? CLUSTER_SIZE.softwood : CLUSTER_SIZE.hardwood;
  const count = Math.min(least + Math.floor(unit(hash, COUNT) * (most - least + 1)), out.length);
  const span = lerp(CLUSTER_SPAN, unit(hash, SPAN));
  for (let c = 0; c < count; c++) {
    out[c] = span * unit(childHash(hash, c), TIME);
  }
  return count;
}

/** A shift's rustle's length, in seconds. */
function rustleLength(hash: number): number {
  return lerp(RUSTLE_LENGTH, unit(hash, LENGTH));
}

/** A hiss's body, in seconds. */
const hissBody = (hash: number) => lerp(HISS_BODY, unit(hash, LENGTH));

interface FireplaceOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readFireplaceOptions(raw: unknown): FireplaceOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}

/**
 * The RMS level of a hiss's filtered noise before its gain, at the middle of
 * its band: uniform noise, its one-pole tilt (about −8 dB at 4 kHz) and the
 * band-pass's noise bandwidth (about π/2 × 4 kHz / Q).
 */
const HISS_RMS =
  UNIFORM_SD /
  Math.sqrt(1 + (4000 / HISS_TILT) ** 2) /
  Math.sqrt(REFERENCE_RATE / 2 / ((Math.PI / 2) * (4000 / HISS_Q)));

/** A crackle: a tiny burst of counter-hashed noise, decaying exponentially, through a band-pass. */
class CrackleVoice implements PoolVoice {
  level = 0;
  private readonly svf: Svf;
  private readonly sampleRate: number;
  private noise = 0;
  private position = 0;
  private envelope = 0;
  private coef = 0;
  private end = 0;
  private left = 0;
  private right = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.svf = new Svf(sampleRate);
  }

  start(noise: number, peak: number, pan: number, centre: number, q: number, decay: number): void {
    this.svf.reset();
    this.svf.set(centre, q);
    this.noise = noise;
    this.position = 0;
    this.envelope = peak;
    this.coef = expDecayCoef(decay, this.sampleRate);
    this.end = peak * CRACKLE_END;
    this.left = panLeft(pan);
    this.right = panRight(pan);
    this.level = peak;
  }

  /** Adds samples `from` to `to` into the outputs. Returns false once the crackle has ended. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const svf = this.svf;
    const noise = this.noise;
    const coef = this.coef;
    const end = this.end;
    let envelope = this.envelope;
    let n = this.position;
    for (let i = from; i < to && envelope > end; i++) {
      svf.tick(white(noise, n) * envelope);
      n++;
      envelope *= coef;
      const y = svf.band;
      left[i] += y * this.left;
      right[i] += y * this.right;
    }
    this.envelope = envelope;
    this.position = n;
    this.level = envelope;
    return envelope > end;
  }
}

/**
 * A pop: a short pulse that rings a resonant band, the wood's body, plus a
 * noise transient's snap through a wide band above it. The pulse is a smooth
 * 0.5 ms bump, the same for every pop, so the body peaks at the level it is
 * given; the snap's noise makes each pop's attack its own.
 */
export class PopVoice implements PoolVoice {
  level = 0;
  private readonly body: Svf;
  private readonly snap: Svf;
  private readonly sampleRate: number;
  /** The pulse, sample by sample. */
  private readonly pulse: Float64Array;
  private noise = 0;
  private position = 0;
  private drive = 0;
  private snapGain = 0;
  /** The ring's level after the pulse, and its per-sample decay. */
  private ring = 0;
  private coef = 0;
  private end = 0;
  private left = 0;
  private right = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.body = new Svf(sampleRate);
    this.snap = new Svf(sampleRate, SNAP_CENTRE, SNAP_Q);
    const length = Math.max(1, Math.round(POP_TRANSIENT * sampleRate));
    this.pulse = new Float64Array(length);
    for (let n = 0; n < length; n++) {
      this.pulse[n] = Math.sin((Math.PI * (n + 0.5)) / length) ** 2;
    }
  }

  start(noise: number, peak: number, pan: number, centre: number, q: number): void {
    const sr = this.sampleRate;
    const pulse = this.pulse;
    this.body.reset();
    this.body.set(centre, q);
    this.snap.reset();
    // The pulse's component at the centre, which the normalised band rings
    // with at (w / q) × it per unit drive.
    const w = (2 * Math.PI * centre) / sr;
    let re = 0;
    let im = 0;
    for (let n = 0; n < pulse.length; n++) {
      re += (pulse[n] ?? 0) * Math.cos(w * n);
      im -= (pulse[n] ?? 0) * Math.sin(w * n);
    }
    this.drive = (peak * q) / (w * Math.hypot(re, im));
    // The snap's noise at the body's peak level, before its band.
    this.snapGain = peak * SNAP_MIX;
    this.noise = noise;
    this.position = 0;
    this.ring = peak;
    // A resonance at `centre` with Q `q` decays with time constant q / (π × centre).
    this.coef = expDecayCoef(q / (Math.PI * centre), sr);
    this.end = peak * POP_END;
    this.left = panLeft(pan);
    this.right = panRight(pan);
    this.level = peak;
  }

  /** Adds samples `from` to `to` into the outputs. Returns false once the pop has rung out. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const body = this.body;
    const snap = this.snap;
    const pulse = this.pulse;
    let n = this.position;
    let ring = this.ring;
    for (let i = from; i < to && ring > this.end; i++) {
      if (n < pulse.length) {
        const x = pulse[n] ?? 0;
        body.tick(x * this.drive);
        snap.tick(white(this.noise, n) * x * this.snapGain);
      } else {
        ring *= this.coef;
        body.tick(0);
        snap.tick(0);
      }
      n++;
      const y = body.band + snap.band;
      left[i] += y * this.left;
      right[i] += y * this.right;
    }
    this.position = n;
    this.ring = ring;
    this.level = ring;
    return ring > this.end;
  }
}

/**
 * Sap hissing out of a log: pink-ish noise (counter-hashed noise through a
 * one-pole low-pass) through a band-pass, faded in, held and faded out, with a
 * fast flutter of random steps, smoothed. Everything is a function of the
 * hiss's own sample index, so it can start part-way through.
 */
class HissVoice implements PoolVoice {
  level = 0;
  private readonly band: Svf;
  private readonly tilt: OnePoleLowpass;
  private readonly sampleRate: number;
  private noise = 0;
  private position = 0;
  private gain = 0;
  private rise = 0;
  private hold = 0;
  private fall = 0;
  /** Flutter steps per sample, the step it is heading for, its value, target and smoothing. */
  private stepRate = 0;
  private step = -1;
  private flutter = 0;
  private flutterTarget = 0;
  private flutterCoef = 0;
  private left = 0;
  private right = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.band = new Svf(sampleRate);
    this.tilt = new OnePoleLowpass(sampleRate, HISS_TILT);
  }

  /** Starts a hiss `elapsed` samples in. */
  start(
    noise: number,
    gain: number,
    pan: number,
    centre: number,
    body: number,
    flutterRate: number,
    elapsed: number,
  ): void {
    const sr = this.sampleRate;
    this.band.reset();
    this.band.set(centre, HISS_Q);
    this.tilt.value = 0;
    this.flutterCoef = expDecayCoef(FLUTTER_SMOOTHING / flutterRate, sr);
    this.noise = noise;
    this.position = elapsed;
    this.gain = gain;
    this.rise = Math.round(HISS_RISE * sr);
    this.hold = this.rise + Math.round(body * sr);
    this.fall = Math.round(HISS_FALL * sr);
    this.stepRate = flutterRate / sr;
    this.step = Math.floor(elapsed * this.stepRate);
    this.flutter = this.stepValue(this.step);
    this.flutterTarget = this.flutter;
    this.left = panLeft(pan);
    this.right = panRight(pan);
    this.level = gain;
  }

  private stepValue(step: number): number {
    return lerp(FLUTTER_DEPTH, unit(hashStep(this.noise, RATE), step));
  }

  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const band = this.band;
    const tilt = this.tilt;
    const coef = this.flutterCoef;
    let flutter = this.flutter;
    const last = this.hold + this.fall;
    let n = this.position;
    for (let i = from; i < to && n < last; i++) {
      const step = Math.floor(n * this.stepRate);
      if (step !== this.step) {
        this.step = step;
        this.flutterTarget = this.stepValue(step);
      }
      let envelope = 1;
      if (n < this.rise) {
        envelope = 0.5 - 0.5 * Math.cos((Math.PI * n) / this.rise);
      } else if (n >= this.hold) {
        envelope = 0.5 + 0.5 * Math.cos((Math.PI * (n - this.hold)) / this.fall);
      }
      flutter = this.flutterTarget + coef * (flutter - this.flutterTarget);
      band.tick(tilt.process(white(this.noise, n)));
      const y = band.band * envelope * flutter * this.gain;
      left[i] += y * this.left;
      right[i] += y * this.right;
      n++;
    }
    this.position = n;
    this.flutter = flutter;
    this.level = n < last ? this.gain : 0;
    return n < last;
  }
}

/** A log settling: counter-hashed noise low-passed at 120 Hz, under a quick rise and a decay. */
export class ThumpVoice implements PoolVoice {
  level = 0;
  private readonly lowpass: Svf;
  private readonly sampleRate: number;
  private noise = 0;
  private position = 0;
  private rise = 0;
  private peak = 0;
  private envelope = 0;
  private coef = 0;
  private end = 0;
  private left = 0;
  private right = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.lowpass = new Svf(sampleRate, THUMP_CUTOFF, Math.SQRT1_2);
  }

  /** Starts a thump whose noise has RMS level `level` at its peak. */
  start(noise: number, level: number, pan: number): void {
    const sr = this.sampleRate;
    this.lowpass.reset();
    // A Butterworth low-pass passes noise in about 1.11 × its cutoff.
    const passed = UNIFORM_SD * Math.sqrt((2 * 1.11 * THUMP_CUTOFF) / sr);
    this.peak = level / passed;
    this.noise = noise;
    this.position = 0;
    this.rise = Math.round(THUMP_RISE * sr);
    this.envelope = this.peak;
    this.coef = expDecayCoef(THUMP_DECAY, sr);
    this.end = this.peak * THUMP_END;
    this.left = panLeft(pan);
    this.right = panRight(pan);
    this.level = level;
  }

  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const lowpass = this.lowpass;
    let n = this.position;
    let envelope = this.envelope;
    for (let i = from; i < to && envelope > this.end; i++) {
      let gain = envelope;
      if (n < this.rise) {
        gain = (this.peak * n) / this.rise;
      } else {
        envelope *= this.coef;
      }
      lowpass.tick(white(this.noise, n) * gain);
      n++;
      const y = lowpass.low;
      left[i] += y * this.left;
      right[i] += y * this.right;
    }
    this.position = n;
    this.envelope = envelope;
    this.level = envelope;
    return envelope > this.end;
  }
}

/** Event kinds in a block's start list. */
const CRACKLE = 0;
const POP = 1;
const HISS = 2;
const THUMP = 3;

/**
 * The fire's events, stereo, rendered from any absolute sample, the same
 * whether rendered in one go or in chunks.
 */
export class FireplaceKernel {
  private readonly seed: number;
  private readonly sampleRate: number;
  private readonly crackles: VoicePool<CrackleVoice>;
  private readonly pops: VoicePool<PopVoice>;
  private readonly hisses: VoicePool<HissVoice>;
  private readonly thumps: VoicePool<ThumpVoice>;
  /** The params `set` gave. */
  private size = 0;
  private crackle = 0;
  private softwood = false;
  private gain = 1;
  /** Each remembered block's rates, at index `block & (HISTORY − 1)`. */
  private readonly historyBlocks = new Float64Array(HISTORY).fill(Number.NaN);
  private readonly historyClusters = new Float64Array(HISTORY);
  private readonly historyShifts = new Float64Array(HISTORY);
  private readonly historySoftwood = new Uint8Array(HISTORY);
  /** The loaded block's event starts, sorted: seconds into the block, kind and hash. */
  private readonly offsets = new Float64Array(START_CAPACITY);
  private readonly kinds = new Uint8Array(START_CAPACITY);
  private readonly hashes = new Uint32Array(START_CAPACITY);
  private count = 0;
  private readonly parents = createEventBlock(PARENT_CAPACITY);
  private readonly children = new Float64Array(MAX_CLUSTER);
  private readonly crackleScale: number;
  private readonly warmUpSamples: number;
  private readonly scratchLeft = new Float32Array(SCRATCH);
  private readonly scratchRight = new Float32Array(SCRATCH);
  /** The block whose starts are loaded, and the next of them to start. */
  private block = Number.NaN;
  private next = 0;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.seed = seed;
    this.sampleRate = sampleRate;
    this.crackles = new VoicePool(CRACKLE_VOICES, () => new CrackleVoice(sampleRate));
    this.pops = new VoicePool(POP_VOICES, () => new PopVoice(sampleRate));
    this.hisses = new VoicePool(HISS_VOICES, () => new HissVoice(sampleRate));
    this.thumps = new VoicePool(THUMP_VOICES, () => new ThumpVoice(sampleRate));
    // Uniform noise; scaled with the rate so its density per Hz stays put.
    this.crackleScale = dbToGain(CRACKLE_PEAK_DB) * Math.sqrt(sampleRate / REFERENCE_RATE);
    this.warmUpSamples = Math.ceil(WARM_UP * sampleRate);
    this.set(55, 50, false);
  }

  /**
   * Sets the params for the next render: the fire's `size` and `crackle`
   * (0–100), and whether it burns `softwood`. Rates latch per block, levels
   * per event.
   */
  set(size: number, crackle: number, softwood: boolean): void {
    this.size = size;
    this.crackle = crackle;
    this.softwood = softwood;
    this.gain = dbToGain(eventsDb(size));
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    if (start !== this.expected) {
      this.warmUp(start);
    }
    this.process(left, right, left.length, start);
    this.expected = start + left.length;
  }

  /**
   * Clears every voice, forgets the rates, starts any hiss still sounding
   * `WARM_UP` before `start` part-way through, then renders from there silently.
   */
  private warmUp(start: number): void {
    for (const pool of [this.crackles, this.pops, this.hisses, this.thumps]) {
      pool.active = 0;
    }
    this.historyBlocks.fill(Number.NaN);
    const sr = this.sampleRate;
    let from = start - this.warmUpSamples;
    const first = blockOf(from, sr);
    const rate = hissRate(this.softwood);
    for (let b = first - HISS_LOOK_BACK; b <= first; b++) {
      const count = eventsInBlock(this.seed, HISS_STREAM, b, rate, this.parents);
      for (let i = 0; i < count; i++) {
        const begin = b * sr + Math.floor((this.parents.offsets[i] ?? 0) * sr);
        const hash = eventHash(this.seed, HISS_STREAM, b, i);
        const length = Math.round(HISS_RISE * sr) + Math.round(hissBody(hash) * sr);
        if (begin < from && begin + length + Math.round(HISS_FALL * sr) > from) {
          this.startHiss(hash, from - begin);
        }
      }
    }
    this.load(first);
    while (this.next < this.count && this.startSample(this.next) < from) {
      this.next++;
    }
    while (from < start) {
      const length = Math.min(SCRATCH, start - from);
      this.process(this.scratchLeft, this.scratchRight, length, from);
      from += length;
    }
  }

  /** Where block `block`'s rates are remembered, if they are: otherwise −1, for the current ones. */
  private remembered(block: number): number {
    const slot = block & (HISTORY - 1);
    return this.historyBlocks[slot] === block ? slot : -1;
  }

  /** Loads block `block`'s event starts, latching the current rates for it. */
  private load(block: number): void {
    const slot = block & (HISTORY - 1);
    this.historyBlocks[slot] = block;
    this.historyClusters[slot] = clusterRate(this.size, this.crackle);
    this.historyShifts[slot] = shiftRate(this.size);
    this.historySoftwood[slot] = this.softwood ? 1 : 0;
    this.block = block;
    this.count = 0;
    this.next = 0;
    const seed = this.seed;
    const parents = this.parents;

    // Clusters of this block and the one before.
    for (let b = block - 1; b <= block; b++) {
      const s = this.remembered(b);
      const rate = s < 0 ? clusterRate(this.size, this.crackle) : (this.historyClusters[s] ?? 0);
      const softwood = s < 0 ? this.softwood : this.historySoftwood[s] === 1;
      const count = eventsInBlock(seed, CRACKLE_STREAM, b, rate, parents);
      for (let i = 0; i < count; i++) {
        const time = b + (parents.offsets[i] ?? 0);
        this.addCluster(eventHash(seed, CRACKLE_STREAM, b, i), time, softwood);
      }
    }
    // Shifts: their rustles' clusters, and this block's thumps.
    for (let b = block - SHIFT_LOOK_BACK; b <= block; b++) {
      const s = this.remembered(b);
      const rate = s < 0 ? shiftRate(this.size) : (this.historyShifts[s] ?? 0);
      const softwood = s < 0 ? this.softwood : this.historySoftwood[s] === 1;
      const count = eventsInBlock(seed, SHIFT_STREAM, b, rate, parents);
      for (let i = 0; i < count; i++) {
        const offset = parents.offsets[i] ?? 0;
        const hash = eventHash(seed, SHIFT_STREAM, b, i);
        if (b === block) {
          this.addStart(offset, THUMP, hash);
        }
        const length = rustleLength(hash);
        const clusters = Math.round(RUSTLE_RATE * length);
        for (let k = 0; k < clusters; k++) {
          const parent = childHash(hash, k);
          this.addCluster(parent, b + offset + length * unit(parent, TIME), softwood);
        }
      }
    }
    // This block's pops and hisses.
    const pops = eventsInBlock(
      seed,
      POP_STREAM,
      block,
      popRate(this.crackle, this.softwood),
      parents,
    );
    for (let i = 0; i < pops; i++) {
      this.addStart(parents.offsets[i] ?? 0, POP, eventHash(seed, POP_STREAM, block, i));
    }
    const hisses = eventsInBlock(seed, HISS_STREAM, block, hissRate(this.softwood), parents);
    for (let i = 0; i < hisses; i++) {
      this.addStart(parents.offsets[i] ?? 0, HISS, eventHash(seed, HISS_STREAM, block, i));
    }
  }

  /** Adds the children of cluster `hash`, whose parent is at absolute `time` (s), that land in the loaded block. */
  private addCluster(hash: number, time: number, softwood: boolean): void {
    const count = clusterChildren(hash, softwood, this.children);
    for (let c = 0; c < count; c++) {
      const offset = time + (this.children[c] ?? 0) - this.block;
      if (offset >= 0 && offset < 1) {
        this.addStart(offset, CRACKLE, childHash(hash, c));
      }
    }
  }

  /** Inserts a start into the loaded block's list, keeping it sorted. */
  private addStart(offset: number, kind: number, hash: number): void {
    if (this.count >= START_CAPACITY) {
      return;
    }
    let i = this.count;
    while (i > 0 && (this.offsets[i - 1] ?? 0) > offset) {
      this.offsets[i] = this.offsets[i - 1] ?? 0;
      this.kinds[i] = this.kinds[i - 1] ?? 0;
      this.hashes[i] = this.hashes[i - 1] ?? 0;
      i--;
    }
    this.offsets[i] = offset;
    this.kinds[i] = kind;
    this.hashes[i] = hash;
    this.count++;
  }

  /** The absolute sample start `i` of the loaded block falls on. */
  private startSample(i: number): number {
    return this.block * this.sampleRate + Math.floor((this.offsets[i] ?? 0) * this.sampleRate);
  }

  /** Renders `length` samples from absolute sample `start`, overwriting the outputs. */
  private process(left: Float32Array, right: Float32Array, length: number, start: number): void {
    left.fill(0, 0, length);
    right.fill(0, 0, length);
    const sr = this.sampleRate;
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const block = blockOf(now, sr);
      if (block !== this.block) {
        this.load(block);
      }
      while (this.next < this.count && this.startSample(this.next) <= now) {
        this.startEvent(this.kinds[this.next] ?? 0, this.hashes[this.next] ?? 0);
        this.next++;
      }
      // Render up to the next start, the block's end or the buffer's end.
      let end = Math.min(length, (block + 1) * sr - start);
      if (this.next < this.count) {
        end = Math.min(end, this.startSample(this.next) - start);
      }
      this.renderVoices(left, right, pos, end);
      pos = end;
    }
  }

  private renderVoices(left: Float32Array, right: Float32Array, from: number, to: number): void {
    // Backwards, so releasing a voice (which swaps in the last) is safe.
    const crackles = this.crackles;
    for (let i = crackles.active - 1; i >= 0; i--) {
      if (!crackles.live[i]?.render(left, right, from, to)) {
        crackles.release(i);
      }
    }
    const pops = this.pops;
    for (let i = pops.active - 1; i >= 0; i--) {
      if (!pops.live[i]?.render(left, right, from, to)) {
        pops.release(i);
      }
    }
    const hisses = this.hisses;
    for (let i = hisses.active - 1; i >= 0; i--) {
      if (!hisses.live[i]?.render(left, right, from, to)) {
        hisses.release(i);
      }
    }
    const thumps = this.thumps;
    for (let i = thumps.active - 1; i >= 0; i--) {
      if (!thumps.live[i]?.render(left, right, from, to)) {
        thumps.release(i);
      }
    }
  }

  private startEvent(kind: number, hash: number): void {
    const pan = (unit(hash, PAN) * 2 - 1) * PAN_WIDTH;
    switch (kind) {
      case CRACKLE: {
        // A power law: most crackles are faint, a few are sharp.
        const amplitude = unit(hash, AMPLITUDE) ** 2.5;
        if (amplitude < CRACKLE_SILENT) {
          return;
        }
        this.crackles
          .allocate()
          .start(
            hashStep(hash, NOISE),
            amplitude * this.gain * this.crackleScale,
            pan,
            logLerp(CRACKLE_CENTRE, unit(hash, CENTRE)),
            lerp(CRACKLE_Q, unit(hash, QUALITY)),
            lerp(CRACKLE_LENGTH, unit(hash, LENGTH)) / 3,
          );
        return;
      }
      case POP: {
        const peak = dbToGain(POP_PEAK_DB - POP_RANGE_DB * unit(hash, AMPLITUDE)) * this.gain;
        this.pops
          .allocate()
          .start(
            hashStep(hash, NOISE),
            peak,
            pan,
            logLerp(POP_CENTRE, unit(hash, CENTRE)),
            lerp(POP_Q, unit(hash, QUALITY)),
          );
        return;
      }
      case HISS: {
        this.startHiss(hash, 0);
        return;
      }
      case THUMP: {
        this.thumps
          .allocate()
          .start(hashStep(hash, NOISE), dbToGain(THUMP_DB) * this.gain, pan * 0.5);
        return;
      }
      default:
    }
  }

  /** Starts hiss `hash`, `elapsed` samples in. */
  private startHiss(hash: number, elapsed: number): void {
    const level = dbToGain(HISS_DB - HISS_RANGE_DB * unit(hash, AMPLITUDE)) * this.gain;
    this.hisses
      .allocate()
      .start(
        hashStep(hash, NOISE),
        level / HISS_RMS,
        (unit(hash, PAN) * 2 - 1) * PAN_WIDTH,
        logLerp(HISS_CENTRE, unit(hash, CENTRE)),
        hissBody(hash),
        lerp(HISS_FLUTTER, unit(hash, RATE)),
        elapsed,
      );
  }
}

/**
 * Everything the fireplace worklet makes, into `FIREPLACE_CHANNELS` channels:
 * the roar's stereo brown and pink noise under the flicker, the events
 * (`FireplaceKernel`) and the band's drift in cents, all from absolute samples,
 * so time-addressable.
 */
export class FireplaceGenerator {
  private readonly sampleRate: number;
  private readonly brown: NoiseGenerator;
  private readonly pink: NoiseGenerator;
  private readonly flicker: DriftGenerator;
  private readonly band: DriftGenerator;
  private readonly events: FireplaceKernel;

  constructor(seed: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.brown = new NoiseGenerator("brown", seed, BROWN_STREAM, 2, sampleRate);
    this.pink = new NoiseGenerator("pink", seed, PINK_STREAM, 2, sampleRate);
    this.flicker = new DriftGenerator(
      seed,
      FLICKER_STREAM,
      FLICKER.rate,
      FLICKER.octaves,
      sampleRate,
    );
    this.band = new DriftGenerator(
      seed,
      BAND_STREAM,
      BAND_DRIFT.rate,
      BAND_DRIFT.octaves,
      sampleRate,
    );
    this.events = new FireplaceKernel(seed, sampleRate);
  }

  /** Sets the events' params: see `FireplaceKernel.set`. */
  set(size: number, crackle: number, softwood: boolean): void {
    this.events.set(size, crackle, softwood);
  }

  /** The flicker's gain at absolute sample `n`. */
  private flickerAt(n: number): number {
    return dbToGain(FLICKER.db * this.flicker.valueAtTime(n / this.sampleRate));
  }

  /** Fills `channels` (`FIREPLACE_CHANNELS` of one length) from absolute sample `start`. */
  render(channels: readonly Float32Array[], start: number): void {
    if (channels.length < FIREPLACE_CHANNELS) {
      return;
    }
    this.brown.render(0, channels[BROWN_CHANNEL], start);
    this.brown.render(1, channels[BROWN_CHANNEL + 1], start);
    this.pink.render(0, channels[PINK_CHANNEL], start);
    this.pink.render(1, channels[PINK_CHANNEL + 1], start);
    // The flicker, linear across the quantum between its values at either end.
    const length = channels[BROWN_CHANNEL].length;
    const from = this.flickerAt(start);
    const slope = (this.flickerAt(start + length) - from) / length;
    for (let c = BROWN_CHANNEL; c < PINK_CHANNEL + 2; c++) {
      const channel = channels[c];
      for (let i = 0; i < length; i++) {
        channel[i] *= from + slope * i;
      }
    }
    this.events.render(channels[EVENTS_CHANNEL], channels[EVENTS_CHANNEL + 1], start);
    channels[BAND_CHANNEL].fill(BAND_SWING_CENTS * this.band.valueAtTime(start / this.sampleRate));
  }
}
