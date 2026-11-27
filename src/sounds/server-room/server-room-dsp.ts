/**
 * Server Room's sound: pure code with no Web Audio globals, run by
 * `server-room.worklet.ts` and checked in Node.
 *
 * The worklet makes the whole room for one seed, standing in the aisle
 * between two rows of racks:
 *
 * - **Fan air.** Counter-hashed white noise per side (each sample's hash
 *   gives both sides, one in each half), tilted to pink by three one-poles,
 *   through a high-pass at 200 Hz, a broad +5 dB peak at 1.2 kHz and a
 *   low-pass at 6 kHz, with the same white band-passed at 3 kHz 12 dB under
 *   it for the hiss of small fans. Airflow sets its level, 10 dB lower at 0
 *   than at 100, and a slow drift moves it ±0.7 dB.
 * - **Fan tones.** Up to twelve racks, each a large fan's blade-pass tone at
 *   290–430 Hz (harmonics 1–3 at 0, −9 and −18 dB), and every third one a
 *   small fan's sine at 1.3–2.1 kHz, 8 dB under it. Racks come in threes of
 *   one model, whose fans spin within ±0.6 % of each other, so neighbours beat
 *   slowly against each other: that shimmer is the character. Each fan's
 *   pitch wanders by up to ±8 cents on its own slow drift, as phase
 *   modulation: its phase is its frequency times absolute time less a delay
 *   the drift moves, so it depends only on the time, never on when rendering
 *   began. The tones' total level stays the same at any number of racks
 *   (each is scaled by 1/√racks), so more racks thicken rather than get
 *   louder; a rack fades in or out over a second.
 * - **Cooling.** The building's cooling units: brown noise low-passed at
 *   140 Hz and high-passed twice at 40 Hz, clear of the sub-bass, and a compressor
 *   hum at 48–56 Hz, harmonics 1–5 falling 4 dB a step, so it reaches small
 *   speakers through its upper harmonics.
 * - **Coil whine.** Two power supplies' faint whine: a sine at 3.6–5.2 kHz and
 *   one 7 % above it 6 dB down, never above 5.6 kHz, coming and going ±4 dB
 *   on a very slow drift, and never louder than 20 dB under the air.
 * - **Disk ticks.** If on, a burst of 2–7 seek ticks every seven seconds or
 *   so (a Poisson process over 1 s blocks of absolute time), 12–40 ms apart,
 *   each 0.5 ms of noise dying away over 15 ms through a band-pass at
 *   2.4 kHz, Q 5, peaking 10 dB under the air's peaks, from one place per
 *   burst. A tick latches the settings as it starts.
 *
 * Tones come from wave tables, their phases worked out from absolute time at
 * each render quantum's start, and every slow modulator is a drift of
 * absolute time, evaluated at each quantum's ends and ramped between. So at
 * steady params the output depends only on the seed and absolute time.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import {
  createEventBlock,
  eventHash,
  eventsInBlock,
  type EventBlock,
} from "../../audio/dsp/events";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { svfCoefficients } from "../../audio/dsp/svf";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import { MAX_RACKS } from "./server-room.meta";

export const SERVER_ROOM_PROCESSOR = "aural-server-room";
/** The worklet's output channels: left and right. */
export const SERVER_ROOM_CHANNELS = 2;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Random streams: each source of randomness its own. */
const NOISE_STREAM = 0;
const VOICE_STREAM = 1;
const TICK_STREAM = 2;
const MODEL_STREAM = 3;
const AIR_STREAM = 4;
const WHINE_STREAM = 5;
const HVAC_STREAM = 6;
/** Each fan's wander drift: large fans from here, small fans from `SMALL_WANDER_STREAM`. */
const WANDER_STREAM = 16;
const SMALL_WANDER_STREAM = 32;

/** Salts for a voice's own random properties. */
const FREQUENCY_SALT = 1;
const SMALL_SALT = 2;
const PAN_SALT = 3;
const RATE_SALT = 4;
const SMALL_RATE_SALT = 5;

// ---------------------------------------------------------------------------
// Levels, against the air at Airflow 100.

/** The fan air at Airflow 100, in dBFS RMS per channel. */
export const AIR_DB = -25;
/** How much quieter the air is at Airflow 0 than at 100, in dB. */
export const AIRFLOW_RANGE_DB = 10;
/** How far the air's drift moves its level, in dB, and its rate. */
const AIR_SWING_DB = 0.7;
const AIR_DRIFT_RATE = 0.03;
/** The small fans' hiss, against the rest of the air, in dB. */
const HISS_DB = -12;
/** All the fan tones together, against the air at Airflow 100, in dB. */
const TONES_DB = -12;
/** A small fan's tone against its rack's large fan, in dB. */
const SMALL_FAN_DB = -8;
/** The cooling's rumble and its compressor at Cooling 100, against the air at Airflow 100, in dB. */
const RUMBLE_DB = -7.5;
const COMPRESSOR_DB = -13;
/** The coil whine at Whine 100, against the air at Airflow 100, in dB, and its swing and rate. */
export const WHINE_DB = -20;
const WHINE_SWING_DB = 4;
const WHINE_DRIFT_RATE = 0.01;
/** A disk tick's peak against the air's peaks, in dB; the air's peaks stand this far over its RMS. */
const TICK_UNDER_AIR_PEAK_DB = -10;
const AIR_CREST_DB = 12;

/** The share of the full value of a 0–100 param. */
const share = (x: number) => clamp(x / 100, 0, 1);

/** The air's gain at `airflow` (0–100), before its drift, as RMS per channel. */
export function airGain(airflow: number): number {
  return dbToGain(AIR_DB - AIRFLOW_RANGE_DB * (1 - share(airflow)));
}

/** The cooling's share of its full level at `hvac` (0–100): none at 0, on a fader's curve. */
export function hvacShare(hvac: number): number {
  return share(hvac);
}

/**
 * The whine's level at `whine` (0–100), in dB against the air at Airflow 100,
 * before its drift: off at 0, `WHINE_DB` at 100, rising as the square root so
 * low settings are still faintly there.
 */
export function whineDb(whine: number): number {
  const s = share(whine);
  return s > 0 ? WHINE_DB + 10 * Math.log10(s) : Number.NEGATIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// The fans.

/** A large fan's blade-pass, in Hz: a model's speed, and how far its fans stray from it. */
const MODEL_LOW = 300;
const MODEL_HIGH = 420;
const FAN_SPREAD = 0.006;
/** Racks per model of fan. */
const RACKS_PER_MODEL = 3;
/** A small fan's tone, in Hz. */
const SMALL_LOW = 1300;
const SMALL_HIGH = 2100;
/** How far the pans reach either way, and the seeded nudge on each. */
export const PAN_REACH = 0.8;
const PAN_NUDGE = 0.06;
/** The golden ratio's inverse: each rack's pan steps on by it, so any count spreads evenly. */
const PAN_STEP = (Math.sqrt(5) - 1) / 2;
/** Each fan's wander drift: its rate, in Hz, and how far its pitch strays, in cents. */
const WANDER_LOW = 0.02;
const WANDER_HIGH = 0.05;
export const WANDER_CENTS = 8;
/**
 * The steepest a one-octave drift gets, per knot: its slope peaks near 2.3, so
 * a delay of `ratio / (WANDER_SLOPE · rate)` keeps the pitch within ± the ratio.
 */
const WANDER_SLOPE = 2.4;
/** The tone bus's low-pass, in Hz, built into the small fans' level. */
const TONE_LOWPASS = 4500;

/** One rack's fans. */
interface FanVoice {
  /** The large fan's blade-pass, in Hz. */
  frequency: number;
  /** The small fan's tone, in Hz, or 0 for none. */
  small: number;
  /** Where it stands, −0.8 (left) to 0.8 (right). */
  pan: number;
  /** The large and small fans' wander drift rates, in Hz. */
  wanderRate: number;
  smallWanderRate: number;
}

const unit = (state: number, salt: number) => hashStep(state, salt) * UINT32_SCALE;

/**
 * Rack `index`'s fans for `seed`, from its own hashes and its model's alone,
 * so a rack is the same however many there are.
 */
export function fanVoice(seed: number, index: number): FanVoice {
  const base = hashStep(HASH_START, seed);
  const own = hashStep(hashStep(base, VOICE_STREAM), index);
  const model = hashStep(hashStep(base, MODEL_STREAM), Math.floor(index / RACKS_PER_MODEL));
  const speed = MODEL_LOW + (MODEL_HIGH - MODEL_LOW) * unit(model, FREQUENCY_SALT);
  const frequency = speed * (1 + FAN_SPREAD * (2 * unit(own, FREQUENCY_SALT) - 1));
  const small =
    index % RACKS_PER_MODEL === 0
      ? SMALL_LOW + (SMALL_HIGH - SMALL_LOW) * unit(own, SMALL_SALT)
      : 0;
  const step = (0.5 + index * PAN_STEP) % 1;
  const pan = clamp(
    PAN_REACH * (2 * step - 1) + PAN_NUDGE * (2 * unit(own, PAN_SALT) - 1),
    -PAN_REACH,
    PAN_REACH,
  );
  return {
    frequency,
    small,
    pan,
    wanderRate: WANDER_LOW + (WANDER_HIGH - WANDER_LOW) * unit(own, RATE_SALT),
    smallWanderRate: WANDER_LOW + (WANDER_HIGH - WANDER_LOW) * unit(own, SMALL_RATE_SALT),
  };
}

/** Every rack's fans for `seed`. */
export function fanVoices(seed: number): FanVoice[] {
  return Array.from({ length: MAX_RACKS }, (_, i) => fanVoice(seed, i));
}

/** How far a fan's wander delay swings either way, in seconds, for a drift at `rate`. */
export function wanderDelay(rate: number): number {
  return (2 ** (WANDER_CENTS / 1200) - 1) / (WANDER_SLOPE * rate);
}

/** The compressor hum's fundamental for `seed`, in Hz. */
export function compressorFrequency(seed: number): number {
  return 48 + 8 * unit(hashStep(hashStep(HASH_START, seed), HVAC_STREAM), FREQUENCY_SALT);
}

/** The highest the whine goes, in Hz, whatever the seed. */
export const WHINE_LIMIT = 5600;
/** The second supply's whine, as a multiple of the first, and its level in dB. */
const WHINE_RATIO = 1.07;
const WHINE_SECOND_DB = -6;

/** The coil whine's two tones for `seed`, in Hz, and where it stands. */
export function whineTones(seed: number): { first: number; second: number; pan: number } {
  const state = hashStep(hashStep(HASH_START, seed), WHINE_STREAM);
  const first = 3600 + 1600 * unit(state, FREQUENCY_SALT);
  return {
    first,
    second: Math.min(WHINE_LIMIT, first * WHINE_RATIO),
    pan: 0.6 * unit(state, PAN_SALT) - 0.3,
  };
}

// ---------------------------------------------------------------------------
// Wave tables, each of unit RMS.

const WAVE_BITS = 12;
const WAVE_SIZE = 1 << WAVE_BITS;
const WAVE_MASK = WAVE_SIZE - 1;

/** A wave of sine harmonics 1, 2, … at `levels` (dB), scaled to unit RMS. */
function waveTable(levels: readonly number[]): Float32Array {
  const table = new Float32Array(WAVE_SIZE);
  let power = 0;
  for (const db of levels) {
    power += dbToGain(db) ** 2 / 2;
  }
  const scale = 1 / Math.sqrt(power);
  for (let m = 0; m < WAVE_SIZE; m++) {
    let sum = 0;
    for (const [h, db] of levels.entries()) {
      sum += dbToGain(db) * Math.sin((2 * Math.PI * (h + 1) * m) / WAVE_SIZE);
    }
    table[m] = sum * scale;
  }
  return table;
}

/** A large fan's blade-pass, the compressor, and a plain sine. */
const FAN_LEVELS = [0, -9, -18] as const;
const COMPRESSOR_LEVELS = [0, -4, -8, -12, -16] as const;
let tables: { fan: Float32Array; compressor: Float32Array; sine: Float32Array } | undefined;

function waveTables() {
  tables ??= {
    fan: waveTable(FAN_LEVELS),
    compressor: waveTable(COMPRESSOR_LEVELS),
    sine: waveTable([0]),
  };
  return tables;
}

// ---------------------------------------------------------------------------
// The noise's filters, and their levels worked out from their responses.

/** Pink noise from white: Paul Kellet's economy filter in Hz (corners, gains at DC, direct). */
const PINK_CORNERS = [16.5, 264.6, 3945] as const;
const PINK_GAINS = [42.15, 8.014, 2.448] as const;
const PINK_DIRECT = 0.1848;
/** The air's filters, in Hz, with their Q and the peak's boost. */
const AIR_HIGHPASS = 200;
const AIR_PEAK = 1200;
const AIR_PEAK_Q = 0.5;
const AIR_PEAK_DB = 5;
const AIR_LOWPASS = 6000;
const HISS_CENTRE = 3000;
const HISS_Q = 0.7;
const EDGE_Q = Math.SQRT1_2;
/** The rumble: brown noise from this corner, low-passed, and high-passed twice over, in Hz. */
const BROWN_CORNER = 30;
const RUMBLE_LOWPASS = 140;
const RUMBLE_HIGHPASS = 40;

/** A complex gain, [re, im]. */
type Complex = readonly [number, number];
const times = (a: Complex, b: Complex): Complex => [
  a[0] * b[0] - a[1] * b[1],
  a[0] * b[1] + a[1] * b[0],
];
const over = (a: Complex, b: Complex): Complex => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const power = (a: Complex) => a[0] * a[0] + a[1] * a[1];

/**
 * An `svf.ts` filter's response at `w` radians per sample: the trapezoidal
 * filter is the analogue one through the bilinear transform, at Ω = tan(w/2)/g.
 */
function svfResponse(
  kind: "low" | "band" | "high",
  w: number,
  cutoff: number,
  q: number,
  sampleRate: number,
): Complex {
  const omega = Math.tan(w / 2) / Math.tan((Math.PI * cutoff) / sampleRate);
  const denominator: Complex = [1 - omega * omega, omega / q];
  const numerator: Complex =
    kind === "low" ? [1, 0] : kind === "band" ? [0, omega / q] : [-omega * omega, 0];
  return over(numerator, denominator);
}

/** A one-pole low-pass at `corner` Hz with a gain of `gain` at DC, at `w` radians per sample. */
function onePole(w: number, corner: number, gain: number, sampleRate: number): Complex {
  const p = Math.exp((-2 * Math.PI * corner) / sampleRate);
  return over([gain * (1 - p), 0], [1 - p * Math.cos(w), p * Math.sin(w)]);
}

function pinkResponse(w: number, sampleRate: number): Complex {
  let re = PINK_DIRECT;
  let im = 0;
  for (const [i, corner] of PINK_CORNERS.entries()) {
    const g = onePole(w, corner, PINK_GAINS[i] ?? 0, sampleRate);
    re += g[0];
    im += g[1];
  }
  return [re, im];
}

/** Points and bottom of the log-spaced response integrals. */
const SPECTRUM_POINTS = 3000;
const SPECTRUM_BOTTOM = 1;
const SPECTRUM_TOP = 0.4999;

/** The RMS of unit-variance white noise through a filter of response `h(w)`. */
function noiseRms(h: (w: number) => Complex, sampleRate: number): number {
  const top = SPECTRUM_TOP * sampleRate;
  const step = Math.log(top / SPECTRUM_BOTTOM) / SPECTRUM_POINTS;
  let sum = 0;
  for (let i = 0; i < SPECTRUM_POINTS; i++) {
    const f = SPECTRUM_BOTTOM * Math.exp((i + 0.5) * step);
    sum += power(h((2 * Math.PI * f) / sampleRate)) * f;
  }
  // The mean power over 0..π: ∫|H|² dw / π, with dw = 2π df / sr.
  return Math.sqrt((2 * sum * step) / sampleRate);
}

/** The air's pink path and hiss path, and the rumble, as responses. */
function airPink(w: number, sr: number): Complex {
  const peak = svfResponse("band", w, AIR_PEAK, AIR_PEAK_Q, sr);
  const boost = dbToGain(AIR_PEAK_DB) - 1;
  return times(
    times(pinkResponse(w, sr), svfResponse("high", w, AIR_HIGHPASS, EDGE_Q, sr)),
    times([1 + boost * peak[0], boost * peak[1]], svfResponse("low", w, AIR_LOWPASS, EDGE_Q, sr)),
  );
}
function airHiss(w: number, sr: number): Complex {
  return times(
    svfResponse("band", w, HISS_CENTRE, HISS_Q, sr),
    svfResponse("low", w, AIR_LOWPASS, EDGE_Q, sr),
  );
}
function rumble(w: number, sr: number): Complex {
  const low = onePole(w, RUMBLE_HIGHPASS, 1, sr);
  const high: Complex = [1 - low[0], -low[1]];
  return times(
    times(onePole(w, BROWN_CORNER, 1, sr), svfResponse("low", w, RUMBLE_LOWPASS, EDGE_Q, sr)),
    times(high, high),
  );
}

/** The gains that bring each noise path to unit RMS (the air's two together), per sample rate. */
interface NoiseScales {
  pink: number;
  hiss: number;
  rumble: number;
}
const scaleCache = new Map<number, NoiseScales>();

function noiseScales(sampleRate: number): NoiseScales {
  const cached = scaleCache.get(sampleRate);
  if (cached) {
    return cached;
  }
  // The hiss sits `HISS_DB` under the pink, and the two together make unit RMS.
  const hissShare = dbToGain(HISS_DB);
  const together = Math.sqrt(1 + hissShare * hissShare);
  const scales = {
    pink: 1 / (together * noiseRms((w) => airPink(w, sampleRate), sampleRate)),
    hiss: hissShare / (together * noiseRms((w) => airHiss(w, sampleRate), sampleRate)),
    rumble: 1 / noiseRms((w) => rumble(w, sampleRate), sampleRate),
  };
  scaleCache.set(sampleRate, scales);
  return scales;
}

// ---------------------------------------------------------------------------
// Disk ticks.

/** Bursts per second, ticks per burst, and the gap between ticks, in seconds. */
export const BURST_RATE = 0.15;
const TICKS_LOW = 2;
const TICKS_HIGH = 7;
const GAP_LOW = 0.012;
const GAP_HIGH = 0.04;
/** How far a burst may stand from the centre. */
const TICK_PAN = 0.7;
/** A tick's noise: full for this long, then dying away 60 dB over `TICK_DECAY`, in seconds. */
const TICK_BURST = 0.0005;
const TICK_DECAY = 0.015;
/** The ticks' band-pass, in Hz, and its Q. */
const TICK_CENTRE = 2400;
const TICK_Q = 5;
/** Each tick's level strays this far either way, in dB. */
const TICK_SPREAD_DB = 2;
/**
 * The gain that brings a tick's typical peak to 1: the band-pass passes a
 * little of the noise's power, so its ring peaks well under the noise.
 */
const TICK_NORM = 6;
/** Ticks sounding at once: plenty, as they're a few milliseconds long. */
const TICK_VOICES = 4;
/** Bursts a 1 s block can hold. */
const BURST_CAPACITY = 8;

/** Salts for a burst's and a tick's random properties. */
const COUNT_SALT = 11;
const BURST_PAN_SALT = 12;
const GAP_SALT = 13;
const LEVEL_SALT = 14;
const TICK_NOISE_SALT = 15;

/** The ticks in a burst of event hash `burst`. */
export function ticksInBurst(burst: number): number {
  const u = unit(burst, COUNT_SALT);
  return TICKS_LOW + Math.min(TICKS_HIGH - TICKS_LOW, Math.floor(u * (TICKS_HIGH - TICKS_LOW + 1)));
}

/** The gap before tick `k` (from 1) of a burst of event hash `burst`, in seconds. */
export function tickGap(burst: number, k: number): number {
  return GAP_LOW + (GAP_HIGH - GAP_LOW) * unit(hashStep(burst, GAP_SALT), k);
}

/** One sounding tick. */
interface Tick {
  active: boolean;
  /** Its first sample, absolute. */
  start: number;
  /** Its noise's hash prefix. */
  noise: number;
  /** Its gain on each side. */
  left: number;
  right: number;
  /** The band-pass's state. */
  ic1: number;
  ic2: number;
}

// ---------------------------------------------------------------------------
// The kernel.

/** The noise's filter states per side. */
const STATES = 16;
/** Maps 16 bits of a hash, centred, onto −1..1. */
const HALF_SCALE = 2 / 65535;
/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** A rack fades in or out over this long, in seconds, at the most a rack's gain can change. */
const RACK_FADE = 1;
/** A render quantum, in samples: the most `render` takes at once. */
const QUANTUM = 128;

/** Moves `from` towards `to` by at most `step`. */
const towards = (from: number, to: number, step: number) =>
  from < to ? Math.min(to, from + step) : Math.max(to, from - step);

/**
 * Server Room's whole sound for one seed, from absolute samples: the same
 * whether rendered in one go or in chunks, at steady params.
 */
export class ServerRoomKernel {
  private readonly seed: number;
  private readonly sampleRate: number;
  private readonly prefix: number;
  /** The noise's filters: pink's three poles and input gains, brown's, and the rumble's high-pass. */
  private readonly pinkPoles: Float64Array;
  private readonly pinkInputs: Float64Array;
  private readonly pinkDirect: number;
  private readonly brownPole: number;
  private readonly brownInput: number;
  private readonly rumblePole: number;
  private readonly hissScale: number;
  private readonly rumbleScale: number;
  /** As `svfCoefficients`: the air's high-pass, peak and low-pass, the hiss, and the rumble. */
  private readonly highpass: Float64Array;
  private readonly peak: Float64Array;
  private readonly lowpass: Float64Array;
  private readonly hiss: Float64Array;
  private readonly rumbleLow: Float64Array;
  private readonly peakBoost: number;
  /** The noise's states: per side, pink's three, brown, five filters' two each, the high-passes. */
  private readonly states = new Float64Array(2 * STATES);

  /** The fans: each rack's pitch, small fan, pans, wander and gains. */
  private readonly frequencies = new Float64Array(MAX_RACKS);
  private readonly smalls = new Float64Array(MAX_RACKS);
  private readonly smallLevels = new Float64Array(MAX_RACKS);
  private readonly lefts = new Float64Array(MAX_RACKS);
  private readonly rights = new Float64Array(MAX_RACKS);
  private readonly wanders: DriftGenerator[];
  private readonly smallWanders: DriftGenerator[];
  private readonly wanderDelays = new Float64Array(MAX_RACKS);
  private readonly smallWanderDelays = new Float64Array(MAX_RACKS);
  /** Each fan's wander delay at the end of the last render, and each rack's gain. */
  private readonly delays = new Float64Array(MAX_RACKS);
  private readonly smallDelays = new Float64Array(MAX_RACKS);
  private readonly rackGains = new Float64Array(MAX_RACKS);
  private readonly toneGain: number;

  private readonly compressor: number;
  private readonly whineFirst: number;
  private readonly whineSecond: number;
  private readonly whineLeft: number;
  private readonly whineRight: number;
  private readonly airDrift: DriftGenerator;
  private readonly whineDrift: DriftGenerator;

  /** Disk ticks: the voices, the bursts of the last few blocks, and the ticks' filter. */
  private readonly ticks: Tick[];
  private readonly bursts: EventBlock[];
  private readonly burstBlocks = new Float64Array(3).fill(Number.NaN);
  private readonly tickFilter: Float64Array;
  private readonly tickBurst: number;
  private readonly tickDecay: number;
  private readonly tickLength: number;
  private readonly scratch = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];

  /** The params `set` gave. */
  private airflow = 60;
  private racks = 6;
  private hvac = 45;
  private whine = 15;
  private disks = false;
  /** Levels at the end of the last render, to ramp from. */
  private air = Number.NaN;
  private cooling = Number.NaN;
  private whineLevel = Number.NaN;
  private compressorLevel = Number.NaN;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.seed = seed;
    this.sampleRate = sampleRate;
    const sr = sampleRate;
    this.prefix = hashStep(hashStep(HASH_START, seed), NOISE_STREAM);
    const scales = noiseScales(sr);
    const pole = (corner: number) => Math.exp((-2 * Math.PI * corner) / sr);
    this.pinkPoles = Float64Array.from(PINK_CORNERS, pole);
    this.pinkInputs = Float64Array.from(
      PINK_GAINS,
      (g, i) => g * (1 - (this.pinkPoles[i] ?? 0)) * UNIFORM_TO_UNIT * scales.pink,
    );
    this.pinkDirect = PINK_DIRECT * UNIFORM_TO_UNIT * scales.pink;
    this.brownPole = pole(BROWN_CORNER);
    this.brownInput = (1 - this.brownPole) * UNIFORM_TO_UNIT;
    this.rumblePole = pole(RUMBLE_HIGHPASS);
    this.hissScale = scales.hiss * UNIFORM_TO_UNIT;
    this.rumbleScale = scales.rumble;
    const coefficients = (cutoff: number, q: number) =>
      svfCoefficients(new Float64Array(4), cutoff, q, sr);
    this.highpass = coefficients(AIR_HIGHPASS, EDGE_Q);
    this.peak = coefficients(AIR_PEAK, AIR_PEAK_Q);
    this.lowpass = coefficients(AIR_LOWPASS, EDGE_Q);
    this.hiss = coefficients(HISS_CENTRE, HISS_Q);
    this.rumbleLow = coefficients(RUMBLE_LOWPASS, EDGE_Q);
    this.peakBoost = dbToGain(AIR_PEAK_DB) - 1;

    // Panned with equal power, and lifted 3 dB so a centred fan reads its level on each side.
    const voices = fanVoices(seed);
    const smallLevel = (f: number) => {
      const x = f / TONE_LOWPASS;
      return dbToGain(SMALL_FAN_DB) / Math.hypot(1 - x * x, x / EDGE_Q);
    };
    for (const [i, v] of voices.entries()) {
      this.frequencies[i] = v.frequency;
      this.smalls[i] = v.small;
      this.smallLevels[i] = v.small > 0 ? smallLevel(v.small) : 0;
      this.lefts[i] = Math.SQRT2 * panLeft(v.pan);
      this.rights[i] = Math.SQRT2 * panRight(v.pan);
      this.wanderDelays[i] = wanderDelay(v.wanderRate);
      this.smallWanderDelays[i] = wanderDelay(v.smallWanderRate);
    }
    this.wanders = voices.map(
      (v, i) => new DriftGenerator(seed, WANDER_STREAM + i, v.wanderRate, 1, sr),
    );
    this.smallWanders = voices.map(
      (v, i) => new DriftGenerator(seed, SMALL_WANDER_STREAM + i, v.smallWanderRate, 1, sr),
    );
    this.toneGain = dbToGain(AIR_DB + TONES_DB);

    this.compressor = compressorFrequency(seed);
    const whine = whineTones(seed);
    this.whineFirst = whine.first;
    this.whineSecond = whine.second;
    this.whineLeft = Math.SQRT2 * panLeft(whine.pan);
    this.whineRight = Math.SQRT2 * panRight(whine.pan);
    this.airDrift = new DriftGenerator(seed, AIR_STREAM, AIR_DRIFT_RATE, 2, sr);
    this.whineDrift = new DriftGenerator(seed, WHINE_STREAM, WHINE_DRIFT_RATE, 2, sr);

    this.ticks = Array.from({ length: TICK_VOICES }, () => ({
      active: false,
      start: 0,
      noise: 0,
      left: 0,
      right: 0,
      ic1: 0,
      ic2: 0,
    }));
    this.bursts = Array.from({ length: 3 }, () => createEventBlock(BURST_CAPACITY));
    this.tickFilter = coefficients(TICK_CENTRE, TICK_Q);
    this.tickBurst = Math.max(1, Math.round(TICK_BURST * sr));
    this.tickDecay = 10 ** (-3 / (TICK_DECAY * sr));
    this.tickLength = this.tickBurst + Math.round(TICK_DECAY * sr);
  }

  /**
   * Sets the params for the next render: Airflow, Cooling and Whine (0–100),
   * the racks (1–12) and whether disks tick (0 or 1).
   */
  set(airflow: number, racks: number, hvac: number, whine: number, disks: number): void {
    this.airflow = airflow;
    this.racks = clamp(Math.round(racks), 1, MAX_RACKS);
    this.hvac = hvac;
    this.whine = whine;
    this.disks = disks > 0.5;
  }

  /** Fills `outputs` (left and right, of one length, at most 128) from absolute sample `start`. */
  render(outputs: readonly Float32Array[], start: number): void {
    const left = outputs[0];
    const right = outputs[1];
    const length = Math.min(left.length, right.length, QUANTUM);
    const end = start + length;
    if (start !== this.expected) {
      this.restart(start);
    }
    this.expected = end;
    this.renderNoise(left, right, start, length);
    this.renderTones(left, right, start, length);
    this.renderTicks(left, right, start, length);
    // Silence, rather than leftovers, past the quantum.
    if (left.length > length) {
      left.fill(0, length);
    }
    if (right.length > length) {
      right.fill(0, length);
    }
  }

  /**
   * A fresh start, or a jump: levels and racks start where the params put
   * them, each fan's wander where absolute time does, and ticks struck just
   * before ring on, run unheard from as far back as one lasts.
   */
  private restart(start: number): void {
    this.air = Number.NaN;
    this.cooling = Number.NaN;
    this.whineLevel = Number.NaN;
    this.compressorLevel = Number.NaN;
    const t = start / this.sampleRate;
    const target = 1 / Math.sqrt(this.racks);
    for (let i = 0; i < MAX_RACKS; i++) {
      this.rackGains[i] = i < this.racks ? target : 0;
      this.delays[i] = (this.wanderDelays[i] ?? 0) * (this.wanders[i]?.valueAtTime(t) ?? 0);
      this.smallDelays[i] =
        (this.smallWanderDelays[i] ?? 0) * (this.smallWanders[i]?.valueAtTime(t) ?? 0);
    }
    for (const tick of this.ticks) {
      tick.active = false;
    }
    const [l, r] = this.scratch;
    for (let f = start - this.tickLength; f < start; f += QUANTUM) {
      const n = Math.min(QUANTUM, start - f);
      l.fill(0);
      r.fill(0);
      this.renderTicks(l, r, f, n);
    }
  }

  /** The air, its hiss and the cooling's rumble, written into `left` and `right`. */
  private renderNoise(left: Float32Array, right: Float32Array, start: number, length: number) {
    const end = start + length;
    const airTo = airGain(this.airflow) * dbToGain(AIR_SWING_DB * this.airDrift.valueAt(end));
    const airFrom = Number.isNaN(this.air)
      ? airGain(this.airflow) * dbToGain(AIR_SWING_DB * this.airDrift.valueAt(start))
      : this.air;
    this.air = airTo;
    const coolTo = dbToGain(AIR_DB + RUMBLE_DB) * this.rumbleScale * hvacShare(this.hvac);
    const coolFrom = Number.isNaN(this.cooling) ? coolTo : this.cooling;
    this.cooling = coolTo;
    const airStep = (airTo - airFrom) / length;
    const coolStep = (coolTo - coolFrom) / length;

    const prefix = this.prefix;
    const [p0 = 0, p1 = 0, p2 = 0] = this.pinkPoles;
    const [g0 = 0, g1 = 0, g2 = 0] = this.pinkInputs;
    const direct = this.pinkDirect;
    const bp = this.brownPole;
    const bg = this.brownInput;
    const rp = this.rumblePole;
    const hissScale = this.hissScale;
    const boost = this.peakBoost;
    const [ha1 = 0, ha2 = 0, ha3 = 0, hk = 0] = this.highpass;
    const [pa1 = 0, pa2 = 0, pa3 = 0, pk = 0] = this.peak;
    const [la1 = 0, la2 = 0, la3 = 0] = this.lowpass;
    const [sa1 = 0, sa2 = 0, sa3 = 0, sk = 0] = this.hiss;
    const [ra1 = 0, ra2 = 0, ra3 = 0] = this.rumbleLow;
    const st = this.states;
    for (let side = 0; side < 2; side++) {
      const out = side === 0 ? left : right;
      const o = side * STATES;
      let s0 = st[o];
      let s1 = st[o + 1];
      let s2 = st[o + 2];
      let brown = st[o + 3];
      let h1 = st[o + 4];
      let h2 = st[o + 5];
      let k1 = st[o + 6];
      let k2 = st[o + 7];
      let l1 = st[o + 8];
      let l2 = st[o + 9];
      let z1 = st[o + 10];
      let z2 = st[o + 11];
      let r1 = st[o + 12];
      let r2 = st[o + 13];
      let slow = st[o + 14];
      let slower = st[o + 15];
      // Each filter is `svfCoefficients`' tick written out.
      for (let i = 0; i < length; i++) {
        const k = i + 1;
        // One hash per sample: its high half for the left, its low half for the right.
        const hash = hashStep(prefix, start + i);
        const w = (side === 0 ? hash >>> 16 : hash & 0xffff) * HALF_SCALE - 1;
        s0 = p0 * s0 + g0 * w;
        s1 = p1 * s1 + g1 * w;
        s2 = p2 * s2 + g2 * w;
        brown = bp * brown + bg * w;
        // Pink: high-pass, then the peak.
        let x = s0 + s1 + s2 + direct * w;
        let v3 = x - h2;
        let v1 = ha1 * h1 + ha2 * v3;
        let v2 = h2 + ha2 * h1 + ha3 * v3;
        h1 = 2 * v1 - h1;
        h2 = 2 * v2 - h2;
        x = x - hk * v1 - v2;
        v3 = x - k2;
        v1 = pa1 * k1 + pa2 * v3;
        v2 = k2 + pa2 * k1 + pa3 * v3;
        k1 = 2 * v1 - k1;
        k2 = 2 * v2 - k2;
        x += boost * pk * v1;
        // The hiss: the white, band-passed.
        v3 = w - z2;
        v1 = sa1 * z1 + sa2 * v3;
        v2 = z2 + sa2 * z1 + sa3 * v3;
        z1 = 2 * v1 - z1;
        z2 = 2 * v2 - z2;
        x += hissScale * sk * v1;
        // Both through the low-pass.
        v3 = x - l2;
        v1 = la1 * l1 + la2 * v3;
        v2 = l2 + la2 * l1 + la3 * v3;
        l1 = 2 * v1 - l1;
        l2 = 2 * v2 - l2;
        const air = v2;
        // The rumble: brown, low-passed, then high-passed twice by taking away a one-pole.
        v3 = brown - r2;
        v1 = ra1 * r1 + ra2 * v3;
        v2 = r2 + ra2 * r1 + ra3 * v3;
        r1 = 2 * v1 - r1;
        r2 = 2 * v2 - r2;
        slow = v2 + rp * (slow - v2);
        const once = v2 - slow;
        slower = once + rp * (slower - once);
        out[i] = (airFrom + airStep * k) * air + (coolFrom + coolStep * k) * (once - slower);
      }
      st[o] = s0;
      st[o + 1] = s1;
      st[o + 2] = s2;
      st[o + 3] = brown;
      st[o + 4] = h1;
      st[o + 5] = h2;
      st[o + 6] = k1;
      st[o + 7] = k2;
      st[o + 8] = l1;
      st[o + 9] = l2;
      st[o + 10] = z1;
      st[o + 11] = z2;
      st[o + 12] = r1;
      st[o + 13] = r2;
      st[o + 14] = slow;
      st[o + 15] = slower;
    }
  }

  /** The fans, the compressor and the whine, added to `left` and `right`. */
  private renderTones(left: Float32Array, right: Float32Array, start: number, length: number) {
    const sr = this.sampleRate;
    const t0 = start / sr;
    const t1 = (start + length) / sr;
    const { fan, compressor, sine } = waveTables();

    // The racks: each fades towards its share of the tones' level.
    const step = length / (sr * RACK_FADE);
    const target = 1 / Math.sqrt(this.racks);
    for (let i = 0; i < MAX_RACKS; i++) {
      const from = this.rackGains[i] ?? 0;
      const to = towards(from, i < this.racks ? target : 0, step);
      this.rackGains[i] = to;
      const wanderTo = (this.wanderDelays[i] ?? 0) * (this.wanders[i]?.valueAtTime(t1) ?? 0);
      const smallTo =
        (this.smallWanderDelays[i] ?? 0) * (this.smallWanders[i]?.valueAtTime(t1) ?? 0);
      const wanderFrom = this.delays[i] ?? 0;
      const smallFrom = this.smallDelays[i] ?? 0;
      this.delays[i] = wanderTo;
      this.smallDelays[i] = smallTo;
      if (from === 0 && to === 0) {
        continue;
      }
      const gain = this.toneGain;
      const l = this.lefts[i] ?? 0;
      const r = this.rights[i] ?? 0;
      addTone(
        left,
        right,
        length,
        fan,
        this.frequencies[i] ?? 0,
        t0 - wanderFrom,
        t1 - wanderTo,
        gain * from,
        gain * to,
        l,
        r,
      );
      const small = this.smalls[i] ?? 0;
      if (small > 0) {
        const level = gain * (this.smallLevels[i] ?? 0);
        addTone(
          left,
          right,
          length,
          sine,
          small,
          t0 - smallFrom,
          t1 - smallTo,
          level * from,
          level * to,
          l,
          r,
        );
      }
    }

    // The compressor, in the middle.
    const coolTo = dbToGain(AIR_DB + COMPRESSOR_DB) * hvacShare(this.hvac);
    const coolFrom = Number.isNaN(this.compressorLevel) ? coolTo : this.compressorLevel;
    this.compressorLevel = coolTo;
    if (coolFrom > 0 || coolTo > 0) {
      addTone(left, right, length, compressor, this.compressor, t0, t1, coolFrom, coolTo, 1, 1);
    }

    // The whine, coming and going.
    const db = whineDb(this.whine);
    const whineTo =
      db === Number.NEGATIVE_INFINITY
        ? 0
        : dbToGain(AIR_DB + db + WHINE_SWING_DB * this.whineDrift.valueAtTime(t1));
    const whineFrom = Number.isNaN(this.whineLevel) ? whineTo : this.whineLevel;
    this.whineLevel = whineTo;
    if (whineFrom > 0 || whineTo > 0) {
      const l = this.whineLeft;
      const r = this.whineRight;
      addTone(left, right, length, sine, this.whineFirst, t0, t1, whineFrom, whineTo, l, r);
      const second = dbToGain(WHINE_SECOND_DB);
      addTone(
        left,
        right,
        length,
        sine,
        this.whineSecond,
        t0,
        t1,
        whineFrom * second,
        whineTo * second,
        l,
        r,
      );
    }
  }

  /** The bursts of block `block`, from a small cache of the last few. */
  private burstsOf(block: number): EventBlock {
    const slot = ((block % 3) + 3) % 3;
    const events = this.bursts[slot];
    if (this.burstBlocks[slot] !== block) {
      eventsInBlock(this.seed, TICK_STREAM, block, BURST_RATE, events);
      this.burstBlocks[slot] = block;
    }
    return events;
  }

  /** Starts the ticks that fall in [start, start + length), if disks tick. */
  private startTicks(start: number, length: number): void {
    if (!this.disks) {
      return;
    }
    const sr = this.sampleRate;
    const end = start + length;
    // A burst lasts well under a second, so one may run on from the block before.
    const first = Math.floor(start / sr) - 1;
    const last = Math.floor((end - 1) / sr);
    for (let block = first; block <= last; block++) {
      const events = this.burstsOf(block);
      for (let j = 0; j < events.count; j++) {
        const burst = eventHash(this.seed, TICK_STREAM, block, j);
        const count = ticksInBurst(burst);
        const pan = TICK_PAN * (2 * unit(burst, BURST_PAN_SALT) - 1);
        let t = block + (events.offsets[j] ?? 0);
        for (let k = 0; k < count; k++) {
          if (k > 0) {
            t += tickGap(burst, k);
          }
          const at = Math.round(t * sr);
          if (at >= end) {
            break;
          }
          if (at >= start) {
            this.startTick(at, hashStep(burst, TICK_NOISE_SALT + 16 * k), pan);
          }
        }
      }
    }
  }

  /** Starts a tick at absolute sample `at`, its noise from `noise`, at the air's level now. */
  private startTick(at: number, noise: number, pan: number): void {
    // An idle voice, or else the one that started longest ago.
    let voice = this.ticks[0];
    for (const tick of this.ticks) {
      if (!tick.active) {
        voice = tick;
        break;
      }
      if (tick.start < voice.start) {
        voice = tick;
      }
    }
    const spread = TICK_SPREAD_DB * (2 * unit(noise, LEVEL_SALT) - 1);
    const gain =
      airGain(this.airflow) * dbToGain(AIR_CREST_DB + TICK_UNDER_AIR_PEAK_DB + spread) * TICK_NORM;
    voice.active = true;
    voice.start = at;
    voice.noise = noise;
    voice.left = gain * Math.SQRT2 * panLeft(pan);
    voice.right = gain * Math.SQRT2 * panRight(pan);
    voice.ic1 = 0;
    voice.ic2 = 0;
  }

  /** The disk ticks, added to `left` and `right`. */
  private renderTicks(left: Float32Array, right: Float32Array, start: number, length: number) {
    this.startTicks(start, length);
    const [a1 = 0, a2 = 0, a3 = 0, k = 0] = this.tickFilter;
    const burstLength = this.tickBurst;
    const decay = this.tickDecay;
    const tickLength = this.tickLength;
    for (const tick of this.ticks) {
      if (!tick.active) {
        continue;
      }
      const from = Math.max(0, tick.start - start);
      const to = Math.min(length, tick.start + tickLength - start);
      let ic1 = tick.ic1;
      let ic2 = tick.ic2;
      let age = start + from - tick.start;
      let envelope = age < burstLength ? 1 : decay ** (age - burstLength);
      for (let i = from; i < to; i++, age++) {
        const x = (hashStep(tick.noise, age) * UINT32_SCALE * 2 - 1) * envelope;
        if (age >= burstLength) {
          envelope *= decay;
        }
        const v3 = x - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        const y = k * v1;
        left[i] += tick.left * y;
        right[i] += tick.right * y;
      }
      tick.ic1 = ic1;
      tick.ic2 = ic2;
      if (to < length) {
        tick.active = false;
      }
    }
  }
}

/**
 * Adds `table` at `frequency` Hz, phase-aligned to absolute time, to `left`
 * and `right`: its phase is the frequency times `from` seconds at the first
 * sample and times `to` at the one after the last (absolute time less any
 * wander delay), its gain ramping from `gainFrom` to `gainTo`, `l` and `r` of
 * it on each side.
 */
function addTone(
  left: Float32Array,
  right: Float32Array,
  length: number,
  table: Float32Array,
  frequency: number,
  from: number,
  to: number,
  gainFrom: number,
  gainTo: number,
  l: number,
  r: number,
): void {
  const cycles = frequency * from;
  let phase = cycles - Math.floor(cycles);
  const increment = (frequency * (to - from)) / length;
  let gain = gainFrom;
  const gainStep = (gainTo - gainFrom) / length;
  for (let i = 0; i < length; i++) {
    const y = table[(phase * WAVE_SIZE) & WAVE_MASK] * gain;
    left[i] += l * y;
    right[i] += r * y;
    gain += gainStep;
    phase += increment;
    if (phase >= 1) {
      phase -= 1;
    }
  }
}

interface ServerRoomOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readServerRoomOptions(raw: unknown): ServerRoomOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
