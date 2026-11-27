/**
 * Airplane Cabin's seeded parts, and the param mappings the rest of the sound
 * uses: pure code with no Web Audio globals, run by `airplane.worklet.ts` and
 * checked in Node.
 *
 * The worklet makes, for one seed:
 *
 * - **Rumble.** Decorrelated counter-hashed white noise per side (each
 *   sample's hash gives both sides, one in each half), through one filter
 *   that sums brown noise and pink noise 6 dB under it, then a cruise cabin's
 *   shape: a high-pass at 45 Hz, a broad +5 dB body around 180 Hz, a low-pass
 *   at 1.6 kHz (Q 0.5) and a gentle one-pole low-pass at 4 kHz. The seat
 *   moves the low-pass: 30 % higher at the front, where the airflow over the
 *   nose is loudest, 20 % lower at the rear. A slow drift moves the level by
 *   ±0.8 dB and the body by ±1 dB: changes in the air and the thrust.
 * - **Vent.** The overhead air nozzle: the same white noise through a
 *   high-pass at 1.8 kHz and a low-pass at 7 kHz, a little louder on the
 *   right, its level drifting by ±1 dB.
 * - **Chime.** Once in a long while, a soft two-tone chime far up the cabin:
 *   a note and the major third under it, each a sine with a faint inharmonic
 *   partial, on its own channel for the reverb send.
 * - **Wander.** Two slow drifts, one per engine, that the native engines'
 *   delay lines follow, so their pitch wanders without breaking time.
 *
 * The engines themselves are native oscillators; their speeds, waves and
 * levels are worked out here too.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { blockOf, createEventBlock, eventsInBlock } from "../../audio/dsp/events";
import { svfCoefficients } from "../../audio/dsp/svf";
import { hashFloat, HASH_START, hashStep } from "../../audio/random";
import type { AirplaneChime, AirplaneSeat } from "./airplane.meta";

export const AIRPLANE_PROCESSOR = "aural-airplane";
/** The worklet's output channels, in order. */
export const RUMBLE_LEFT = 0;
export const RUMBLE_RIGHT = 1;
export const CHIME = 2;
export const WANDER_FIRST = 3;
export const WANDER_SECOND = 4;
export const AIRPLANE_CHANNELS = 5;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Random streams: each source of randomness its own. */
const NOISE_STREAM = 0;
const RUMBLE_DRIFT_STREAM = 1;
const VENT_DRIFT_STREAM = 2;
const WANDER_STREAMS = [3, 4] as const;
const CHIME_STREAM = 5;
const ENGINE_STREAM = 6;
const CHIME_ROOT_STREAM = 7;

// ---------------------------------------------------------------------------
// The rumble and the vent.

/** The rumble's level at the defaults, in dBFS RMS per channel. */
export const RUMBLE_DB = -24;
/** The pink noise under the brown, in dB (RMS, after the high-pass). */
const PINK_UNDER_BROWN_DB = -6;
/** Brown noise: white through a one-pole at this corner, in Hz. */
const BROWN_CORNER = 40;
/**
 * Pink noise from white: three one-poles (corner in Hz, gain at DC) plus a
 * little of the white itself, Paul Kellet's economy filter worked out in Hz
 * so it is the same at any sample rate.
 */
const PINK_CORNERS = [16.5, 264.6, 3945] as const;
const PINK_GAINS = [42.15, 8.014, 2.448] as const;
const PINK_DIRECT = 0.1848;
/**
 * The cabin's shape: a high-pass high enough to keep the brown noise's
 * energy below 25 Hz well down, a broad body, a low-pass and a gentle
 * one-pole above it.
 */
const HIGHPASS = 45;
const HIGHPASS_Q = Math.SQRT1_2;
const BODY = 180;
const BODY_Q = 0.6;
const BODY_DB = 5;
const LOWPASS = 1600;
const LOWPASS_Q = 0.5;
const TOP = 4000;
/** How far the drift moves the rumble's level and its body, in dB either way. */
const RUMBLE_SWING_DB = 0.8;
const BODY_SWING_DB = 1;
const RUMBLE_DRIFT_RATE = 0.02;
const RUMBLE_DRIFT_OCTAVES = 2;

/** The vent's band, in Hz, and its filters' Q. */
const VENT_HIGHPASS = 1800;
const VENT_LOWPASS = 7000;
const VENT_Q = 0.6;
/** The vent at Air vent 100, against the rumble, in dB. */
export const VENT_UNDER_RUMBLE_DB = -16;
/** The vent's right side against its left, in dB. */
export const VENT_RIGHT_DB = 1;
/** How far the drift moves the vent's level, in dB either way. */
const VENT_SWING_DB = 1;
const VENT_DRIFT_RATE = 0.12;
const VENT_DRIFT_OCTAVES = 2;

/** Each seat: the rumble's low-pass, as a multiple of `LOWPASS`, and the engines' level, in dB. */
export const SEATS: Readonly<Record<AirplaneSeat, { lowpass: number; enginesDb: number }>> = {
  front: { lowpass: 1.3, enginesDb: -6 },
  wing: { lowpass: 1, enginesDb: 0 },
  rear: { lowpass: 0.8, enginesDb: 4 },
};

/** Maps 16 bits of a hash, centred, onto −1..1. */
const HALF_SCALE = 2 / 65535;
/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);

// Spectra, to set the levels from the filters' shapes.

function highpassPower(f: number, cutoff: number, q: number): number {
  const x = f / cutoff;
  return x ** 4 / ((1 - x * x) ** 2 + (x / q) ** 2);
}
function lowpassPower(f: number, cutoff: number, q: number): number {
  const x = f / cutoff;
  return 1 / ((1 - x * x) ** 2 + (x / q) ** 2);
}
function onePolePower(f: number, cutoff: number): number {
  return 1 / (1 + (f / cutoff) ** 2);
}
/** A peaking boost of `gain` at `centre`: the input plus `gain − 1` of a band-pass. */
function peakPower(f: number, centre: number, q: number, gain: number): number {
  const x = f / centre;
  const re = 1 - x * x;
  const im = x / q;
  const denominator = re * re + im * im;
  const bandRe = (im * im) / denominator;
  const bandIm = (im * re) / denominator;
  return (1 + (gain - 1) * bandRe) ** 2 + ((gain - 1) * bandIm) ** 2;
}

/** The noise filter's one-poles (corner in Hz, gain at DC) and direct term. */
interface NoiseFilter {
  corners: number[];
  gains: number[];
  direct: number;
}

/** Power of one-poles in parallel plus a direct term, added as complex gains. */
function parallelPower(f: number, filter: NoiseFilter): number {
  let re = filter.direct;
  let im = 0;
  for (let i = 0; i < filter.corners.length; i++) {
    const x = f / (filter.corners[i] ?? 1);
    const g = (filter.gains[i] ?? 0) / (1 + x * x);
    re += g;
    im -= g * x;
  }
  return re * re + im * im;
}

/** Points and range of the log-spaced spectrum integrals, in Hz. */
const SPECTRUM_POINTS = 2400;
const SPECTRUM_BOTTOM = 2;
const SPECTRUM_TOP_RATIO = 0.45;

/**
 * The RMS of unit-variance white noise through a filter of power response
 * `power`, from its analogue form, close to the digital one this far below
 * Nyquist: the integral of the power over frequency, on a log scale.
 */
function filteredRms(power: (f: number) => number, sampleRate: number): number {
  const top = SPECTRUM_TOP_RATIO * sampleRate;
  const step = Math.log(top / SPECTRUM_BOTTOM) / SPECTRUM_POINTS;
  let sum = 0;
  for (let i = 0; i < SPECTRUM_POINTS; i++) {
    const f = SPECTRUM_BOTTOM * Math.exp((i + 0.5) * step);
    sum += power(f) * f;
  }
  return Math.sqrt((sum * step) / (sampleRate / 2));
}

/** The noise filter: brown, with pink 6 dB under it once both are high-passed. */
function noiseFilter(sampleRate: number): NoiseFilter {
  const highpass = (f: number) => highpassPower(f, HIGHPASS, HIGHPASS_Q);
  const pink: NoiseFilter = {
    corners: [...PINK_CORNERS],
    gains: [...PINK_GAINS],
    direct: PINK_DIRECT,
  };
  const pinkRms = filteredRms((f) => parallelPower(f, pink) * highpass(f), sampleRate);
  const brownRms = filteredRms(
    (f) => parallelPower(f, { corners: [BROWN_CORNER], gains: [1], direct: 0 }) * highpass(f),
    sampleRate,
  );
  const pinkScale = (brownRms / pinkRms) * dbToGain(PINK_UNDER_BROWN_DB);
  return {
    corners: [...PINK_CORNERS, BROWN_CORNER],
    gains: [...PINK_GAINS.map((g) => g * pinkScale), 1],
    direct: PINK_DIRECT * pinkScale,
  };
}

/** The rumble's power at `f` with the low-pass at `lowpass` Hz, before its level. */
function rumblePower(f: number, filter: NoiseFilter, lowpass: number): number {
  return (
    parallelPower(f, filter) *
    highpassPower(f, HIGHPASS, HIGHPASS_Q) *
    peakPower(f, BODY, BODY_Q, dbToGain(BODY_DB)) *
    lowpassPower(f, lowpass, LOWPASS_Q) *
    onePolePower(f, TOP)
  );
}

/**
 * The vent's power at `f`. Its band reaches high enough that the digital
 * filters' warping matters: each responds at `f` as its analogue prototype
 * does at the prewarped frequency, which falls to nothing at Nyquist.
 */
function ventPower(f: number, sampleRate: number): number {
  const warp = (x: number) => Math.tan((Math.PI * Math.min(x, sampleRate * 0.4999)) / sampleRate);
  const x = warp(f);
  return (
    highpassPower(x, warp(VENT_HIGHPASS), VENT_Q) * lowpassPower(x, warp(VENT_LOWPASS), VENT_Q)
  );
}

/** The share of the rumble's power below `f` Hz, over the wing, for checks. */
export function rumbleShareBelow(f: number, sampleRate: number): number {
  const filter = noiseFilter(sampleRate);
  const power = (x: number) => rumblePower(x, filter, LOWPASS);
  const below = filteredRms((x) => (x < f ? power(x) : 0), sampleRate);
  return (below / filteredRms(power, sampleRate)) ** 2;
}

/** The rumble's level in `seat`'s low-pass against over the wing, in dB, for checks. */
export function seatRumbleDb(seat: AirplaneSeat, sampleRate: number): number {
  const filter = noiseFilter(sampleRate);
  const rms = (scale: number) =>
    filteredRms((f) => rumblePower(f, filter, LOWPASS * scale), sampleRate);
  return 20 * Math.log10(rms(SEATS[seat].lowpass) / rms(1));
}

/** The rumble and vent's gains for unit-variance white noise, worked out once per sample rate. */
interface Scales {
  rumble: number;
  vent: number;
}
const scaleCache = new Map<number, Scales>();

function scales(filter: NoiseFilter, sampleRate: number): Scales {
  const cached = scaleCache.get(sampleRate);
  if (cached) {
    return cached;
  }
  const result = {
    rumble: dbToGain(RUMBLE_DB) / filteredRms((f) => rumblePower(f, filter, LOWPASS), sampleRate),
    vent:
      dbToGain(RUMBLE_DB + VENT_UNDER_RUMBLE_DB) /
      filteredRms((f) => ventPower(f, sampleRate), sampleRate),
  };
  scaleCache.set(sampleRate, result);
  return result;
}

/** The vent's share of its level at 100 at `vent` (0–100): none at 0. */
export function ventShare(vent: number): number {
  return clamp01(vent / 100);
}

// ---------------------------------------------------------------------------
// The engines: native oscillators, worked out here.

/** The first engine's rotation, in Hz, and how much faster the second turns. */
export const ROTATION_RANGE = [62, 70] as const;
export const OFFSET_RANGE = [0.25, 0.58] as const;
/** The buzz's harmonics: falling 5 dB a step, the fourth lifted 3 dB. */
const ENGINE_HARMONICS = 6;
const ENGINE_STEP_DB = -5;
const BUZZ_HARMONIC = 4;
const BUZZ_LIFT_DB = 3;
/** The fan's blade-pass, at this multiple of the first engine's rotation, against its buzz. */
export const BLADE_RATIO = 22;
export const BLADE_UNDER_BUZZ_DB = -18;
/** Both engines at Engines 100, against the rumble, in dB per channel. */
export const ENGINES_UNDER_RUMBLE_DB = -12;
/**
 * Where the engines sit: the first a little left, the second a little right
 * (equal-power pans of ∓0.4), and a centred copy of the first, 6 dB down, so
 * their beating survives in mono.
 */
const ENGINE_PAN = 0.4;
const CENTRED_DB = -6;
/**
 * Each engine's pitch wanders through a delay line: its base delay and swing,
 * in seconds, and its drift's rate. A delay moving at rate r shifts the pitch
 * by a fraction r; a one-octave drift moves at most about 2.3 × its rate a
 * second, so a swing of 65 ms keeps the pitch within about ±0.15 %.
 */
export const WANDER_DELAY = 0.1;
export const WANDER_SWING = 0.065;
const WANDER_RATES = [0.01, 0.0117] as const;
const WANDER_OCTAVES = 1;

/** The engines' speeds for `seed`, in Hz: the second a little faster, so they beat. */
export function engineSpeeds(seed: number): { first: number; second: number } {
  const [low, high] = ROTATION_RANGE;
  const [least, most] = OFFSET_RANGE;
  const first = low + (high - low) * hashFloat(seed, ENGINE_STREAM, 0);
  return { first, second: first + least + (most - least) * hashFloat(seed, ENGINE_STREAM, 1) };
}

/** A wave as `PeriodicWave` coefficients (index 0 unused). */
interface WaveCoefficients {
  real: number[];
  imag: number[];
}

/** The buzz's amplitude at harmonic `k` (1–6). */
function buzzLevel(k: number): number {
  return dbToGain(ENGINE_STEP_DB * (k - 1) + (k === BUZZ_HARMONIC ? BUZZ_LIFT_DB : 0));
}

/** The buzz alone's RMS. */
function buzzRms(): number {
  let sum = 0;
  for (let k = 1; k <= ENGINE_HARMONICS; k++) {
    sum += buzzLevel(k) ** 2 / 2;
  }
  return Math.sqrt(sum);
}

/**
 * An engine's wave as `PeriodicWave` coefficients: the buzz, and for the
 * first engine the fan's faint blade-pass tone at 22 times its rotation,
 * which a sine needs no filter for.
 */
export function engineWave(withBlades: boolean): WaveCoefficients {
  const imag = [0];
  for (let k = 1; k <= ENGINE_HARMONICS; k++) {
    imag.push(buzzLevel(k));
  }
  if (withBlades) {
    while (imag.length < BLADE_RATIO) {
      imag.push(0);
    }
    imag.push(buzzRms() * Math.SQRT2 * dbToGain(BLADE_UNDER_BUZZ_DB));
  }
  return { real: imag.map(() => 0), imag };
}

/** A wave's RMS from its coefficients. */
function waveRms(wave: WaveCoefficients): number {
  let sum = 0;
  for (let k = 1; k < wave.real.length; k++) {
    sum += ((wave.real[k] ?? 0) ** 2 + (wave.imag[k] ?? 0) ** 2) / 2;
  }
  return Math.sqrt(sum);
}

/** Each engine's gain into each side. */
interface EngineGains {
  firstLeft: number;
  firstRight: number;
  secondLeft: number;
  secondRight: number;
}

/**
 * The engines' gains at `engines` (0–100) in `seat`, for their waves at unit
 * gain: none at 0, and at 100 both engines together 12 dB under the rumble
 * per channel (6 dB less at the front, 4 dB more at the rear), on a linear
 * fader.
 */
export function engineGains(engines: number, seat: AirplaneSeat): EngineGains {
  const angle = (pan: number) => ((pan + 1) * Math.PI) / 4;
  const centred = dbToGain(CENTRED_DB);
  const firstLeft = Math.cos(angle(-ENGINE_PAN)) + centred;
  const firstRight = Math.sin(angle(-ENGINE_PAN)) + centred;
  const secondLeft = Math.cos(angle(ENGINE_PAN));
  const secondRight = Math.sin(angle(ENGINE_PAN));
  // The engines turn at different speeds, so their powers add.
  const first = waveRms(engineWave(true)) ** 2;
  const second = waveRms(engineWave(false)) ** 2;
  const power =
    (first * (firstLeft ** 2 + firstRight ** 2) + second * (secondLeft ** 2 + secondRight ** 2)) /
    2;
  const level =
    (dbToGain(RUMBLE_DB + ENGINES_UNDER_RUMBLE_DB + SEATS[seat].enginesDb) / Math.sqrt(power)) *
    clamp01(engines / 100);
  return {
    firstLeft: level * firstLeft,
    firstRight: level * firstRight,
    secondLeft: level * secondLeft,
    secondRight: level * secondRight,
  };
}

/** The engines' beat period for `seed`, in seconds. */
export function beatPeriod(seed: number): number {
  const { first, second } = engineSpeeds(seed);
  return 1 / (second - first);
}

// ---------------------------------------------------------------------------
// The chime.

/** How often a chime sounds, per second: Rarely about once in 25 minutes, Sometimes in 8. */
export const CHIME_RATES: Readonly<Record<AirplaneChime, number>> = {
  off: 0,
  rarely: 1 / 1500,
  sometimes: 1 / 480,
};
/** The chime's root (the lower note), in Hz, by seed; the first note is a major third above. */
export const ROOT_RANGE = [560, 620] as const;
export const MAJOR_THIRD = 5 / 4;
/** The second note follows the first by this long, in seconds. */
export const NOTE_GAP = 0.45;
/** Each note's attack, its decay's time constant and its length, in seconds. */
const ATTACK = 0.008;
const DECAY = 0.35;
export const NOTE_LENGTH = 2.4;
/** The last of each note fades out to nothing over this long, in seconds. */
const TAIL = 0.3;
/** Each note's inharmonic partial, at this multiple of the note and level; it fades twice as fast. */
const PARTIAL_RATIO = 2.76;
const PARTIAL_DB = -14;
/** The chime's peak, against the rumble's RMS, in dB: never more. */
export const CHIME_OVER_RUMBLE_DB = 8;
/** A chime only starts after this many whole blocks with none, so two never overlap. */
const QUIET_BLOCKS = 4;
/** How far back a fresh render looks for a chime still sounding, in blocks. */
const LOOK_BACK = Math.ceil(NOTE_GAP + NOTE_LENGTH);
/** The most candidates a block can hold: far above any rate's. */
const CHIME_CAPACITY = 8;

const PARTIAL = dbToGain(PARTIAL_DB);
/**
 * The scale that keeps a chime under its peak: both notes at once, each at
 * its own peak (the first has decayed by the time the second starts, so the
 * real peak sits a decibel or two under).
 */
const CHIME_SCALE =
  dbToGain(RUMBLE_DB + CHIME_OVER_RUMBLE_DB) /
  ((1 + PARTIAL) * (1 + Math.exp(-(NOTE_GAP - ATTACK) / DECAY)));

/** The chime's root for `seed`, in Hz. */
export function chimeRoot(seed: number): number {
  const [low, high] = ROOT_RANGE;
  return low + (high - low) * hashFloat(seed, CHIME_ROOT_STREAM);
}

/** One note of frequency `f`, `t` seconds after it starts, before the chime's scale. */
export function chimeNote(f: number, t: number): number {
  if (!(t > 0 && t < NOTE_LENGTH)) {
    return 0;
  }
  const rise = t < ATTACK ? t / ATTACK : 1;
  const tail = Math.min(1, (NOTE_LENGTH - t) / TAIL);
  const decay = Math.exp(-Math.max(0, t - ATTACK) / DECAY);
  const phase = 2 * Math.PI * f * t;
  return (
    rise * tail * decay * (Math.sin(phase) + PARTIAL * decay * Math.sin(PARTIAL_RATIO * phase))
  );
}

/**
 * The chimes for one seed: where each starts, from the blocks of absolute
 * time, and their sound. The rate latches as each block loads.
 */
export class Chimes {
  private readonly seed: number;
  private readonly high: number;
  private readonly low: number;
  private readonly events = createEventBlock(CHIME_CAPACITY);
  private readonly scan = createEventBlock(CHIME_CAPACITY);
  /** The chime sounding or due, in absolute seconds, or NaN for none. */
  private start = Number.NaN;
  /** The last block loaded. */
  private block = Number.NaN;

  constructor(seed: number) {
    this.seed = seed;
    this.low = chimeRoot(seed);
    this.high = this.low * MAJOR_THIRD;
  }

  /** When a chime starts in `block` at `rate` per second, in absolute seconds, or NaN for none. */
  startIn(block: number, rate: number): number {
    if (eventsInBlock(this.seed, CHIME_STREAM, block, rate, this.events) === 0) {
      return Number.NaN;
    }
    for (let b = block - QUIET_BLOCKS; b < block; b++) {
      if (eventsInBlock(this.seed, CHIME_STREAM, b, rate, this.scan) > 0) {
        return Number.NaN;
      }
    }
    return block + this.events.offsets[0];
  }

  private load(block: number, rate: number): void {
    const start = this.startIn(block, rate);
    if (!Number.isNaN(start)) {
      this.start = start;
    }
    this.block = block;
  }

  /**
   * Fills `out` from absolute sample `start`, at `rate` chimes per second. A
   * fresh start (`fresh`) looks back for a chime still sounding.
   */
  render(out: Float32Array, start: number, sampleRate: number, rate: number, fresh: boolean): void {
    const length = out.length;
    const first = blockOf(start, sampleRate);
    const last = blockOf(start + length - 1, sampleRate);
    if (fresh) {
      this.start = Number.NaN;
      for (let b = first - LOOK_BACK; b <= first; b++) {
        this.load(b, rate);
      }
    }
    for (let b = this.block + 1; b <= last; b++) {
      this.load(b, rate);
    }
    const t0 = this.start;
    const from = start / sampleRate - t0;
    if (Number.isNaN(t0) || from >= NOTE_GAP + NOTE_LENGTH || from + length / sampleRate <= 0) {
      out.fill(0);
      return;
    }
    const high = this.high;
    const low = this.low;
    for (let i = 0; i < length; i++) {
      const t = from + i / sampleRate;
      out[i] = CHIME_SCALE * (chimeNote(high, t) + chimeNote(low, t - NOTE_GAP));
    }
  }
}

// ---------------------------------------------------------------------------
// The kernel.

/**
 * Fills `out` with `drift` from absolute sample `start` to `end`: it barely
 * moves in a render quantum, so a ramp between its values at either end.
 */
function rampDrift(out: Float32Array, drift: DriftGenerator, start: number, end: number): void {
  const from = drift.valueAt(start);
  const step = (drift.valueAt(end) - from) / out.length;
  for (let j = 0; j < out.length; j++) {
    out[j] = from + step * j;
  }
}

/**
 * The Airplane Cabin worklet's output for one seed, from absolute samples:
 * the same whether rendered in one go or in chunks, at steady params.
 */
export class AirplaneKernel {
  private readonly sampleRate: number;
  private readonly prefix: number;
  /** The noise filter's poles and input gains: pink's three, then brown's. */
  private readonly poles: Float64Array;
  private readonly inputs: Float64Array;
  private readonly direct: number;
  /** Its states: left's four, then right's. */
  private readonly noise = new Float64Array(8);
  /** The filters, as `svfCoefficients`, and their states: left's ten, then right's. */
  private readonly highpass: Float64Array;
  private readonly body: Float64Array;
  private readonly lowpass = new Float64Array(4);
  private readonly ventHigh: Float64Array;
  private readonly ventLow: Float64Array;
  private readonly states = new Float64Array(20);
  /** The one-pole above the low-pass: its pole and each side's state. */
  private readonly topPole: number;
  private readonly top = new Float64Array(2);
  private readonly rumbleScale: number;
  private readonly ventScale: number;
  private readonly rumbleDrift: DriftGenerator;
  private readonly ventDrift: DriftGenerator;
  private readonly firstWander: DriftGenerator;
  private readonly secondWander: DriftGenerator;
  private readonly chimes: Chimes;
  /** The params `set` gave. */
  private lowpassScale = SEATS.wing.lowpass;
  private vent = 0;
  private chimeRate = 0;
  /** The cutoff the low-passes hold. */
  private cutoff = Number.NaN;
  /** The levels at the end of the last render, to ramp from: rumble, body boost, vent. */
  private rumble = Number.NaN;
  private boost = Number.NaN;
  private ventGain = Number.NaN;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.prefix = hashStep(hashStep(HASH_START, seed), NOISE_STREAM);
    const filter = noiseFilter(sampleRate);
    this.poles = Float64Array.from(filter.corners, (f) =>
      Math.exp((-2 * Math.PI * f) / sampleRate),
    );
    this.inputs = Float64Array.from(
      filter.gains,
      (g, i) => g * (1 - (this.poles[i] ?? 0)) * UNIFORM_TO_UNIT,
    );
    this.direct = filter.direct * UNIFORM_TO_UNIT;
    this.highpass = svfCoefficients(new Float64Array(4), HIGHPASS, HIGHPASS_Q, sampleRate);
    this.body = svfCoefficients(new Float64Array(4), BODY, BODY_Q, sampleRate);
    this.ventHigh = svfCoefficients(new Float64Array(4), VENT_HIGHPASS, VENT_Q, sampleRate);
    this.ventLow = svfCoefficients(new Float64Array(4), VENT_LOWPASS, VENT_Q, sampleRate);
    this.topPole = Math.exp((-2 * Math.PI * TOP) / sampleRate);
    const s = scales(filter, sampleRate);
    this.rumbleScale = s.rumble;
    this.ventScale = s.vent;
    const drift = (stream: number, rate: number, octaves: number) =>
      new DriftGenerator(seed, stream, rate, octaves, sampleRate);
    this.rumbleDrift = drift(RUMBLE_DRIFT_STREAM, RUMBLE_DRIFT_RATE, RUMBLE_DRIFT_OCTAVES);
    this.ventDrift = drift(VENT_DRIFT_STREAM, VENT_DRIFT_RATE, VENT_DRIFT_OCTAVES);
    this.firstWander = drift(WANDER_STREAMS[0], WANDER_RATES[0], WANDER_OCTAVES);
    this.secondWander = drift(WANDER_STREAMS[1], WANDER_RATES[1], WANDER_OCTAVES);
    this.chimes = new Chimes(seed);
  }

  /**
   * Sets the params for the next render: the rumble's low-pass as a multiple
   * of its own (the seat), Air vent (0–100), and chimes per second.
   */
  set(lowpassScale: number, vent: number, chimeRate: number): void {
    this.lowpassScale = lowpassScale;
    this.vent = vent;
    this.chimeRate = chimeRate;
  }

  /** Fills `outputs` (`AIRPLANE_CHANNELS` arrays of one length, in channel order) from absolute sample `start`. */
  render(outputs: readonly Float32Array[], start: number): void {
    const left = outputs[RUMBLE_LEFT];
    const right = outputs[RUMBLE_RIGHT];
    const length = left.length;
    const sr = this.sampleRate;
    const end = start + length;
    const fresh = start !== this.expected;
    if (fresh) {
      // A fresh start: levels start where they stand rather than ramping from the past.
      this.rumble = Number.NaN;
      this.boost = Number.NaN;
      this.ventGain = Number.NaN;
    }
    this.expected = end;

    this.chimes.render(outputs[CHIME], start, sr, this.chimeRate, fresh);
    rampDrift(outputs[WANDER_FIRST], this.firstWander, start, end);
    rampDrift(outputs[WANDER_SECOND], this.secondWander, start, end);

    const cutoff = LOWPASS * this.lowpassScale;
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      svfCoefficients(this.lowpass, cutoff, LOWPASS_Q, sr);
    }

    // The drifts barely move in a render quantum: levels ramp between their values at either end.
    const rumbleTo = this.rumbleAt(end);
    const rumbleFrom = Number.isNaN(this.rumble) ? this.rumbleAt(start) : this.rumble;
    this.rumble = rumbleTo;
    const rumbleStep = (rumbleTo - rumbleFrom) / length;
    const boostTo = this.boostAt(end);
    const boostFrom = Number.isNaN(this.boost) ? this.boostAt(start) : this.boost;
    this.boost = boostTo;
    const boostStep = (boostTo - boostFrom) / length;
    const ventTo = this.ventAt(end);
    const ventFrom = Number.isNaN(this.ventGain) ? this.ventAt(start) : this.ventGain;
    this.ventGain = ventTo;
    const ventStep = (ventTo - ventFrom) / length;
    const ventLeft = dbToGain(-VENT_RIGHT_DB / 2);
    const ventRight = dbToGain(VENT_RIGHT_DB / 2);

    const prefix = this.prefix;
    const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = this.poles;
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0] = this.inputs;
    const direct = this.direct;
    const [ha1 = 0, ha2 = 0, ha3 = 0, hk = 0] = this.highpass;
    const [ba1 = 0, ba2 = 0, ba3 = 0, bk = 0] = this.body;
    const [la1 = 0, la2 = 0, la3 = 0] = this.lowpass;
    const [va1 = 0, va2 = 0, va3 = 0, vk = 0] = this.ventHigh;
    const [wa1 = 0, wa2 = 0, wa3 = 0] = this.ventLow;
    const topPole = this.topPole;
    const topGain = 1 - topPole;
    const nz = this.noise;
    let l0 = nz[0];
    let l1 = nz[1];
    let l2 = nz[2];
    let l3 = nz[3];
    let r0 = nz[4];
    let r1 = nz[5];
    let r2 = nz[6];
    let r3 = nz[7];
    const st = this.states;
    let hl1 = st[0];
    let hl2 = st[1];
    let bl1 = st[2];
    let bl2 = st[3];
    let ll1 = st[4];
    let ll2 = st[5];
    let vl1 = st[6];
    let vl2 = st[7];
    let wl1 = st[8];
    let wl2 = st[9];
    let hr1 = st[10];
    let hr2 = st[11];
    let br1 = st[12];
    let br2 = st[13];
    let lr1 = st[14];
    let lr2 = st[15];
    let vr1 = st[16];
    let vr2 = st[17];
    let wr1 = st[18];
    let wr2 = st[19];
    let tl = this.top[0];
    let tr = this.top[1];
    // Each filter is `svfCoefficients`' tick written out.
    for (let i = 0; i < length; i++) {
      const k = i + 1;
      // One hash per sample: its high half for the left, its low half for the right.
      const hash = hashStep(prefix, start + i);
      const wl = (hash >>> 16) * HALF_SCALE - 1;
      const wr = (hash & 0xffff) * HALF_SCALE - 1;
      l0 = p0 * l0 + g0 * wl;
      l1 = p1 * l1 + g1 * wl;
      l2 = p2 * l2 + g2 * wl;
      l3 = p3 * l3 + g3 * wl;
      r0 = p0 * r0 + g0 * wr;
      r1 = p1 * r1 + g1 * wr;
      r2 = p2 * r2 + g2 * wr;
      r3 = p3 * r3 + g3 * wr;
      const boost = (boostFrom + boostStep * k) * bk;
      const rumble = rumbleFrom + rumbleStep * k;
      const vent = (ventFrom + ventStep * k) * UNIFORM_TO_UNIT;

      // Left: the rumble's high-pass, body, low-pass and top; the vent's high-pass and low-pass.
      let x = l0 + l1 + l2 + l3 + direct * wl;
      let v3 = x - hl2;
      let v1 = ha1 * hl1 + ha2 * v3;
      let v2 = hl2 + ha2 * hl1 + ha3 * v3;
      hl1 = 2 * v1 - hl1;
      hl2 = 2 * v2 - hl2;
      x = x - hk * v1 - v2;
      v3 = x - bl2;
      v1 = ba1 * bl1 + ba2 * v3;
      v2 = bl2 + ba2 * bl1 + ba3 * v3;
      bl1 = 2 * v1 - bl1;
      bl2 = 2 * v2 - bl2;
      x += boost * v1;
      v3 = x - ll2;
      v1 = la1 * ll1 + la2 * v3;
      v2 = ll2 + la2 * ll1 + la3 * v3;
      ll1 = 2 * v1 - ll1;
      ll2 = 2 * v2 - ll2;
      tl += topGain * (v2 - tl);
      v3 = wl - vl2;
      v1 = va1 * vl1 + va2 * v3;
      v2 = vl2 + va2 * vl1 + va3 * v3;
      vl1 = 2 * v1 - vl1;
      vl2 = 2 * v2 - vl2;
      x = wl - vk * v1 - v2;
      v3 = x - wl2;
      v1 = wa1 * wl1 + wa2 * v3;
      v2 = wl2 + wa2 * wl1 + wa3 * v3;
      wl1 = 2 * v1 - wl1;
      wl2 = 2 * v2 - wl2;
      left[i] = rumble * tl + vent * ventLeft * v2;

      // Right: the same.
      x = r0 + r1 + r2 + r3 + direct * wr;
      v3 = x - hr2;
      v1 = ha1 * hr1 + ha2 * v3;
      v2 = hr2 + ha2 * hr1 + ha3 * v3;
      hr1 = 2 * v1 - hr1;
      hr2 = 2 * v2 - hr2;
      x = x - hk * v1 - v2;
      v3 = x - br2;
      v1 = ba1 * br1 + ba2 * v3;
      v2 = br2 + ba2 * br1 + ba3 * v3;
      br1 = 2 * v1 - br1;
      br2 = 2 * v2 - br2;
      x += boost * v1;
      v3 = x - lr2;
      v1 = la1 * lr1 + la2 * v3;
      v2 = lr2 + la2 * lr1 + la3 * v3;
      lr1 = 2 * v1 - lr1;
      lr2 = 2 * v2 - lr2;
      tr += topGain * (v2 - tr);
      v3 = wr - vr2;
      v1 = va1 * vr1 + va2 * v3;
      v2 = vr2 + va2 * vr1 + va3 * v3;
      vr1 = 2 * v1 - vr1;
      vr2 = 2 * v2 - vr2;
      x = wr - vk * v1 - v2;
      v3 = x - wr2;
      v1 = wa1 * wr1 + wa2 * v3;
      v2 = wr2 + wa2 * wr1 + wa3 * v3;
      wr1 = 2 * v1 - wr1;
      wr2 = 2 * v2 - wr2;
      right[i] = rumble * tr + vent * ventRight * v2;
    }
    nz[0] = l0;
    nz[1] = l1;
    nz[2] = l2;
    nz[3] = l3;
    nz[4] = r0;
    nz[5] = r1;
    nz[6] = r2;
    nz[7] = r3;
    st[0] = hl1;
    st[1] = hl2;
    st[2] = bl1;
    st[3] = bl2;
    st[4] = ll1;
    st[5] = ll2;
    st[6] = vl1;
    st[7] = vl2;
    st[8] = wl1;
    st[9] = wl2;
    st[10] = hr1;
    st[11] = hr2;
    st[12] = br1;
    st[13] = br2;
    st[14] = lr1;
    st[15] = lr2;
    st[16] = vr1;
    st[17] = vr2;
    st[18] = wr1;
    st[19] = wr2;
    this.top[0] = tl;
    this.top[1] = tr;
  }

  /** The rumble's gain at absolute sample `n`, moved by its drift. */
  private rumbleAt(n: number): number {
    return this.rumbleScale * dbToGain(RUMBLE_SWING_DB * this.rumbleDrift.valueAt(n));
  }

  /** The body's boost at absolute sample `n` (its gain less 1), moved by the same drift. */
  private boostAt(n: number): number {
    return dbToGain(BODY_DB + BODY_SWING_DB * this.rumbleDrift.valueAt(n)) - 1;
  }

  /** The vent's gain at absolute sample `n`, moved by its drift. */
  private ventAt(n: number): number {
    return (
      this.ventScale * ventShare(this.vent) * dbToGain(VENT_SWING_DB * this.ventDrift.valueAt(n))
    );
  }
}

interface AirplaneOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readAirplaneOptions(raw: unknown): AirplaneOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
