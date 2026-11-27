/**
 * Fan's air, and the param mappings the rest of the sound uses: pure code with
 * no Web Audio globals, run by `fan.worklet.ts` and checked in Node.
 *
 * The worklet makes the air for one kind of fan and one seed:
 *
 * - **Noise.** Decorrelated counter-hashed white noise per side (each
 *   sample's hash gives both sides, one in each half), tilted to pink noise
 *   by three one-poles, with a fourth, lower one adding brown noise 8 dB
 *   under it for weight. One white feeds both, so they are one filter.
 * - **The fan's shape.** A high-pass, a peak of body and a low-pass, at the
 *   fan's own frequencies; the low-pass follows Tone and opens with Speed.
 *   The level rises 9 dB from Speed 0 to 100.
 * - **Blade-pass.** The blades chopping the air: the level swells and dips at
 *   blades × rotation, in a sine with its second harmonic at −9 dB, by the
 *   fan's depth, which a slow drift moves by ±30 % so the flutter isn't
 *   mechanical. Its phase is a function of absolute time at steady params;
 *   a change of Speed glides the rate on from wherever the phase stands.
 * - **Oscillation.** For the desk and box fans, a slow sweep of absolute time
 *   turns the fan side to side: the air pans ±0.5, rises 3 dB and brightens
 *   as it faces the bed, and falls 3 dB at either end.
 *
 * A soft guard bends the rarest peaks with every level at its highest. The
 * motor is a native oscillator; its wave and level are worked out here too.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { svfCoefficients } from "../../audio/dsp/svf";
import { HASH_START, hashStep } from "../../audio/random";
import type { FanType } from "./fan.meta";

export const FAN_PROCESSOR = "aural-fan";
/** The worklet's output channels: the air, left and right. */
export const FAN_CHANNELS = 2;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** One kind of fan. */
interface FanSpec {
  /** The air's high-pass and low-pass (at Speed 0 and the default Tone), in Hz. */
  highpass: number;
  lowpass: number;
  /** The body: a peak at this centre, in Hz, of this boost, in dB. */
  peak: number;
  peakDb: number;
  /** Blades, and the rotation at Speed 0 and 100, in Hz: none for a blower. */
  blades: number;
  rotation: readonly [number, number];
  /** A blower's ripple instead of a blade-pass, in Hz. */
  ripple: number;
  /** How deep the blade-pass (or ripple) goes, a share of the level. */
  depth: number;
  /** The air's level against the other fans', in dB. */
  levelDb: number;
  /** Whether it can oscillate. */
  oscillates: boolean;
  /** The motor's level against its share of the air, in dB. */
  motorDb: number;
}

export const FAN_SPECS: Readonly<Record<FanType, FanSpec>> = {
  desk: {
    highpass: 150,
    lowpass: 4500,
    peak: 1100,
    peakDb: 3,
    blades: 3,
    rotation: [14, 24],
    ripple: 0,
    depth: 0.07,
    levelDb: 0,
    oscillates: true,
    motorDb: 0,
  },
  ceiling: {
    highpass: 60,
    lowpass: 2200,
    peak: 350,
    peakDb: 2,
    blades: 5,
    rotation: [0.9, 3],
    ripple: 0,
    depth: 0.22,
    levelDb: -1,
    oscillates: false,
    motorDb: -8,
  },
  box: {
    highpass: 90,
    lowpass: 3500,
    peak: 700,
    peakDb: 4,
    blades: 5,
    rotation: [11, 19],
    ripple: 0,
    depth: 0.1,
    levelDb: 1,
    oscillates: true,
    motorDb: 0,
  },
  "air-conditioner": {
    highpass: 70,
    lowpass: 3000,
    peak: 450,
    peakDb: 3,
    blades: 0,
    rotation: [0, 0],
    ripple: 9,
    depth: 0.02,
    levelDb: 0,
    oscillates: false,
    motorDb: 4,
  },
};

/** The air at Speed 50 and the default Tone, in dBFS RMS per channel, on a fan of level 0 dB. */
export const AIR_DB = -26.5;
/** How far the air's level rises from Speed 0 to 100, in dB. */
export const SPEED_RANGE_DB = 9;
/** How far the low-pass opens from Speed 0 to 100, a share of its cutoff. */
export const SPEED_OPENS = 0.3;
/** The low-pass at Tone 0 and 100, as a multiple of the fan's own. */
export const TONE_DARKEST = 0.6;
export const TONE_BRIGHTEST = 1.6;
/** The highest the low-pass goes, whatever the settings, in Hz: nothing piercing. */
export const LOWPASS_LIMIT = 9000;
/** The filters' Q: the high-pass and low-pass, and the body's peak. */
const EDGE_Q = Math.SQRT1_2;
const LOWPASS_Q = 0.6;
const PEAK_Q = 1;

/** The brown noise under the pink, in dB. */
const BROWN_UNDER_PINK_DB = -8;
/** Brown noise: white through a one-pole at this corner, in Hz. */
const BROWN_CORNER = 38;
/**
 * Pink noise from white: three one-poles (corner in Hz, gain at DC) plus a
 * little of the white itself, Paul Kellet's economy filter worked out in Hz
 * so it is the same at any sample rate.
 */
const PINK_CORNERS = [16.5, 264.6, 3945] as const;
const PINK_GAINS = [42.15, 8.014, 2.448] as const;
const PINK_DIRECT = 0.1848;

/** The blade-pass wave: a sine and its second harmonic at this level. */
export const BLADE_HARMONIC = dbToGain(-9);
/** How far the drift moves the blade-pass depth, a share of itself, and its rate and octaves. */
const DEPTH_SWING = 0.3;
const DEPTH_DRIFT_RATE = 0.07;
const DEPTH_DRIFT_OCTAVES = 1;
const DEPTH_STREAM = 1;
const NOISE_STREAM = 0;

/** Oscillation: one sweep side to side and back takes this long, in seconds. */
export const SWEEP_PERIOD = 14;
/** How far it pans, and how far the level swings either way, in dB. */
export const SWEEP_PAN = 0.5;
const SWEEP_DB = 3;
/** How far the low-pass opens as the fan faces the bed, a share of its cutoff. */
const SWEEP_OPENS = 0.2;

/** Maps 16 bits of a hash, centred, onto −1..1. */
const HALF_SCALE = 2 / 65535;
/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);

/** The share of full speed at `speed` (0–100). */
const speedShare = (speed: number) => clamp01(speed / 100);

/** The rotation at `speed`, in Hz: none for a blower. */
export function rotationAt(type: FanType, speed: number): number {
  const [slow, fast] = FAN_SPECS[type].rotation;
  return slow + (fast - slow) * speedShare(speed);
}

/** The blade-pass at `speed`, in Hz: blades × rotation, or a blower's steady ripple. */
export function bladePassAt(type: FanType, speed: number): number {
  const spec = FAN_SPECS[type];
  return spec.blades > 0 ? spec.blades * rotationAt(type, speed) : spec.ripple;
}

/** The air's level at `speed`, against the fan's level at Speed 50, in dB. */
export function speedDb(speed: number): number {
  return SPEED_RANGE_DB * (speedShare(speed) - 0.5);
}

/** The low-pass's cutoff at `speed` and `tone` (0–100), before any oscillation, in Hz. */
export function lowpassAt(type: FanType, speed: number, tone: number): number {
  const toneScale = TONE_DARKEST + (TONE_BRIGHTEST - TONE_DARKEST) * clamp01(tone / 100);
  const cutoff = FAN_SPECS[type].lowpass * toneScale * (1 + SPEED_OPENS * speedShare(speed));
  return Math.min(LOWPASS_LIMIT, cutoff);
}

/** What a fan's settings come to: the air's shape and level, and the blades. */
interface FanSettings {
  /** In Hz: the rotation, the blade-pass, and the filters. */
  rotation: number;
  bladePass: number;
  highpass: number;
  lowpass: number;
  peak: number;
  /** The peak's boost, as a gain. */
  peakGain: number;
  /** The blade-pass depth before the drift, a share of the level. */
  depth: number;
  /** The air's level in dBFS RMS per channel, before the blade-pass and any oscillation. */
  airDb: number;
}

/** The settings of a fan of `type` at `speed` and `tone` (0–100). */
export function fanSettings(type: FanType, speed: number, tone: number): FanSettings {
  const spec = FAN_SPECS[type];
  return {
    rotation: rotationAt(type, speed),
    bladePass: bladePassAt(type, speed),
    highpass: spec.highpass,
    lowpass: lowpassAt(type, speed, tone),
    peak: spec.peak,
    peakGain: dbToGain(spec.peakDb),
    depth: spec.depth,
    airDb: AIR_DB + spec.levelDb + speedDb(speed),
  };
}

/** The share of the oscillation's depth `amount` (0–1) a fan of `type` uses: none if it can't. */
export function sweepShare(type: FanType, amount: number): number {
  return FAN_SPECS[type].oscillates ? clamp01(amount) : 0;
}

/**
 * Where the oscillation stands at absolute time `t` seconds: −1 at one end, 1
 * at the other. How squarely the fan faces the bed is `facing` of it.
 */
export function sweepPosition(t: number): number {
  return Math.sin((2 * Math.PI * t) / SWEEP_PERIOD);
}

/** How squarely the fan faces the bed at sweep `position`: 1 in the middle, 0 at either end. */
export function facing(position: number): number {
  return 1 - position * position;
}

/**
 * One side's gain (`side` −1 for the left, 1 for the right) at sweep
 * `position`, oscillating by `amount` (0–1), on a level of `base`: panned so
 * the two sides' power stays the same, and 3 dB up facing the bed, 3 dB down
 * at either end.
 */
export function sweepGain(base: number, amount: number, position: number, side: number): number {
  return (
    base *
    dbToGain(SWEEP_DB * amount * (2 * facing(position) - 1)) *
    Math.sqrt(1 + side * SWEEP_PAN * amount * position)
  );
}

// ---------------------------------------------------------------------------
// Spectra, to set the air's level from the filters' shapes.

function highpassPower(f: number, cutoff: number, q: number): number {
  const x = f / cutoff;
  return x ** 4 / ((1 - x * x) ** 2 + (x / q) ** 2);
}
function lowpassPower(f: number, cutoff: number, q: number): number {
  const x = f / cutoff;
  return 1 / ((1 - x * x) ** 2 + (x / q) ** 2);
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

/** The noise filter's one-poles (corner in Hz, gain at DC) and direct term: pink, then brown. */
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

/** The pink filter, with the brown one-pole set 8 dB under it. */
function noiseFilter(sampleRate: number): NoiseFilter {
  const pink: NoiseFilter = {
    corners: [...PINK_CORNERS],
    gains: [...PINK_GAINS],
    direct: PINK_DIRECT,
  };
  const pinkRms = filteredRms((f) => parallelPower(f, pink), sampleRate);
  const brownRms = filteredRms(
    (f) => parallelPower(f, { corners: [BROWN_CORNER], gains: [1], direct: 0 }),
    sampleRate,
  );
  return {
    corners: [...PINK_CORNERS, BROWN_CORNER],
    gains: [...PINK_GAINS, (pinkRms / brownRms) * dbToGain(BROWN_UNDER_PINK_DB)],
    direct: PINK_DIRECT,
  };
}

/** The air's power at `f` for `settings`, before its level. */
function airPower(f: number, filter: NoiseFilter, settings: FanSettings): number {
  return (
    parallelPower(f, filter) *
    highpassPower(f, settings.highpass, EDGE_Q) *
    peakPower(f, settings.peak, PEAK_Q, settings.peakGain) *
    lowpassPower(f, settings.lowpass, LOWPASS_Q)
  );
}

/** Speed and Tone's defaults: the settings the air's level is set at. */
const DEFAULT_SPEED = 50;
const DEFAULT_TONE = 40;

/**
 * The gain that takes unit-variance white noise through the fan's filters to
 * the fan's level at the default Speed and Tone, worked out once per kind and
 * sample rate. Other settings keep it, so a brighter Tone is a little louder.
 */
const scaleCache = new Map<string, number>();

function airScale(type: FanType, filter: NoiseFilter, sampleRate: number): number {
  const key = `${type}@${String(sampleRate)}`;
  const cached = scaleCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const settings = fanSettings(type, DEFAULT_SPEED, DEFAULT_TONE);
  const rms = filteredRms((f) => airPower(f, filter, settings), sampleRate);
  const scale = dbToGain(AIR_DB + FAN_SPECS[type].levelDb) / rms;
  scaleCache.set(key, scale);
  return scale;
}

/** The share of the air below `f` Hz at `type`'s default settings, as power, for checks. */
export function airShareBelow(type: FanType, f: number, sampleRate: number): number {
  const filter = noiseFilter(sampleRate);
  const settings = fanSettings(type, DEFAULT_SPEED, DEFAULT_TONE);
  const power = (x: number) => airPower(x, filter, settings);
  const below = filteredRms((x) => (x < f ? power(x) : 0), sampleRate);
  return (below / filteredRms(power, sampleRate)) ** 2;
}

// ---------------------------------------------------------------------------
// The motor: a wave for a native oscillator.

/** The motor's low-pass, in Hz, and its Q: built into its wave. */
const MOTOR_LOWPASS = 800;
const MOTOR_LOWPASS_Q = Math.SQRT1_2;
/** The motor at Motor 100, against the air at the same Speed, in dB. */
export const MOTOR_UNDER_AIR_DB = -22;
/** A bladed fan's motor turns at this multiple of its rotation. */
export const MOTOR_RATIO = 6;
/** The whirr's harmonics: odd ones fall 6 dB an octave, even ones sit 5 dB under them. */
const WHIRR_HARMONICS = 8;
const WHIRR_EVEN_DB = -5;
/** The air conditioner's compressor: 100 Hz and its harmonics 2–4. */
export const COMPRESSOR = 100;
const COMPRESSOR_LEVELS_DB = [0, -5, -9, -13] as const;
/** The ceiling fan's faint motor: a sine at this pitch, in Hz. */
export const CEILING_MOTOR = 120;

/** The motor's pitch at `speed`, in Hz. */
export function motorFrequency(type: FanType, speed: number): number {
  switch (type) {
    case "ceiling":
      return CEILING_MOTOR;
    case "air-conditioner":
      return COMPRESSOR;
    case "desk":
    case "box":
      return MOTOR_RATIO * rotationAt(type, speed);
    default:
      return type satisfies never;
  }
}

/** The motor's low-pass gain at `frequency`. */
export function motorRolloff(frequency: number): number {
  const x = frequency / MOTOR_LOWPASS;
  return 1 / Math.hypot(1 - x * x, x / MOTOR_LOWPASS_Q);
}

/** A wave as `PeriodicWave` coefficients (index 0 unused). */
interface WaveCoefficients {
  real: number[];
  imag: number[];
}

/**
 * The motor as `PeriodicWave` coefficients, rolled off by its low-pass. A
 * bladed fan's pitch follows Speed, so its roll-off is worked out at Speed
 * 50's pitch: it is faint, and the difference at the ends is a decibel or two
 * in the upper harmonics.
 */
export function motorWave(type: FanType): WaveCoefficients {
  const imag = [0];
  if (type === "ceiling") {
    imag.push(motorRolloff(CEILING_MOTOR));
  } else if (type === "air-conditioner") {
    for (const [i, db] of COMPRESSOR_LEVELS_DB.entries()) {
      imag.push(dbToGain(db) * motorRolloff(COMPRESSOR * (i + 1)));
    }
  } else {
    const pitch = motorFrequency(type, DEFAULT_SPEED);
    for (let k = 1; k <= WHIRR_HARMONICS; k++) {
      const level = (k % 2 === 1 ? 1 : dbToGain(WHIRR_EVEN_DB)) / k;
      imag.push(level * motorRolloff(pitch * k));
    }
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

/**
 * The motor's gain at `motor` and `speed` (0–100), for its wave at unit
 * gain: none at Motor 0, and 22 dB under the air at 100 (more for the
 * compressor, less for the ceiling fan), on a fader's squared curve.
 */
export function motorGain(type: FanType, motor: number, speed: number): number {
  const air = fanSettings(type, speed, DEFAULT_TONE).airDb;
  const level = dbToGain(air + MOTOR_UNDER_AIR_DB + FAN_SPECS[type].motorDb);
  return (level / waveRms(motorWave(type))) * clamp01(motor / 100);
}

// ---------------------------------------------------------------------------
// The guard and the kernel.

/**
 * The guard on the air: unchanged below the knee, then a tanh curve that
 * never passes the ceiling. Only the rarest peaks reach it, with Speed and
 * Tone high and the fan oscillating; the motor fits in the headroom above.
 */
const GUARD_KNEE = dbToGain(-9);
const GUARD_CEILING = dbToGain(-4);

export function guard(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= GUARD_KNEE) {
    return x;
  }
  const room = GUARD_CEILING - GUARD_KNEE;
  const y = GUARD_KNEE + room * Math.tanh((magnitude - GUARD_KNEE) / room);
  return x < 0 ? -y : y;
}

/** The blade-pass wave's largest value, to scale it to ±1. */
const BLADE_PEAK = (() => {
  let peak = 0;
  for (let m = 0; m < 4096; m++) {
    const a = (2 * Math.PI * m) / 4096;
    peak = Math.max(peak, Math.abs(Math.sin(a) + BLADE_HARMONIC * Math.sin(2 * a)));
  }
  return peak;
})();

/** The blade-pass wave (−1..1) at `phase`, in cycles. */
export function bladeWave(phase: number): number {
  const a = 2 * Math.PI * phase;
  return (Math.sin(a) + BLADE_HARMONIC * Math.sin(2 * a)) / BLADE_PEAK;
}

/**
 * The Fan worklet's air for one kind of fan and one seed, from absolute
 * samples: the same whether rendered in one go or in chunks, at steady params.
 */
export class FanKernel {
  private readonly type: FanType;
  private readonly sampleRate: number;
  private readonly prefix: number;
  /** The noise filter's poles and input gains: pink's three, then brown's. */
  private readonly poles: Float64Array;
  private readonly inputs: Float64Array;
  private readonly direct: number;
  /** Its states: left's four, then right's. */
  private readonly noise = new Float64Array(8);
  /** The filters, as `svfCoefficients`, and their states: left's six, then right's. */
  private readonly highpass: Float64Array;
  private readonly body: Float64Array;
  private readonly lowpass: Float64Array;
  private readonly states = new Float64Array(12);
  private readonly bodyBoost: number;
  private readonly scale: number;
  private readonly depthDrift: DriftGenerator;
  /** The params `set` gave. */
  private speed = DEFAULT_SPEED;
  private tone = DEFAULT_TONE;
  private sweepAmount = 0;
  /** The cutoff the low-passes hold. */
  private cutoff = Number.NaN;
  /** Each side's gain and the blade-pass depth at the end of the last render, to ramp from. */
  private gainLeft = Number.NaN;
  private gainRight = Number.NaN;
  private depth = Number.NaN;
  /** The blade-pass's phase at the next render's start, in cycles. */
  private phase = 0;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(type: FanType, seed: number, sampleRate: number) {
    this.type = type;
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
    const spec = FAN_SPECS[type];
    this.highpass = svfCoefficients(new Float64Array(4), spec.highpass, EDGE_Q, sampleRate);
    this.body = svfCoefficients(new Float64Array(4), spec.peak, PEAK_Q, sampleRate);
    this.lowpass = new Float64Array(4);
    this.bodyBoost = dbToGain(spec.peakDb) - 1;
    this.scale = airScale(type, filter, sampleRate);
    this.depthDrift = new DriftGenerator(
      seed,
      DEPTH_STREAM,
      DEPTH_DRIFT_RATE,
      DEPTH_DRIFT_OCTAVES,
      sampleRate,
    );
  }

  /** Sets the params for the next render: Speed and Tone (0–100), and how far it oscillates (0–1). */
  set(speed: number, tone: number, oscillate: number): void {
    this.speed = speed;
    this.tone = tone;
    this.sweepAmount = sweepShare(this.type, oscillate);
  }

  /** Fills `outputs` (left and right, of one length) from absolute sample `start`. */
  render(outputs: readonly Float32Array[], start: number): void {
    const left = outputs[0];
    const right = outputs[1];
    const length = left.length;
    const sr = this.sampleRate;
    const end = start + length;
    const type = this.type;
    const bladePass = bladePassAt(type, this.speed);
    if (start !== this.expected) {
      // A fresh start: levels start where they stand, and the blades where absolute time puts them.
      this.gainLeft = Number.NaN;
      this.gainRight = Number.NaN;
      this.depth = Number.NaN;
      const cycles = (bladePass * start) / sr;
      this.phase = cycles - Math.floor(cycles);
    }
    this.expected = end;

    // The sweep barely moves in a render quantum: the cutoff follows it each
    // quantum, and the levels ramp between their values at either end.
    const amount = this.sweepAmount;
    const from = sweepPosition(start / sr);
    const to = sweepPosition(end / sr);
    const cutoff =
      lowpassAt(type, this.speed, this.tone) * (1 + SWEEP_OPENS * amount * facing(from));
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      svfCoefficients(this.lowpass, Math.min(LOWPASS_LIMIT, cutoff), LOWPASS_Q, sr);
    }
    const base = this.scale * dbToGain(speedDb(this.speed));
    const leftTo = sweepGain(base, amount, to, -1);
    const rightTo = sweepGain(base, amount, to, 1);
    const leftFrom = Number.isNaN(this.gainLeft)
      ? sweepGain(base, amount, from, -1)
      : this.gainLeft;
    const rightFrom = Number.isNaN(this.gainRight)
      ? sweepGain(base, amount, from, 1)
      : this.gainRight;
    this.gainLeft = leftTo;
    this.gainRight = rightTo;
    const leftStep = (leftTo - leftFrom) / length;
    const rightStep = (rightTo - rightFrom) / length;
    const depthTo = this.depthAt(end);
    const depthFrom = Number.isNaN(this.depth) ? this.depthAt(start) : this.depth;
    this.depth = depthTo;
    const depthStep = (depthTo - depthFrom) / length;

    // The blade-pass: a phasor turned each sample, from the phase at the start.
    const angle = 2 * Math.PI * this.phase;
    let c = Math.cos(angle);
    let s = Math.sin(angle);
    const turn = (2 * Math.PI * bladePass) / sr;
    const turnC = Math.cos(turn);
    const turnS = Math.sin(turn);
    const harmonic = 2 * BLADE_HARMONIC;
    const norm = 1 / BLADE_PEAK;
    const advanced = this.phase + (bladePass * length) / sr;
    this.phase = advanced - Math.floor(advanced);

    const prefix = this.prefix;
    const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = this.poles;
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0] = this.inputs;
    const direct = this.direct;
    const boost = this.bodyBoost;
    const [ha1 = 0, ha2 = 0, ha3 = 0, hk = 0] = this.highpass;
    const [ba1 = 0, ba2 = 0, ba3 = 0, bk = 0] = this.body;
    const [la1 = 0, la2 = 0, la3 = 0] = this.lowpass;
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
    let hr1 = st[6];
    let hr2 = st[7];
    let br1 = st[8];
    let br2 = st[9];
    let lr1 = st[10];
    let lr2 = st[11];
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
      // The blades: 1 + depth · wave, the wave a sine plus its second harmonic (sin 2θ = 2 s c).
      const blade = 1 + (depthFrom + depthStep * k) * norm * (s + harmonic * s * c);
      const nextC = c * turnC - s * turnS;
      s = s * turnC + c * turnS;
      c = nextC;

      // Left: high-pass, body, low-pass.
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
      x += boost * bk * v1;
      v3 = x - ll2;
      v1 = la1 * ll1 + la2 * v3;
      v2 = ll2 + la2 * ll1 + la3 * v3;
      ll1 = 2 * v1 - ll1;
      ll2 = 2 * v2 - ll2;
      const l = (leftFrom + leftStep * k) * blade * v2;

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
      x += boost * bk * v1;
      v3 = x - lr2;
      v1 = la1 * lr1 + la2 * v3;
      v2 = lr2 + la2 * lr1 + la3 * v3;
      lr1 = 2 * v1 - lr1;
      lr2 = 2 * v2 - lr2;
      const r = (rightFrom + rightStep * k) * blade * v2;

      // The guard only touches the rarest peaks: skip the call for the rest.
      left[i] = l > GUARD_KNEE || l < -GUARD_KNEE ? guard(l) : l;
      right[i] = r > GUARD_KNEE || r < -GUARD_KNEE ? guard(r) : r;
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
    st[6] = hr1;
    st[7] = hr2;
    st[8] = br1;
    st[9] = br2;
    st[10] = lr1;
    st[11] = lr2;
  }

  /** The blade-pass depth at absolute sample `n`, moved by the drift. */
  private depthAt(n: number): number {
    return FAN_SPECS[this.type].depth * (1 + DEPTH_SWING * this.depthDrift.valueAt(n));
  }
}

interface FanOptions {
  type: FanType;
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isFanType = (value: unknown): value is FanType =>
  typeof value === "string" && Object.hasOwn(FAN_SPECS, value);

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readFanOptions(raw: unknown): FanOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const type = get("type");
  return {
    type: isFanType(type) ? type : "desk",
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
