/**
 * Ocean Waves' wave schedule, envelopes and noise, and the param mappings the
 * rest of the sound uses: pure code with no Web Audio globals, run by
 * `ocean.worklet.ts` and checked in Node.
 *
 * **Waves.** Time is cut into slots of `period` seconds from absolute time 0,
 * each holding one wave whose onset strays up to ±20 % of the period from the
 * slot's start (`WaveSchedule`), so gaps run from 0.6 to 1.4 periods. Each
 * wave's size, phase lengths and pan hash from its slot index, and a slow
 * drift of absolute time makes bigger waves come in sets. A wave has four
 * phases, each with its own envelope (`addWaveEnvelopes`): a raised-cosine swell,
 * the crash where it breaks, foam that spreads and fades, and the backwash
 * draining away. Every wave is silent `WAVE_LIFE` seconds after its onset, so
 * the envelopes at any moment sum the last few waves only.
 *
 * **Time-addressable.** At fixed params the envelopes are a pure function of
 * absolute time, computed on a grid of `GRID` samples aligned to absolute
 * sample 0 and interpolated linearly between (far below audible change at
 * these rates, and cheap). A period change re-anchors the schedule at the next
 * wave, which keeps its time; waves already sounding are unchanged.
 *
 * **Outputs** (`OCEAN_CHANNELS`): the bed's stereo brown noise at the level
 * the swell and crash raise it to; the water's stereo pink noise, under the
 * foam's envelope and pan, plus the same noise under the backwash's envelope
 * (with the pebbles' rattle) through the backwash's receding band; the bed's
 * low-pass cutoff, in Hz, which the swell and crash open; and the foam's churn,
 * in cents. The native graph does the fixed filtering. One node does it all:
 * every worklet node has a fixed cost.
 *
 * **Rattle.** On pebbles, short Hann-windowed bursts of counter-hashed noise,
 * at most one in each 1/400 s of absolute time, scaled by the backwash: a pure
 * function of the sample index, with no state to warm up.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { Svf } from "../../audio/dsp/svf";
import { NoiseGenerator } from "../../audio/noise-dsp";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import type { OceanShore } from "./ocean.meta";

export const OCEAN_PROCESSOR = "aural-ocean";

/** Random streams: the bed's noise, the water's noise, the waves, sets, churn and rattle. */
const BED_STREAM = 1;
const WATER_STREAM = 2;
const WAVE_STREAM = 3;
const SET_STREAM = 4;
const CHURN_STREAM = 5;
const RATTLE_STREAM = 6;

/**
 * The worklet's output channels: three stereo pairs (the bed, the foam and the
 * backwash, each from its first channel), then the controls.
 */
export const BED_CHANNEL = 0;
export const WATER_CHANNEL = 2;
export const CUTOFF_CHANNEL = 4;
export const CHURN_CHANNEL = 5;
export const OCEAN_CHANNELS = 6;

/** Envelope values are worked out every `GRID` samples, and interpolated between. */
const GRID = 64;

/** Onsets stray up to this fraction of the period either way from their slot's start. */
export const ONSET_JITTER = 0.2;
/** A wave's ranges, from–to: size (before sets), and its phases' lengths and time constants, in seconds. */
const SIZE = [0.55, 1] as const;
const SWELL_LENGTH = [2, 4] as const;
const BREAK_LENGTH = [0.3, 0.8] as const;
const FOAM_DECAY = [1.2, 2.5] as const;
const BACKWASH_LENGTH = [3, 5] as const;
/** The foam's pan, within ±0.3. */
const PAN_WIDTH = 0.3;
/** The swell falls with this time constant after the break, in seconds. */
const SWELL_DECAY = 1.5;
/** The crash rises over this, then falls with this time constant, in seconds. */
const CRASH_RISE = 0.15;
const CRASH_DECAY = 0.8;
/** The foam rises over this, in seconds. */
const FOAM_RISE = 0.2;
/**
 * The backwash starts this long after the break, once the foam has peaked,
 * and spends these shares of its length rising and fading (holding between).
 */
const BACKWASH_DELAY = 0.6;
const BACKWASH_RISE = 0.35;
const BACKWASH_FADE = 0.4;
/** The backwash's band falls this far across it, in cents (20 %). */
const RECEDE_CENTS = 1200 * Math.log2(0.8);
/** Every envelope fades out over the last `LIFE_FADE` seconds before `WAVE_LIFE`. */
export const WAVE_LIFE = 14;
const LIFE_FADE = 3;
/**
 * Waves the envelopes sum: the latest and the four before it. Gaps are at
 * least 0.6 × 6 s, so the fifth back started over 14 s ago and is silent.
 */
const LOOK_BACK = 4;
/** Sets: a drift of about one cycle per 90 s scales each wave's size by 0.75–1. */
const SET_RATE = 1 / 90;
const SET_FLOOR = 0.75;
/** The foam's churn: a drift of 0.3 Hz moving its low-pass by ±20 %, in cents. */
const CHURN_RATE = 0.3;
const CHURN_CENTS = 1200 * Math.log2(1.2);
/** Rattle: at most one burst per slot of 1/`RATTLE_SLOTS` s, each 0.5–1 ms, panned within ±0.6. */
const RATTLE_SLOTS = 400;
const RATTLE_LENGTH = [0.0005, 0.001] as const;
const RATTLE_PAN = 0.6;
/** The share of slots with a burst: 150 per second at the backwash's edges, 400 at its height. */
const RATTLE_MIN_SHARE = 150 / RATTLE_SLOTS;
/** A burst's peak against the backwash's noise. */
const RATTLE_GAIN = 0.8;
/** Below this backwash level the rattle is silent, and skipped. */
const RATTLE_FLOOR = 0.002;
/**
 * The backwash's band: its centre (Hz) before it recedes, and Q. Its level
 * against the foam: a softer fizz than the white water.
 */
const BACKWASH_CENTRE = 2500;
const BACKWASH_Q = 1.5;
const BACKWASH_MIX = 0.6;
/** Below this backwash level its band is silent: skipped, and its filters cleared. */
const BACKWASH_FLOOR = 1e-4;

/** The envelopes' indices in `WaveFrame.values`. */
export const SWELL = 0;
export const CRASH = 1;
export const FOAM_LEFT = 2;
export const FOAM_RIGHT = 3;
export const BACKWASH = 4;
/** The backwash band's fall, in cents (not clamped to 0..1). */
const RECEDE = 5;
const FRAME_SIZE = 6;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;
const dbToGain = (db: number) => 10 ** (db / 20);

/** A random property `key` of whatever `hash` stands for, in [0, 1). */
const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;
/** Half a cosine from 0 to 1 as `x` goes from 0 to 1. */
const rise = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * x);

/** A wave's own random properties, from its slot index. */
interface Wave {
  /**
   * Every envelope's peak, 0.64–1: the square root of the wave's size (0.55–1)
   * times its set's (0.75–1), so the biggest wave of a set is about 4 dB over
   * the smallest of a lull, rather than 8: noticeable, but gentle.
   */
  size: number;
  swell: number;
  hold: number;
  foamDecay: number;
  backwash: number;
  pan: number;
}

/** Keys for each wave's own random properties: `hashStep(waveHash, key)`. */
const KEY_JITTER = 1;
const KEY_SIZE = 2;
const KEY_SWELL = 3;
const KEY_BREAK = 4;
const KEY_FOAM = 5;
const KEY_BACKWASH = 6;
const KEY_PAN = 7;

/** The most period changes the schedule remembers: enough for every wave still sounding. */
const MAX_SEGMENTS = LOOK_BACK + 2;

/**
 * When each wave starts: slot `n` of `period` seconds, its onset jittered by
 * ±`ONSET_JITTER` of the period. A period change starts a new segment at the
 * next wave, which keeps its time; earlier waves keep theirs.
 */
export class WaveSchedule {
  private readonly prefix: number;
  /** Segments, oldest first: from wave `indices[i]` on, waves follow `periods[i]` from `times[i]`. */
  private readonly indices = new Float64Array(MAX_SEGMENTS);
  private readonly times = new Float64Array(MAX_SEGMENTS);
  private readonly periods = new Float64Array(MAX_SEGMENTS);
  private count = 1;

  constructor(seed: number, period: number) {
    this.prefix = hashStep(hashStep(HASH_START, seed), WAVE_STREAM);
    this.periods[0] = period;
  }

  /** The hash wave `n`'s random properties come from. */
  hash(n: number): number {
    return hashStep(this.prefix, n);
  }

  /** The newest segment that wave `n` belongs to. */
  private segment(n: number): number {
    for (let s = this.count - 1; s > 0; s--) {
      if (n >= this.indices[s]) {
        return s;
      }
    }
    return 0;
  }

  /** The onset of wave `n`, in seconds of absolute time. */
  onset(n: number): number {
    const s = this.segment(n);
    const period = this.periods[s];
    const jitter = (unit(this.hash(n), KEY_JITTER) * 2 - 1) * ONSET_JITTER;
    return this.times[s] + (n - this.indices[s] + jitter) * period;
  }

  /** The latest wave whose onset is at or before `t`. */
  latest(t: number): number {
    const s = this.count - 1;
    const period = this.periods[s];
    let n = this.indices[s] + Math.floor((t - this.times[s]) / period);
    while (this.onset(n) > t) {
      n--;
    }
    while (this.onset(n + 1) <= t) {
      n++;
    }
    return n;
  }

  /**
   * Changes the period from the first wave after `t` (absolute seconds) on.
   * Returns whether anything changed.
   */
  setPeriod(period: number, t: number): boolean {
    const last = this.count - 1;
    if (!(period > 0) || period === this.periods[last]) {
      return false;
    }
    const next = this.latest(t) + 1;
    const time = this.onset(next);
    let s = last;
    if (next !== this.indices[last] || last === 0) {
      if (this.count === MAX_SEGMENTS) {
        this.indices.copyWithin(0, 1);
        this.times.copyWithin(0, 1);
        this.periods.copyWithin(0, 1);
        this.count--;
      }
      s = this.count;
      this.count++;
    }
    const jitter = (unit(this.hash(next), KEY_JITTER) * 2 - 1) * ONSET_JITTER;
    this.indices[s] = next;
    this.periods[s] = period;
    // Solve for the segment's start so wave `next` keeps its onset, with its new jitter.
    this.times[s] = time - jitter * period;
    return true;
  }
}

/**
 * Adds wave `wave`'s envelopes at `age` seconds after its onset into `out`
 * (indexed by `SWELL` … `BACKWASH`), and its backwash's progress (0–1, weighted
 * by the backwash) into `out[RECEDE]`.
 */
export function addWaveEnvelopes(wave: Wave, age: number, out: Float64Array): void {
  if (age < 0 || age >= WAVE_LIFE) {
    return;
  }
  const fade = age > WAVE_LIFE - LIFE_FADE ? rise((WAVE_LIFE - age) / LIFE_FADE) : 1;
  const level = wave.size * fade;
  const since = age - wave.swell;
  out[SWELL] += level * (since < 0 ? rise(age / wave.swell) : Math.exp(-since / SWELL_DECAY));
  if (since < 0) {
    return;
  }
  const crash =
    since < CRASH_RISE
      ? rise(since / CRASH_RISE)
      : since < CRASH_RISE + wave.hold
        ? 1
        : Math.exp(-(since - CRASH_RISE - wave.hold) / CRASH_DECAY);
  out[CRASH] += level * crash;
  const foam =
    level *
    (since < FOAM_RISE ? rise(since / FOAM_RISE) : Math.exp(-(since - FOAM_RISE) / wave.foamDecay));
  // A balance rather than a pan law: the nearer side at full level, the farther turned down.
  out[FOAM_LEFT] += foam * Math.min(1, 1 - wave.pan);
  out[FOAM_RIGHT] += foam * Math.min(1, 1 + wave.pan);
  const progress = (since - BACKWASH_DELAY) / wave.backwash;
  if (progress > 0 && progress < 1) {
    const backwash =
      level *
      (progress < BACKWASH_RISE
        ? rise(progress / BACKWASH_RISE)
        : progress > 1 - BACKWASH_FADE
          ? rise((1 - progress) / BACKWASH_FADE)
          : 1);
    out[BACKWASH] += backwash;
    out[RECEDE] += backwash * progress;
  }
}

/**
 * The waves' envelopes at any absolute time: `swell`, `crash`, `foamLeft`,
 * `foamRight` and `backwash`, each 0..1, and how far the backwash's band has
 * fallen, in cents.
 */
export class WaveField {
  readonly schedule: WaveSchedule;
  private readonly sets: DriftGenerator;
  private readonly wave: Wave = { size: 0, swell: 1, hold: 0, foamDecay: 1, backwash: 1, pan: 0 };

  constructor(seed: number, period: number, sampleRate: number) {
    this.schedule = new WaveSchedule(seed, period);
    this.sets = new DriftGenerator(seed, SET_STREAM, SET_RATE, 1, sampleRate);
  }

  /** Fills `out` (`FRAME_SIZE` long) with the envelopes at `t`, absolute seconds. */
  at(t: number, out: Float64Array): void {
    out.fill(0);
    const schedule = this.schedule;
    const latest = schedule.latest(t);
    for (let n = latest - LOOK_BACK; n <= latest; n++) {
      const onset = schedule.onset(n);
      if (t - onset < WAVE_LIFE) {
        this.load(n, onset);
        addWaveEnvelopes(this.wave, t - onset, out);
      }
    }
    // Weighted by the backwash, with a floor, so it eases back to 0 as the backwash fades.
    out[RECEDE] = (RECEDE_CENTS * out[RECEDE]) / (out[BACKWASH] + 0.01);
    for (let i = 0; i < RECEDE; i++) {
      out[i] = Math.min(1, out[i]);
    }
  }

  /** Loads wave `n`'s properties into `this.wave`. */
  private load(n: number, onset: number): void {
    const hash = this.schedule.hash(n);
    // The set drift is within ±0.8; map it to 0..1.
    const set = clamp01(this.sets.valueAtTime(onset) / 1.6 + 0.5);
    const w = this.wave;
    w.size = Math.sqrt(lerp(SIZE, unit(hash, KEY_SIZE)) * (SET_FLOOR + (1 - SET_FLOOR) * set));
    w.swell = lerp(SWELL_LENGTH, unit(hash, KEY_SWELL));
    w.hold = lerp(BREAK_LENGTH, unit(hash, KEY_BREAK));
    w.foamDecay = lerp(FOAM_DECAY, unit(hash, KEY_FOAM));
    w.backwash = lerp(BACKWASH_LENGTH, unit(hash, KEY_BACKWASH));
    w.pan = (unit(hash, KEY_PAN) * 2 - 1) * PAN_WIDTH;
  }
}

// Param mappings: `size` and `distance` are 0–100, as the params hold them.

/** The bed's low-pass, in Hz: this at rest, plus `SWELL_CUTOFF` × the swell and `crashCutoff` × the crash. */
export const BED_CUTOFF = 180;
export const SWELL_CUTOFF = 500;

/**
 * How far the crash opens the bed's low-pass, in Hz: 1.5 kHz for the smallest
 * waves to 3.5 kHz for the biggest, close up; far away, 600 Hz, so the whole
 * low-pass stays near 1.2 kHz at a crash. Evenly in octaves between.
 */
export function crashCutoff(size: number, distance: number): number {
  const close = 1500 + 2000 * clamp01(size / 100);
  return close * (600 / close) ** clamp01(distance / 100);
}

/** The bed's level at rest, as a gain: −18 dB. The swell and crash add to it. */
const BED_REST = dbToGain(-18);

/** How much the swell adds to the bed's gain: more for bigger waves, less far away. */
function swellWeight(size: number, distance: number): number {
  return (0.2 + 0.1 * clamp01(size / 100)) * (1 - 0.3 * clamp01(distance / 100));
}

/** How much the crash adds to the bed's gain: its weight, from lapping to surf; less far away. */
function crashWeight(size: number, distance: number): number {
  return (0.1 + 0.5 * Math.sqrt(clamp01(size / 100))) * (1 - 0.5 * clamp01(distance / 100));
}

/** The foam's low-pass, in Hz: 6.5 kHz close, 3 kHz far, evenly in octaves between. */
export function foamCutoff(distance: number): number {
  return 6500 * (3000 / 6500) ** clamp01(distance / 100);
}

/** The foam's level, as a gain: grows with the waves, and falls 10 dB far away. */
export function foamLevel(size: number, distance: number): number {
  return dbToGain(-10 * clamp01(distance / 100)) * (0.3 + 0.6 * Math.sqrt(clamp01(size / 100)));
}

/**
 * The whole sound's level, in dB: 2.5 dB down for the biggest waves, which
 * gain their weight from brightness and sustain rather than loudness, so a big
 * set's crash stays clear of the peak limit; and up to 1.5 dB up far away,
 * where the crash and foam have dulled and the bed carries more.
 */
export function outputDb(size: number, distance: number): number {
  return -2.5 * clamp01((size - 50) / 50) + 1.5 * clamp01(distance / 100);
}

/** The outdoor reverb send at `distance`, in dB: −34 close, −20 far. */
export function sendDb(distance: number): number {
  return -34 + 14 * clamp01(distance / 100);
}

/**
 * The pebbles' rattle: at most one burst in each slot of 1/`RATTLE_SLOTS` s of
 * absolute time, each a Hann-windowed burst of counter-hashed white noise. A
 * burst can run into the next slot, so the rattle at a sample sums its slot's
 * burst and the one before. Everything hashes from the slot index, so it is a
 * pure function of the sample.
 */
export class Rattle {
  private readonly prefix: number;
  private readonly sampleRate: number;
  /** The slot whose burst is in entry 1; entry 0 holds the slot before. */
  private slot = Number.NaN;
  /** Per entry: start (absolute sample), length (samples), peak, pan gains, noise hash, threshold. */
  private readonly starts = new Float64Array(2);
  private readonly lengths = new Float64Array(2);
  private readonly peaks = new Float64Array(2);
  private readonly lefts = new Float64Array(2);
  private readonly rights = new Float64Array(2);
  private readonly hashes = new Uint32Array(2);
  private readonly thresholds = new Float64Array(2);
  /** The last `next`'s output. */
  left = 0;
  right = 0;

  constructor(seed: number, sampleRate: number) {
    this.prefix = hashStep(hashStep(HASH_START, seed), RATTLE_STREAM);
    this.sampleRate = sampleRate;
  }

  /** Sets `left` and `right` to the rattle at absolute sample `n`, with the backwash at `backwash` (0..1). */
  next(n: number, backwash: number): void {
    this.left = 0;
    this.right = 0;
    const slot = Math.floor((n * RATTLE_SLOTS) / this.sampleRate);
    if (slot !== this.slot) {
      if (slot === this.slot + 1) {
        this.copyForward();
      } else {
        this.load(slot - 1, 0);
      }
      this.load(slot, 1);
      this.slot = slot;
    }
    // A slot's burst sounds when its threshold is under the share for this backwash.
    const share = RATTLE_MIN_SHARE + (1 - RATTLE_MIN_SHARE) * backwash;
    for (let i = 0; i < 2; i++) {
      const position = n - this.starts[i];
      const length = this.lengths[i];
      if (position < 0 || position >= length || this.thresholds[i] >= share) {
        continue;
      }
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * position) / length);
      const noise = hashStep(this.hashes[i], position) * UINT32_SCALE * 2 - 1;
      const y = this.peaks[i] * window * noise;
      this.left += y * this.lefts[i];
      this.right += y * this.rights[i];
    }
  }

  /** Loads slot `slot`'s burst into entry `i`. */
  private load(slot: number, i: number): void {
    const hash = hashStep(this.prefix, slot);
    const sr = this.sampleRate;
    this.starts[i] = Math.floor(((slot + unit(hash, 1)) / RATTLE_SLOTS) * sr);
    this.lengths[i] = Math.max(2, Math.round(lerp(RATTLE_LENGTH, unit(hash, 2)) * sr));
    // A power law: most bursts are soft, a few are clear.
    const size = unit(hash, 3);
    this.peaks[i] = size * size;
    const pan = (unit(hash, 4) * 2 - 1) * RATTLE_PAN;
    this.lefts[i] = panLeft(pan);
    this.rights[i] = panRight(pan);
    this.hashes[i] = hashStep(hash, 5);
    this.thresholds[i] = unit(hash, 6);
  }

  private copyForward(): void {
    this.starts[0] = this.starts[1];
    this.lengths[0] = this.lengths[1];
    this.peaks[0] = this.peaks[1];
    this.lefts[0] = this.lefts[1];
    this.rights[0] = this.rights[1];
    this.hashes[0] = this.hashes[1];
    this.thresholds[0] = this.thresholds[1];
  }
}

interface OceanOptions {
  seed: number;
  shore: OceanShore;
  /** The wave period at the start, in seconds. */
  period: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The default period, for options that lack one. */
const DEFAULT_PERIOD = 10;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readOceanOptions(raw: unknown): OceanOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const period = numberOr(get("period"), DEFAULT_PERIOD);
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    shore: get("shore") === "pebbles" ? "pebbles" : "sand",
    period: period > 0 ? period : DEFAULT_PERIOD,
    offset: numberOr(get("offset"), 0),
  };
}

/**
 * Everything the ocean worklet makes, into `OCEAN_CHANNELS` channels, from absolute samples, so time-addressable at fixed params.
 */
export class OceanGenerator {
  readonly field: WaveField;
  private readonly sampleRate: number;
  private readonly bed: NoiseGenerator;
  private readonly water: NoiseGenerator;
  private readonly churn: DriftGenerator;
  private readonly rattle: Rattle | undefined;
  /** `setShape`'s params, and what follows from them. */
  private size = Number.NaN;
  private distance = Number.NaN;
  private swellWeight = 0;
  private crashWeight = 0;
  private crashCutoff = 0;
  /** The backwash's band, per channel. */
  private readonly backwashLeft: Svf;
  private readonly backwashRight: Svf;
  /** The envelopes at grid point `grid`, and at the next one. */
  private grid = Number.NaN;
  private current = new Float64Array(FRAME_SIZE);
  private following = new Float64Array(FRAME_SIZE);

  constructor(seed: number, shore: OceanShore, period: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.field = new WaveField(seed, period, sampleRate);
    this.bed = new NoiseGenerator("brown", seed, BED_STREAM, 2, sampleRate);
    this.water = new NoiseGenerator("pink", seed, WATER_STREAM, 2, sampleRate);
    this.churn = new DriftGenerator(seed, CHURN_STREAM, CHURN_RATE, 2, sampleRate);
    this.rattle = shore === "pebbles" ? new Rattle(seed, sampleRate) : undefined;
    this.backwashLeft = new Svf(sampleRate, BACKWASH_CENTRE, BACKWASH_Q);
    this.backwashRight = new Svf(sampleRate, BACKWASH_CENTRE, BACKWASH_Q);
    this.setShape(50, 0);
  }

  /**
   * Sets the wave size and distance (0–100), which scale how far the swell and
   * crash raise the bed's level and open its low-pass.
   */
  setShape(size: number, distance: number): void {
    if (size === this.size && distance === this.distance) {
      return;
    }
    this.size = size;
    this.distance = distance;
    this.swellWeight = swellWeight(size, distance);
    this.crashWeight = crashWeight(size, distance);
    this.crashCutoff = crashCutoff(size, distance);
  }

  /** Changes the wave period from the first wave after absolute sample `n`. */
  setPeriod(period: number, n: number): void {
    if (this.field.schedule.setPeriod(period, n / this.sampleRate)) {
      // Grid values worked out ahead may belong to the old schedule.
      this.grid = Number.NaN;
    }
  }

  /**
   * Fills `channels` (`OCEAN_CHANNELS` of one length) from absolute sample
   * `start`.
   */
  render(channels: readonly Float32Array[], start: number): void {
    if (channels.length < OCEAN_CHANNELS) {
      return;
    }
    const bedLeft = channels[BED_CHANNEL];
    const bedRight = channels[BED_CHANNEL + 1];
    const waterLeft = channels[WATER_CHANNEL];
    const waterRight = channels[WATER_CHANNEL + 1];
    const cutoff = channels[CUTOFF_CHANNEL];
    const churn = channels[CHURN_CHANNEL];
    this.bed.render(0, bedLeft, start);
    this.bed.render(1, bedRight, start);
    this.water.render(0, waterLeft, start);
    this.water.render(1, waterRight, start);
    this.churn.render(churn, start);
    const rattle = this.rattle;
    const bandLeft = this.backwashLeft;
    const bandRight = this.backwashRight;
    for (let i = 0; i < waterLeft.length; i++) {
      const n = start + i;
      const g = Math.floor(n / GRID);
      if (g !== this.grid) {
        this.advance(g);
      }
      const f = (n - g * GRID) / GRID;
      // The bed: its level and low-pass, raised and opened by the swell and crash.
      const swell = this.value(SWELL, f);
      const crash = this.value(CRASH, f);
      const level = BED_REST + this.swellWeight * swell + this.crashWeight * crash;
      bedLeft[i] *= level;
      bedRight[i] *= level;
      cutoff[i] = BED_CUTOFF + SWELL_CUTOFF * swell + this.crashCutoff * crash;
      churn[i] *= CHURN_CENTS;
      const left = waterLeft[i];
      const right = waterRight[i];
      let waterL = left * this.value(FOAM_LEFT, f);
      let waterR = right * this.value(FOAM_RIGHT, f);
      // The backwash: the same noise under its envelope, with the rattle on
      // pebbles, through its receding band, joining the foam.
      const back = this.value(BACKWASH, f);
      if (back > BACKWASH_FLOOR) {
        let rattleLeft = 0;
        let rattleRight = 0;
        if (rattle && back > RATTLE_FLOOR) {
          rattle.next(n, back);
          rattleLeft = rattle.left * RATTLE_GAIN;
          rattleRight = rattle.right * RATTLE_GAIN;
        }
        bandLeft.tick((left + rattleLeft) * back);
        bandRight.tick((right + rattleRight) * back);
        waterL += bandLeft.band * BACKWASH_MIX;
        waterR += bandRight.band * BACKWASH_MIX;
      } else {
        bandLeft.reset();
        bandRight.reset();
      }
      waterLeft[i] = waterL;
      waterRight[i] = waterR;
    }
  }

  /** Envelope `k`, a fraction `f` of the way from the current grid point to the next. */
  private value(k: number, f: number): number {
    const a = this.current[k];
    return a + (this.following[k] - a) * f;
  }

  /** Moves the envelope grid to point `g`. */
  private advance(g: number): void {
    if (g === this.grid + 1) {
      const swap = this.current;
      this.current = this.following;
      this.following = swap;
    } else {
      this.field.at((g * GRID) / this.sampleRate, this.current);
    }
    this.field.at(((g + 1) * GRID) / this.sampleRate, this.following);
    this.grid = g;
    const centre = BACKWASH_CENTRE * 2 ** (this.current[RECEDE] / 1200);
    this.backwashLeft.set(centre, BACKWASH_Q);
    this.backwashRight.set(centre, BACKWASH_Q);
  }
}
