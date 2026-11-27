/**
 * Life Support's seeded signals and valve events, and the waves and param
 * mappings the rest of the sound uses: pure code with no Web Audio globals,
 * run by `life-support.worklet.ts` and checked in Node.
 *
 * The worklet makes everything that depends on the seed, so a seed change
 * crossfades one node:
 *
 * - **Air.** Decorrelated counter-hashed white noise per side (each sample's
 *   hash gives both sides, one in each half), tilted to pink noise by three
 *   one-poles, then high-passed at 120 Hz, given a broad +4 dB of duct body
 *   around 600 Hz, and low-passed at 3.2 kHz. A slow drift moves the
 *   low-pass by up to 12 % and the level by about a decibel.
 * - **Surge.** Its own brown noise, band-passed around 240 Hz, in the centre:
 *   the fluid a pump pushes. The native pump cycle sets its level.
 * - **Valves.** Now and then, from per-block hashes of absolute time
 *   (`eventsInBlock`), a pressure valve releases: a hiss of white noise
 *   through a band-pass gliding down from 4.5 kHz, or a lower sigh from
 *   1.4 kHz. Each eases in over a quarter of a second, holds, and fades over
 *   a second, never more than 4 dB above the air in its own band.
 * - **The pump's drift.** A slow random walk of absolute time that varies how
 *   deep each pump cycle goes, so successive cycles differ.
 *
 * A render that starts afresh picks up the valves already sounding, part-way
 * through, then renders a short warm-up silently, so it lands on the same
 * samples as an unbroken render once the bed's filters settle.
 *
 * The pump's own shape, the motor and the hum are native nodes; their waves
 * and levels are worked out here too, so they are checked with the rest.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import {
  blockOf,
  createEventBlock,
  eventHash,
  eventsInBlock,
  type EventBlock,
} from "../../audio/dsp/events";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { Svf } from "../../audio/dsp/svf";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import type { LifeSupportValves } from "./life-support.meta";

export const LIFE_SUPPORT_PROCESSOR = "aural-life-support";

/** The worklet's output channels, in order. */
export const BED_LEFT = 0;
export const BED_RIGHT = 1;
export const VALVES_LEFT = 2;
export const VALVES_RIGHT = 3;
export const SURGE = 4;
export const PUMP_DRIFT = 5;
export const LIFE_SUPPORT_CHANNELS = 6;

/** Valve releases a second, on average, for each Valves setting. */
export const VALVE_RATES: Readonly<Record<LifeSupportValves, number>> = {
  off: 0,
  rarely: 1 / 300,
  sometimes: 1 / 90,
  often: 1 / 40,
};

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const raised = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));

/** Random streams: the air's noise, the surge's, valve times, and the two drifts. */
const AIR_STREAM = 0;
const SURGE_STREAM = 1;
export const VALVE_STREAM = 2;
const AIR_DRIFT_STREAM = 3;
const PUMP_DRIFT_STREAM = 4;

/** The air at Air flow 100, in dBFS RMS per channel: the level everything else is set against. */
export const AIR_DB = -21;
/** The air's level at Air flow 0, against 100, in dB. */
export const FLOW_FLOOR_DB = -14;
/** The surge at Pump 100 and the cycle's peak, against the air at Air flow 100, in dB. */
const SURGE_UNDER_AIR_DB = -5;
/** The motor at Pump 100 and the cycle's peak, against the surge there, in dB. */
const MOTOR_UNDER_SURGE_DB = -3;
/** The hum at Hum 100, against the air at Air flow 100, in dB. */
export const HUM_UNDER_AIR_DB = -26;
/** A valve's sustain against the air in its own band, before its own ±2 dB, in dB. */
export const VALVE_OVER_AIR_DB = 2;
export const VALVE_SPREAD_DB = 2;

/**
 * Pink noise from white: three one-poles (corner in Hz, gain at DC) plus a
 * little of the white itself, Paul Kellet's economy filter worked out in Hz
 * so it is the same at any sample rate.
 */
const PINK_CORNERS = [16.5, 264.6, 3945] as const;
const PINK_GAINS = [42.15, 8.014, 2.448] as const;
const PINK_DIRECT = 0.1848;

/** The air's filters, in Hz, their Q, and the duct body's boost, in dB. */
const AIR_HIGHPASS = 120;
const AIR_LOWPASS = 3200;
const AIR_Q = 0.6;
const BODY = 600;
const BODY_Q = 0.8;
const BODY_DB = 4;
/** How far the drift moves the low-pass (a share of its cutoff) and the level (in dB). */
const AIR_CUTOFF_SWING = 0.12;
const AIR_LEVEL_SWING_DB = 1;
/** The air's drift: knots per second of its slowest octave, and its octaves. */
const AIR_DRIFT_RATE = 0.05;
const AIR_DRIFT_OCTAVES = 2;

/** The surge: brown noise (white through a one-pole at this corner) band-passed here, in Hz. */
const SURGE_CORNER = 80;
const SURGE_CENTRE = 240;
const SURGE_Q = 1.5;

/** The pump's depth drift: rate and octaves. */
const PUMP_DRIFT_RATE = 0.01;
const PUMP_DRIFT_OCTAVES = 1;
/** How far the drift moves each cycle's depth: ±0.23, about ±2 dB. */
export const PUMP_DEPTH_SWING = 0.23;

/** Maps 16 bits of a hash, centred, onto −1..1. */
const HALF_SCALE = 2 / 65535;
/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** Uniform noise in [−1, 1) has this variance. */
const UNIFORM_VARIANCE = 1 / 3;

/** The air's gain at `flow` (0–100), against 100: −14 dB at 0, evenly in dB. */
export function flowGain(flow: number): number {
  return dbToGain(FLOW_FLOOR_DB * (1 - clamp01(flow / 100)));
}

/** The pump's share at `pump` (0–100): none at 0, full at 100, on a squared curve like a fader. */
export function pumpShare(pump: number): number {
  return clamp01(pump / 100) ** 2;
}

// ---------------------------------------------------------------------------
// Spectra, to set levels from the filters' shapes.

/** Analogue power responses, at `f` Hz. */
const onePolePower = (f: number, corner: number) => 1 / (1 + (f / corner) ** 2);
function lowpassPower(f: number, cutoff: number, q: number): number {
  const x = f / cutoff;
  return 1 / ((1 - x * x) ** 2 + (x / q) ** 2);
}
function highpassPower(f: number, cutoff: number, q: number): number {
  const x = f / cutoff;
  return x ** 4 / ((1 - x * x) ** 2 + (x / q) ** 2);
}
/** A band-pass of gain 1 at its centre. */
function bandpassPower(f: number, centre: number, q: number): number {
  const x = f / centre;
  return (x / q) ** 2 / ((1 - x * x) ** 2 + (x / q) ** 2);
}
/** A peaking boost of `gain` at `centre`: the input plus `gain − 1` of a band-pass. */
function peakPower(f: number, centre: number, q: number, gain: number): number {
  const x = f / centre;
  // The band-pass is (jx/q) / (1 − x² + jx/q).
  const re = 1 - x * x;
  const im = x / q;
  const denominator = re * re + im * im;
  const bandRe = (im * im) / denominator;
  const bandIm = (im * re) / denominator;
  return (1 + (gain - 1) * bandRe) ** 2 + ((gain - 1) * bandIm) ** 2;
}
/** The pink filter's power: its one-poles and the direct path add as complex gains. */
function pinkPower(f: number): number {
  let re = PINK_DIRECT;
  let im = 0;
  for (let i = 0; i < PINK_CORNERS.length; i++) {
    const x = f / PINK_CORNERS[i];
    const g = PINK_GAINS[i] / (1 + x * x);
    re += g;
    im -= g * x;
  }
  return re * re + im * im;
}

/** The air's power at `f`, before its level: pink, high-passed, with its body, low-passed. */
function airPower(f: number): number {
  return (
    pinkPower(f) *
    highpassPower(f, AIR_HIGHPASS, AIR_Q) *
    peakPower(f, BODY, BODY_Q, dbToGain(BODY_DB)) *
    lowpassPower(f, AIR_LOWPASS, AIR_Q)
  );
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

// ---------------------------------------------------------------------------
// The pump cycle, motor and hum: waves for native oscillators.

/** The pump cycle's stages, as shares of the cycle: rise, hold, fall, and the rest after. */
export const PUMP_RISE = 0.25;
export const PUMP_HOLD = 0.2;
export const PUMP_FALL = 0.35;
/** Fourier terms in the cycle's wave. */
export const PUMP_TERMS = 6;

/** The ideal pump cycle (0–1) at `phase` (in cycles): a raised-cosine rise, hold, fall, then rest. */
export function pumpShape(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < PUMP_RISE) {
    return raised(p / PUMP_RISE);
  }
  if (p < PUMP_RISE + PUMP_HOLD) {
    return 1;
  }
  if (p < PUMP_RISE + PUMP_HOLD + PUMP_FALL) {
    return 1 - raised((p - PUMP_RISE - PUMP_HOLD) / PUMP_FALL);
  }
  return 0;
}

/** A periodic wave as `PeriodicWave` coefficients (index 0 unused). */
interface WaveCoefficients {
  real: number[];
  imag: number[];
}

/** The wave's value at `phase` (in cycles). */
export function waveValue(wave: WaveCoefficients, phase: number): number {
  let sum = 0;
  for (let k = 1; k < wave.real.length; k++) {
    const angle = 2 * Math.PI * k * phase;
    sum += (wave.real[k] ?? 0) * Math.cos(angle) + (wave.imag[k] ?? 0) * Math.sin(angle);
  }
  return sum;
}

/** Samples per cycle when building and measuring the pump's waves. */
const RESOLUTION = 4096;

/** The pump cycle's first `PUMP_TERMS` Fourier terms, before normalising, and its mean. */
export function pumpSeries(): WaveCoefficients & { mean: number } {
  const real = [0];
  const imag = [0];
  let mean = 0;
  for (let m = 0; m < RESOLUTION; m++) {
    mean += pumpShape(m / RESOLUTION) / RESOLUTION;
  }
  for (let k = 1; k <= PUMP_TERMS; k++) {
    let a = 0;
    let b = 0;
    for (let m = 0; m < RESOLUTION; m++) {
      const phase = m / RESOLUTION;
      const x = pumpShape(phase);
      a += x * Math.cos(2 * Math.PI * k * phase);
      b += x * Math.sin(2 * Math.PI * k * phase);
    }
    real.push((2 * a) / RESOLUTION);
    imag.push((2 * b) / RESOLUTION);
  }
  return { real, imag, mean };
}

/**
 * The pump cycle as a wave for a native oscillator, normalised so that it
 * plus `offset` spans exactly 0..1. A `PeriodicWave` has no DC term, so
 * `offset` is also the cycle's mean.
 */
export function pumpWave(): WaveCoefficients & { offset: number } {
  const series = pumpSeries();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let m = 0; m < RESOLUTION; m++) {
    const v = waveValue(series, m / RESOLUTION);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const span = max - min;
  return {
    real: series.real.map((v) => v / span),
    imag: series.imag.map((v) => v / span),
    offset: -min / span,
  };
}

/**
 * The integral over one cycle of the pump wave (in cycles of phase): a wave
 * whose slope is the pump wave. With no DC term, it comes back to where it
 * started each cycle.
 */
export function pumpIntegralWave(): WaveCoefficients {
  const wave = pumpWave();
  const real = [0];
  const imag = [0];
  for (let k = 1; k < wave.real.length; k++) {
    const scale = 1 / (2 * Math.PI * k);
    real.push(-(wave.imag[k] ?? 0) * scale);
    imag.push((wave.real[k] ?? 0) * scale);
  }
  return { real, imag };
}

/** The largest magnitude of `wave` over a cycle. */
export function waveMagnitude(wave: WaveCoefficients): number {
  let max = 0;
  for (let m = 0; m < RESOLUTION; m++) {
    max = Math.max(max, Math.abs(waveValue(wave, m / RESOLUTION)));
  }
  return max;
}

/** The pump motor: its resting pitch in Hz, harmonics, their step and low-pass. */
export const MOTOR = 74;
export const MOTOR_HARMONICS = 6;
export const MOTOR_STEP_DB = -5;
const MOTOR_LOWPASS = 450;
const MOTOR_LOWPASS_Q = Math.SQRT1_2;
/** How far the motor spins up at the cycle's peak, in cents. */
export const SPIN_UP_CENTS = 60;
/** The motor's frequency ratio at the cycle's peak, less 1. */
const SPIN_UP = 2 ** (SPIN_UP_CENTS / 1200) - 1;
/** The pump cycle's longest length, in seconds, for the spin-up's delay line. */
export const LONGEST_CYCLE = 60;

/** The motor's low-pass gain at `frequency`. */
export function motorRolloff(frequency: number): number {
  const x = frequency / MOTOR_LOWPASS;
  return 1 / Math.hypot(1 - x * x, x / MOTOR_LOWPASS_Q);
}

/** The motor as `PeriodicWave` coefficients: sines, rolled off by its low-pass. */
export function motorWave(): WaveCoefficients {
  const imag = [0];
  for (let k = 1; k <= MOTOR_HARMONICS; k++) {
    imag.push(dbToGain(MOTOR_STEP_DB * (k - 1)) * motorRolloff(MOTOR * k));
  }
  return { real: imag.map(() => 0), imag };
}

/** A sine wave's RMS from its coefficients. */
function waveRms(wave: WaveCoefficients): number {
  let sum = 0;
  for (let k = 1; k < wave.real.length; k++) {
    sum += ((wave.real[k] ?? 0) ** 2 + (wave.imag[k] ?? 0) ** 2) / 2;
  }
  return Math.sqrt(sum);
}

/** The surge's RMS at Pump 100 and the cycle's peak. */
export const SURGE_RMS = dbToGain(AIR_DB + SURGE_UNDER_AIR_DB);

/** The motor's gain at the cycle's peak at Pump 100, from its wave at unit gain. */
export function motorGain(): number {
  return dbToGain(AIR_DB + SURGE_UNDER_AIR_DB + MOTOR_UNDER_SURGE_DB) / waveRms(motorWave());
}

/**
 * The motor's spin-up, as phase modulation through a moving delay line: the
 * oscillator runs at its mean pitch over a cycle, and the delay moves so
 * that the pitch heard is the resting pitch at the cycle's rest and
 * `SPIN_UP_CENTS` above it at the peak. A delay moving at rate r scales the
 * pitch by 1 − r, so the delay follows the integral of the cycle, which comes
 * back to where it started each cycle and so never runs away.
 */
export function spinUp(): {
  /** The oscillator's frequency, in Hz. */
  frequency: number;
  /** The delay's slope against the cycle's wave: the delay is `base + depth(T) · integral`. */
  depth: (cycle: number) => number;
  /** The delay line's resting delay and its longest, in seconds. */
  base: number;
  longest: number;
} {
  const { offset } = pumpWave();
  const k = SPIN_UP / (1 + SPIN_UP * offset);
  const swing = k * LONGEST_CYCLE * waveMagnitude(pumpIntegralWave());
  const base = swing + 0.01;
  return {
    frequency: MOTOR * (1 + SPIN_UP * offset),
    depth: (cycle) => -k * cycle,
    base,
    longest: 2 * base,
  };
}

/**
 * The hum: harmonics 1–4 of 100 Hz at 0, −8, −14 and −20 dB, plus a quiet
 * sine at 300 Hz for small speakers, which shares harmonic 3's pitch and so
 * goes into the same wave.
 */
export const HUM = 100;
export const HUM_LEVELS_DB = [0, -8, -14, -20] as const;
export const HUM_THIRD_DB = -12;

/** The hum as `PeriodicWave` coefficients. */
export function humWave(): WaveCoefficients {
  const imag = [
    0,
    ...HUM_LEVELS_DB.map((db, k) => dbToGain(db) + (k === 2 ? dbToGain(HUM_THIRD_DB) : 0)),
  ];
  return { real: imag.map(() => 0), imag };
}

/** The hum's gain at `hum` (0–100): none at 0, 26 dB under the air's full level at 100. */
export function humGain(hum: number): number {
  return (dbToGain(AIR_DB + HUM_UNDER_AIR_DB) / waveRms(humWave())) * clamp01(hum / 100);
}

// ---------------------------------------------------------------------------
// Valves.

/** The valves' kinds: a hiss, or a lower sigh, and the share that hiss. */
export const HISS = 0;
export const SIGH = 1;
const HISS_SHARE = 0.7;
/** Each kind's band-pass: start and end centres in Hz, Q, and how much longer it holds. */
export const VALVE_KINDS = [
  { from: 4500, to: 2200, q: 1.2, stretch: 1 },
  { from: 1400, to: 600, q: 0.9, stretch: 1.25 },
] as const;
/** A valve's hold, before its kind's stretch, in seconds. */
export const VALVE_SHORTEST = 0.8;
export const VALVE_LONGEST = 2.5;
/** Its attack and release, in seconds. */
export const VALVE_ATTACK = 0.25;
export const VALVE_RELEASE = 1;
/** Its place: −0.6..0.6. */
export const VALVE_PAN = 0.6;
/** The band-pass's centre and level are set on a grid of this many of the valve's own samples. */
const CONTROL = 32;
/** Centres at which the air's level in a valve's band is worked out, between its ends. */
const BAND_POINTS = 12;

/** Keys for a valve's own random properties: `hashStep(hash, key)`. */
const KIND = 1;
const LENGTH = 2;
const PAN = 3;
const LEVEL = 4;
const NOISE = 5;

const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;

/** What a valve's hash gives: its kind, hold, pan and level offset in dB. */
interface ValveSpec {
  kind: number;
  hold: number;
  pan: number;
  levelDb: number;
}

/** A valve's properties from its hash. */
export function valveSpec(hash: number): ValveSpec {
  const kind = unit(hash, KIND) < HISS_SHARE ? HISS : SIGH;
  return {
    kind,
    hold: lerp(VALVE_SHORTEST, VALVE_LONGEST, unit(hash, LENGTH)) * VALVE_KINDS[kind].stretch,
    pan: lerp(-VALVE_PAN, VALVE_PAN, unit(hash, PAN)),
    levelDb: lerp(-VALVE_SPREAD_DB, VALVE_SPREAD_DB, unit(hash, LEVEL)),
  };
}

/** A valve's whole length, in seconds: attack, hold and release. */
export function valveLength(hold: number): number {
  return VALVE_ATTACK + hold + VALVE_RELEASE;
}

/** A valve's envelope (0–1) `t` seconds in: a raised-cosine attack, a hold, a raised-cosine release. */
export function valveEnvelope(t: number, hold: number): number {
  if (t < 0 || t >= valveLength(hold)) {
    return 0;
  }
  if (t < VALVE_ATTACK) {
    return raised(t / VALVE_ATTACK);
  }
  if (t < VALVE_ATTACK + hold) {
    return 1;
  }
  return 1 - raised((t - VALVE_ATTACK - hold) / VALVE_RELEASE);
}

/** A valve's band-pass centre `t` seconds in: from its kind's start to its end, evenly in pitch. */
export function valveCentre(kind: number, t: number, hold: number): number {
  const { from, to } = VALVE_KINDS[kind];
  return from * (to / from) ** clamp01(t / valveLength(hold));
}

/**
 * Levels that depend only on the sample rate: the air's scale, the surge's,
 * and the air's RMS in each valve kind's band at `BAND_POINTS` centres, all
 * at Air flow 100. Worked out once per sample rate.
 */
interface Levels {
  airScale: number;
  surgeScale: number;
  bands: Float64Array[];
}

const levelCache = new Map<number, Levels>();

function levelsAt(sampleRate: number): Levels {
  const cached = levelCache.get(sampleRate);
  if (cached) {
    return cached;
  }
  const airRms = filteredRms(airPower, sampleRate);
  const airScale = dbToGain(AIR_DB) / airRms;
  const surgeRms = filteredRms(
    (f) => onePolePower(f, SURGE_CORNER) * bandpassPower(f, SURGE_CENTRE, SURGE_Q),
    sampleRate,
  );
  const bands = VALVE_KINDS.map(({ from, to, q }) =>
    Float64Array.from({ length: BAND_POINTS }, (_, i) => {
      const centre = from * (to / from) ** (i / (BAND_POINTS - 1));
      const rms = filteredRms((f) => airPower(f) * bandpassPower(f, centre, q), sampleRate);
      return rms * airScale;
    }),
  );
  const levels = { airScale, surgeScale: SURGE_RMS / surgeRms, bands };
  levelCache.set(sampleRate, levels);
  return levels;
}

/** The air's RMS per channel in a valve band of `kind` at `centre`, at Air flow 100. */
export function airInBand(kind: number, centre: number, sampleRate: number): number {
  const { from, to } = VALVE_KINDS[kind];
  const table = levelsAt(sampleRate).bands[kind];
  const x = clamp01(Math.log(centre / from) / Math.log(to / from)) * (BAND_POINTS - 1);
  const i = Math.min(Math.floor(x), BAND_POINTS - 2);
  const a = table[i] ?? 0;
  const b = table[i + 1] ?? 0;
  return a + (b - a) * (x - i);
}

/** One valve release: counter-hashed white noise through a gliding band-pass. */
class ValveVoice {
  active = false;
  private readonly sampleRate: number;
  private readonly svf: Svf;
  private kind = HISS;
  private hold = 1;
  private q = 1;
  private noise = 0;
  private end = 0;
  /** Samples since the valve started. */
  private position = 0;
  /** The valve's level against the air in its band, latched as it starts. */
  private level = 0;
  /** The noise's gain now, for the level at the centre now. */
  private scale = 0;
  private gainLeft = 0;
  private gainRight = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.svf = new Svf(sampleRate, VALVE_KINDS[HISS].from, VALVE_KINDS[HISS].q);
  }

  /**
   * Starts the valve with hash `hash`, `elapsed` samples in, at the air's
   * gain `air`, unless it has already ended.
   */
  start(hash: number, elapsed: number, air: number): void {
    const spec = valveSpec(hash);
    this.hold = spec.hold;
    this.end = Math.floor(valveLength(spec.hold) * this.sampleRate);
    if (elapsed >= this.end) {
      return;
    }
    this.kind = spec.kind;
    this.q = VALVE_KINDS[spec.kind].q;
    this.level = air * dbToGain(VALVE_OVER_AIR_DB + spec.levelDb);
    this.gainLeft = panLeft(spec.pan);
    this.gainRight = panRight(spec.pan);
    this.noise = hashStep(hash, NOISE);
    this.position = Math.max(0, elapsed);
    this.svf.reset();
    this.control(this.position - (this.position % CONTROL));
    this.active = true;
  }

  /** How far through its release the valve is, to pick a voice to take over. */
  get remaining(): number {
    return this.active ? this.end - this.position : 0;
  }

  /** Sets the band-pass and the noise's gain for the valve's sample `n`. */
  private control(n: number): void {
    const sr = this.sampleRate;
    const centre = valveCentre(this.kind, n / sr, this.hold);
    this.svf.set(centre, this.q);
    // A band-pass of peak gain 1 passes white noise's power over π·centre / 2Q.
    const white = Math.sqrt((UNIFORM_VARIANCE * Math.PI * centre) / (2 * this.q) / (sr / 2));
    // Panned at equal power: each side carries at most the valve's level, and half its power at the centre.
    this.scale = (this.level * airInBand(this.kind, centre, sr)) / white;
  }

  /** Adds samples `from` to `to` into the outputs. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): void {
    const sr = this.sampleRate;
    const svf = this.svf;
    let n = this.position;
    const stop = Math.min(to, from + (this.end - n));
    for (let i = from; i < stop; i++) {
      if (n % CONTROL === 0) {
        this.control(n);
      }
      const white = hashStep(this.noise, n) * UINT32_SCALE * 2 - 1;
      svf.tick(white);
      const x = svf.band * this.scale * valveEnvelope(n / sr, this.hold);
      left[i] = (left[i] ?? 0) + x * this.gainLeft;
      right[i] = (right[i] ?? 0) + x * this.gainRight;
      n++;
    }
    this.position = n;
    this.active = n < this.end;
  }
}

/**
 * Sets `into` to an `Svf`'s coefficients at `cutoff` Hz and resonance `q`, as
 * [a1, a2, a3, k], for a filter run inline in a hot loop (see `Svf` for the
 * method), and returns it.
 */
function svfCoefficients(
  into: Float64Array,
  cutoff: number,
  q: number,
  sampleRate: number,
): Float64Array {
  const fc = Math.min(Math.max(cutoff, 1), sampleRate * 0.49);
  const g = Math.tan((Math.PI * fc) / sampleRate);
  const k = 1 / q;
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  into[0] = a1;
  into[1] = a2;
  into[2] = g * a2;
  into[3] = k;
  return into;
}

/** Valves sounding at once. */
const VALVE_VOICES = 2;
/** The most valves one block can hold: far above any rate's. */
const BLOCK_CAPACITY = 8;
/** Blocks a fresh render looks back for valves still sounding (each under 4.4 s). */
const LOOKBACK = 5;
/** Seconds rendered silently before a render that starts afresh, for the filters to settle. */
const WARM_UP = 0.1;
/** The scratch buffers the warm-up renders into, in samples. */
const SCRATCH = 128;

interface Ramp {
  from: number;
  to: number;
}

/**
 * Everything the Life Support worklet makes, from absolute samples: the air
 * (stereo), the valves (stereo), the surge and the pump's drift, the same
 * whether rendered in one go or in chunks.
 */
export class LifeSupportKernel {
  private readonly seed: number;
  private readonly sampleRate: number;
  /** Hash prefixes: each sample's hash gives both sides' air, one in each half. */
  private readonly airPrefix: number;
  private readonly surgePrefix: number;
  private readonly pinkPoles: Float64Array;
  private readonly pinkInputs: Float64Array;
  /** The pink filters' states: left's three, then right's. */
  private readonly pink = new Float64Array(6);
  /**
   * The air's and the surge's filters, as `Svf` coefficients (`svfCoefficients`)
   * with their states kept here and run inline in the hot loop: the high-pass,
   * body and low-pass, and the surge's band-pass.
   */
  private readonly highpass: Float64Array;
  private readonly body: Float64Array;
  private readonly lowpass: Float64Array;
  private readonly surgeBand: Float64Array;
  /** The filters' states, two each: left's high-pass, body and low-pass, right's, then the surge's. */
  private readonly states = new Float64Array(14);
  private readonly bodyBoost = dbToGain(BODY_DB) - 1;
  private readonly surgePole: number;
  private readonly surgeInput: number;
  private surgeBrown = 0;
  private readonly airScale: number;
  private readonly surgeScale: number;
  private readonly airDrift: DriftGenerator;
  private readonly pumpDrift: DriftGenerator;
  private readonly valves: ValveVoice[];
  /** The params `set` gave: Air flow (0–100), and valves a second (latched per block). */
  private flow = 60;
  private rate = VALVE_RATES.rarely;
  /** The cutoff the low-passes hold. */
  private cutoff = Number.NaN;
  /** The air's gain at the end of the last render, to ramp from. */
  private air = Number.NaN;
  private readonly ramp: Ramp = { from: 0, to: 0 };
  /** The loaded block, its valves, and the next to start. */
  private block = Number.NaN;
  private readonly times: EventBlock = createEventBlock(BLOCK_CAPACITY);
  private next = 0;
  private readonly warmUpSamples: number;
  private readonly scratch = Array.from(
    { length: LIFE_SUPPORT_CHANNELS },
    () => new Float32Array(SCRATCH),
  );
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.seed = seed;
    this.sampleRate = sampleRate;
    const base = hashStep(HASH_START, seed);
    this.airPrefix = hashStep(base, AIR_STREAM);
    this.surgePrefix = hashStep(base, SURGE_STREAM);
    this.pinkPoles = Float64Array.from(PINK_CORNERS, (f) =>
      Math.exp((-2 * Math.PI * f) / sampleRate),
    );
    this.pinkInputs = Float64Array.from(
      PINK_GAINS,
      (g, i) => g * (1 - (this.pinkPoles[i] ?? 0)) * UNIFORM_TO_UNIT,
    );
    this.highpass = svfCoefficients(new Float64Array(4), AIR_HIGHPASS, AIR_Q, sampleRate);
    this.body = svfCoefficients(new Float64Array(4), BODY, BODY_Q, sampleRate);
    this.lowpass = svfCoefficients(new Float64Array(4), AIR_LOWPASS, AIR_Q, sampleRate);
    this.surgePole = Math.exp((-2 * Math.PI * SURGE_CORNER) / sampleRate);
    this.surgeInput = (1 - this.surgePole) * UNIFORM_TO_UNIT;
    this.surgeBand = svfCoefficients(new Float64Array(4), SURGE_CENTRE, SURGE_Q, sampleRate);
    const levels = levelsAt(sampleRate);
    this.airScale = levels.airScale;
    this.surgeScale = levels.surgeScale;
    this.airDrift = new DriftGenerator(
      seed,
      AIR_DRIFT_STREAM,
      AIR_DRIFT_RATE,
      AIR_DRIFT_OCTAVES,
      sampleRate,
    );
    this.pumpDrift = new DriftGenerator(
      seed,
      PUMP_DRIFT_STREAM,
      PUMP_DRIFT_RATE,
      PUMP_DRIFT_OCTAVES,
      sampleRate,
    );
    this.valves = Array.from({ length: VALVE_VOICES }, () => new ValveVoice(sampleRate));
    this.warmUpSamples = Math.ceil(WARM_UP * sampleRate);
  }

  /** Sets the params for the next render: Air flow (0–100), and valves a second. */
  set(flow: number, rate: number): void {
    this.flow = flow;
    this.rate = Math.max(0, rate);
  }

  /** How many valves are sounding. */
  get sounding(): number {
    return this.valves.filter((v) => v.active).length;
  }

  /**
   * Fills `outputs` (`LIFE_SUPPORT_CHANNELS` arrays of one length, in channel
   * order) from absolute sample `start`.
   */
  render(outputs: readonly Float32Array[], start: number): void {
    const length = outputs[0]?.length ?? 0;
    if (start !== this.expected) {
      this.warmUp(start);
    }
    this.process(outputs, length, start);
    this.expected = start + length;
  }

  /**
   * Picks up the valves that started up to `LOOKBACK` blocks before the
   * warm-up and are still sounding, each part-way through, then renders the
   * `WARM_UP` before `start` silently.
   */
  private warmUp(start: number): void {
    for (const valve of this.valves) {
      valve.active = false;
    }
    this.air = Number.NaN;
    const sr = this.sampleRate;
    let from = start - this.warmUpSamples;
    const first = blockOf(from, sr);
    for (let b = first - LOOKBACK; b < first; b++) {
      this.load(b);
      for (let i = 0; i < this.times.count; i++) {
        this.startValve(i, from - this.sampleOf(i));
      }
    }
    this.load(first);
    this.startDue(from - 1, from);
    while (from < start) {
      const length = Math.min(SCRATCH, start - from);
      this.process(this.scratch, length, from);
      from += length;
    }
  }

  /** Loads block `block`'s valves at the current rate, which the block keeps. */
  private load(block: number): void {
    this.block = block;
    eventsInBlock(this.seed, VALVE_STREAM, block, this.rate, this.times);
    this.next = 0;
  }

  /** The absolute sample valve `i` of the loaded block starts at. */
  private sampleOf(i: number): number {
    return (
      this.block * this.sampleRate + Math.floor((this.times.offsets[i] ?? 0) * this.sampleRate)
    );
  }

  /** Starts every valve of the loaded block due by absolute sample `due`, as far in as at `at`. */
  private startDue(due: number, at: number): void {
    while (this.next < this.times.count && this.sampleOf(this.next) <= due) {
      this.startValve(this.next, at - this.sampleOf(this.next));
      this.next++;
    }
  }

  /** Starts valve `i` of the loaded block, `elapsed` samples in, in a free voice or the nearest its end. */
  private startValve(i: number, elapsed: number): void {
    const hash = eventHash(this.seed, VALVE_STREAM, this.block, i);
    let voice = this.valves[0];
    for (const v of this.valves) {
      if (v.remaining < voice.remaining) {
        voice = v;
      }
    }
    voice.start(hash, elapsed, flowGain(this.flow));
  }

  /** Renders `length` samples from absolute sample `start` into `outputs`, overwriting them. */
  private process(outputs: readonly Float32Array[], length: number, start: number): void {
    const sr = this.sampleRate;
    const left = outputs[VALVES_LEFT];
    const right = outputs[VALVES_RIGHT];
    left.fill(0, 0, length);
    right.fill(0, 0, length);
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const block = blockOf(now, sr);
      if (block !== this.block) {
        this.load(block);
      }
      this.startDue(now, now);
      let end = Math.min(length, (block + 1) * sr - start);
      if (this.next < this.times.count) {
        end = Math.min(end, this.sampleOf(this.next) - start);
      }
      for (const valve of this.valves) {
        if (valve.active) {
          valve.render(left, right, pos, end);
        }
      }
      pos = end;
    }
    this.renderBed(outputs, length, start);
    // The pump's drift ramps between its values at either end of the quantum.
    const drift = outputs[PUMP_DRIFT];
    const driftFrom = this.pumpDrift.valueAt(start);
    const driftStep = (this.pumpDrift.valueAt(start + length) - driftFrom) / length;
    for (let i = 0; i < length; i++) {
      drift[i] = driftFrom + driftStep * i;
    }
  }

  /** The air and the surge. */
  private renderBed(outputs: readonly Float32Array[], length: number, start: number): void {
    const left = outputs[BED_LEFT];
    const right = outputs[BED_RIGHT];
    const surge = outputs[SURGE];
    const end = start + length;
    // The drift barely moves in a render quantum: the cutoff follows it each
    // quantum, and the level ramps between its values at either end.
    const driftStart = this.airDrift.valueAt(start);
    const cutoff = AIR_LOWPASS * (1 + AIR_CUTOFF_SWING * driftStart);
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      svfCoefficients(this.lowpass, cutoff, AIR_Q, this.sampleRate);
    }
    const base = this.airScale * flowGain(this.flow);
    const ramp = this.ramp;
    ramp.to = base * dbToGain(AIR_LEVEL_SWING_DB * this.airDrift.valueAt(end));
    ramp.from = Number.isNaN(this.air)
      ? base * dbToGain(AIR_LEVEL_SWING_DB * driftStart)
      : this.air;
    this.air = ramp.to;
    const airFrom = ramp.from;
    const airStep = (ramp.to - ramp.from) / length;

    const airPrefix = this.airPrefix;
    const surgePrefix = this.surgePrefix;
    const [p0 = 0, p1 = 0, p2 = 0] = this.pinkPoles;
    const [g0 = 0, g1 = 0, g2 = 0] = this.pinkInputs;
    const direct = PINK_DIRECT * UNIFORM_TO_UNIT;
    const pink = this.pink;
    let l0 = pink[0];
    let l1 = pink[1];
    let l2 = pink[2];
    let r0 = pink[3];
    let r1 = pink[4];
    let r2 = pink[5];
    const boost = this.bodyBoost;
    const surgePole = this.surgePole;
    const surgeInput = this.surgeInput;
    const surgeScale = this.surgeScale;
    let brown = this.surgeBrown;
    const [ha1 = 0, ha2 = 0, ha3 = 0, hk = 0] = this.highpass;
    const [ba1 = 0, ba2 = 0, ba3 = 0, bk = 0] = this.body;
    const [la1 = 0, la2 = 0, la3 = 0] = this.lowpass;
    const [sa1 = 0, sa2 = 0, sa3 = 0, sk = 0] = this.surgeBand;
    const st = this.states;
    let hl1 = st[0];
    let hl2 = st[1];
    let bl1 = st[2];
    let bl2 = st[3];
    let ll1 = st[4];
    let ll2 = st[5];
    let hr1 = st[6];
    let hr2 = st[7];
    let br1 = st[8];
    let br2 = st[9];
    let lr1 = st[10];
    let lr2 = st[11];
    let s1 = st[12];
    let s2 = st[13];
    // Each filter is `Svf.tick` written out: v3 = x − ic2, v1 = a1·ic1 + a2·v3,
    // v2 = ic2 + a2·ic1 + a3·v3, then ic1 = 2·v1 − ic1 and ic2 = 2·v2 − ic2;
    // low = v2, band = k·v1, high = x − k·v1 − v2.
    for (let i = 0; i < length; i++) {
      const n = start + i;
      // One hash per sample for the air: its high half for the left, its low half for the right.
      const hash = hashStep(airPrefix, n);
      const wl = (hash >>> 16) * HALF_SCALE - 1;
      const wr = (hash & 0xffff) * HALF_SCALE - 1;
      l0 = p0 * l0 + g0 * wl;
      l1 = p1 * l1 + g1 * wl;
      l2 = p2 * l2 + g2 * wl;
      r0 = p0 * r0 + g0 * wr;
      r1 = p1 * r1 + g1 * wr;
      r2 = p2 * r2 + g2 * wr;
      const gain = airFrom + airStep * (i + 1);

      // Left: high-pass, body, low-pass.
      let x = l0 + l1 + l2 + direct * wl;
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
      x += boost * bk * v1;
      v3 = x - ll2;
      v1 = la1 * ll1 + la2 * v3;
      v2 = ll2 + la2 * ll1 + la3 * v3;
      ll1 = 2 * v1 - ll1;
      ll2 = 2 * v2 - ll2;
      left[i] = gain * v2;

      // Right: the same.
      x = r0 + r1 + r2 + direct * wr;
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
      x += boost * bk * v1;
      v3 = x - lr2;
      v1 = la1 * lr1 + la2 * v3;
      v2 = lr2 + la2 * lr1 + la3 * v3;
      lr1 = 2 * v1 - lr1;
      lr2 = 2 * v2 - lr2;
      right[i] = gain * v2;

      // The surge's own noise, 32 bits of it, integrated to brown and band-passed.
      const white = hashStep(surgePrefix, n) * UINT32_SCALE * 2 - 1;
      brown = surgePole * brown + surgeInput * white;
      v3 = brown - s2;
      v1 = sa1 * s1 + sa2 * v3;
      v2 = s2 + sa2 * s1 + sa3 * v3;
      s1 = 2 * v1 - s1;
      s2 = 2 * v2 - s2;
      surge[i] = surgeScale * sk * v1;
    }
    pink[0] = l0;
    pink[1] = l1;
    pink[2] = l2;
    pink[3] = r0;
    pink[4] = r1;
    pink[5] = r2;
    st[0] = hl1;
    st[1] = hl2;
    st[2] = bl1;
    st[3] = bl2;
    st[4] = ll1;
    st[5] = ll2;
    st[6] = hr1;
    st[7] = hr2;
    st[8] = br1;
    st[9] = br2;
    st[10] = lr1;
    st[11] = lr2;
    st[12] = s1;
    st[13] = s2;
    this.surgeBrown = brown;
  }
}

interface LifeSupportOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readLifeSupportOptions(raw: unknown): LifeSupportOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
