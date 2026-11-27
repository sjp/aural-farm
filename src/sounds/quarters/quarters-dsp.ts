/**
 * Crew Quarters' seeded signals, and the param mappings the rest of the sound
 * uses: pure code with no Web Audio globals, run by `quarters.worklet.ts` and
 * checked in Node.
 *
 * The worklet makes everything that depends on the seed, so a seed change
 * crossfades one node:
 *
 * - **Ventilation.** Decorrelated counter-hashed white noise per side (each
 *   sample's hash gives both sides, one in each half), integrated into brown
 *   noise, high-passed under the rumble so nothing is wasted below hearing,
 *   and low-passed at a cutoff that follows Warmth. Over it, a second noise
 *   per side, tilted down like pink noise and band-passed around 320 Hz,
 *   gives the rumble some body on small speakers. A slow drift moves the
 *   whole vent's level by about a decibel. A soft guard bends the rarest
 *   peaks with every level at its highest.
 * - **Hull.** The pink-tilted noise rings three narrow band-passes at seeded
 *   frequencies (one low in the centre, one a little left, one a little
 *   right), each swelling and fading on its own slow drift over minutes.
 * - **The engine's drifts.** Two slow random walks of absolute time, for the
 *   native engine hum's level and its pitch wander.
 *
 * Making the noise here, rather than with native filters on the shared noise,
 * keeps the whole sound to one worklet node and a few native ones.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { Svf } from "../../audio/dsp/svf";
import { HASH_START, hashFloat, hashStep } from "../../audio/random";

export const QUARTERS_PROCESSOR = "aural-quarters";

/** The worklet's output channels, in order. */
export const BED_LEFT = 0;
export const BED_RIGHT = 1;
export const HUM_LEVEL = 2;
export const HUM_WANDER = 3;
export const QUARTERS_CHANNELS = 4;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Random streams: the brown and pink noises, and the drifts. */
const BROWN_STREAM = 0;
const PINK_STREAM = 1;
const VENT_STREAM = 2;
const HUM_LEVEL_STREAM = 3;
export const HUM_WANDER_STREAM = 4;
/** The hull bands' drifts take this stream and the next two. */
const HULL_STREAM = 5;

/**
 * The ventilation's brown noise at Ventilation 100 and the default Warmth, in
 * dBFS RMS per channel: the level everything else is set against.
 */
export const VENT_DB = -19;
/** The pink band under the brown noise, in dB. */
const PINK_UNDER_DB = -10;
/** The hull at Hull 100, against the ventilation at Ventilation 100, in dB. */
const HULL_UNDER_VENT_DB = -8;
/** The engine hum at Engine hum 100, against the ventilation at Ventilation 100, in dB. */
export const HUM_UNDER_VENT_DB = -10;
/** The ventilation's level at Ventilation 0, against 100, in dB. */
export const AIR_FLOOR_DB = -18;

/** Brown noise: white through a one-pole at this corner, in Hz. */
const BROWN_CORNER = 40;
/** The high-pass under the rumble, in Hz. */
const RUMBLE_HIGHPASS = 55;
const RUMBLE_HIGHPASS_Q = Math.SQRT1_2;
/** The vent's low-pass: its cutoff at Warmth 0 and 100, in Hz, and its Q. */
export const CUTOFF_AIRY = 700;
export const CUTOFF_DARK = 220;
const VENT_Q = 0.5;
/** Warmth's default. */
const DEFAULT_WARMTH = 60;
/**
 * Warmth steps between the points where the brown noise's level is worked
 * out: Warmth changes the vent's tone, not its level, so the gain between
 * them follows the low-pass.
 */
const WARMTH_STEP = 10;
/** The pink band: a one-pole tilt and a band-pass, both at this centre, in Hz. */
const PINK_CENTRE = 320;
const PINK_Q = 0.8;

/** The hull's bands: each one's range in Hz, and their Q. */
export const HULL_RANGES = [
  [62, 78],
  [105, 125],
  [170, 200],
] as const;
const HULL_Q = 5;
/** Each band's place: the low one centred, the others a little left and right. */
const HULL_PANS = [0, -0.5, 0.5] as const;

/** The drifts' rates (knots per second of their slowest octave) and octaves. */
const VENT_DRIFT_RATE = 0.015;
const VENT_DRIFT_OCTAVES = 2;
const HULL_DRIFT_RATES = [0.006, 0.0079, 0.0097] as const;
const HULL_DRIFT_OCTAVES = 2;
const HUM_LEVEL_DRIFT_RATE = 0.01;
export const HUM_WANDER_DRIFT_RATE = 0.0113;
export const HUM_DRIFT_OCTAVES = 1;
/**
 * The hum's pitch wander: the delay line's base delay and swing, in seconds.
 * A delay moving at rate r shifts the pitch by a fraction r; the wander's
 * drift moves at most about 2.3 × its rate a second, so a swing of 40 ms
 * keeps the pitch within about ±1.8 cents.
 */
export const WANDER_DELAY = 0.06;
export const WANDER_SWING = 0.04;
/** How far the drifts move the vent's level and each hull band's, in dB either way. */
const VENT_SWING_DB = 1;
const HULL_SWING_DB = 3;

/** Maps 16 bits of a hash, centred, onto −1..1. */
const HALF_SCALE = 2 / 65535;
/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** The highest frequency and the step of the spectrum integrals that set the levels, in Hz. */
const SPECTRUM_TOP = 6000;
const SPECTRUM_STEP = 1;

/** The vent's low-pass cutoff at `warmth` (0–100): 700 Hz down to 220 Hz, evenly in pitch. */
export function ventCutoff(warmth: number): number {
  return CUTOFF_AIRY * (CUTOFF_DARK / CUTOFF_AIRY) ** clamp01(warmth / 100);
}

/** The vent's gain at `air` (0–100), against 100: −18 dB at 0, evenly in dB. */
export function airGain(air: number): number {
  return dbToGain(AIR_FLOOR_DB * (1 - clamp01(air / 100)));
}

/** The hull band frequencies for `seed`, one from each of `HULL_RANGES`, in Hz. */
export function hullFrequencies(seed: number): number[] {
  return HULL_RANGES.map(([low, high], n) => low + (high - low) * hashFloat(seed, n));
}

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

/**
 * The RMS of unit-variance white noise through a filter of power response
 * `power`, from its analogue form, close to the digital one this far below
 * Nyquist. Everything here is low-passed, so the integral stops at
 * `SPECTRUM_TOP`.
 */
function filteredRms(power: (f: number) => number, sampleRate: number): number {
  let sum = 0;
  for (let f = SPECTRUM_STEP / 2; f < SPECTRUM_TOP; f += SPECTRUM_STEP) {
    sum += power(f);
  }
  return Math.sqrt((sum * SPECTRUM_STEP) / (sampleRate / 2));
}

/** Brown noise's power at `f`, before the vent's low-pass: the one-pole and the high-pass. */
const rumblePower = (f: number) =>
  onePolePower(f, BROWN_CORNER) * highpassPower(f, RUMBLE_HIGHPASS, RUMBLE_HIGHPASS_Q);

/**
 * The engine hum: a fundamental at 36 Hz with harmonics 2–5, each 4 dB under
 * the one before, plus a sine at the fundamental, all in one wave (they share
 * a pitch). Two low-passes at 170 Hz (Q 0.5) roll it off to sound as though
 * it comes through the hull: their gain at each harmonic is built into the
 * wave, which saves two filters, and leaves harmonics 4 and 5 (144 and 180 Hz)
 * just enough to carry on small speakers.
 */
export const HUM = 36;
export const HUM_HARMONICS = 5;
export const HUM_STEP_DB = -4;
export const HUM_SINE = 0.5;
const HUM_LOWPASS = 170;
const HUM_LOWPASS_Q = 0.5;
const HUM_LOWPASSES = 2;

/** The hum's low-passes' gain at `frequency`. */
export function humRolloff(frequency: number): number {
  const x = frequency / HUM_LOWPASS;
  return (1 / Math.hypot(1 - x * x, x / HUM_LOWPASS_Q)) ** HUM_LOWPASSES;
}

/** The hum as `PeriodicWave` coefficients: sines, rolled off by the low-passes. */
export function humWave(): { real: number[]; imag: number[] } {
  const imag = [0];
  for (let k = 1; k <= HUM_HARMONICS; k++) {
    const level = dbToGain(HUM_STEP_DB * (k - 1)) + (k === 1 ? HUM_SINE : 0);
    imag.push(level * humRolloff(HUM * k));
  }
  return { real: imag.map(() => 0), imag };
}

/** The hum's RMS at unit gain. */
export function humRms(): number {
  return Math.sqrt(humWave().imag.reduce((sum, a) => sum + (a * a) / 2, 0));
}

/** The hum's gain at `hum` (0–100): none at 0, 10 dB under the ventilation's full level at 100. */
export function humGain(hum: number): number {
  return (dbToGain(VENT_DB + HUM_UNDER_VENT_DB) / humRms()) * clamp01(hum / 100);
}

/**
 * The guard on the bed: unchanged below the knee, then a tanh curve that
 * never passes the ceiling. Only the rarest peaks of brown noise reach it,
 * with every level at its highest; the hum fits in the headroom above it.
 */
const GUARD_KNEE = dbToGain(-7);
const GUARD_CEILING = dbToGain(-4.5);

export function guard(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= GUARD_KNEE) {
    return x;
  }
  const room = GUARD_CEILING - GUARD_KNEE;
  const y = GUARD_KNEE + room * Math.tanh((magnitude - GUARD_KNEE) / room);
  return x < 0 ? -y : y;
}

interface Ramp {
  from: number;
  to: number;
}

/**
 * Everything the Crew Quarters worklet makes, from absolute samples: the
 * stereo bed (ventilation and hull) and the engine's two drifts, the same
 * whether rendered in one go or in chunks.
 */
export class QuartersKernel {
  readonly hullFrequencies: readonly number[];
  /** Hash prefixes: each sample's hash gives both sides' noise, one in each half. */
  private readonly brownPrefix: number;
  private readonly pinkPrefix: number;
  private readonly brownPole: number;
  private readonly brownGain: number;
  private readonly pinkPole: number;
  private readonly brown = new Float64Array(2);
  private readonly pink = new Float64Array(2);
  private readonly highpass: Svf[];
  private readonly lowpass: Svf[];
  private readonly band: Svf[];
  private readonly hull: Svf[];
  private readonly ventDrift: DriftGenerator;
  private readonly hullDrifts: DriftGenerator[];
  private readonly humLevel: DriftGenerator;
  private readonly humWander: DriftGenerator;
  /**
   * Gains on the filters' outputs: the vent's brown noise at each
   * `WARMTH_STEP` of Warmth and its pink band, at Ventilation 100, and each
   * hull band's at Hull 100.
   */
  private readonly brownScales: Float64Array;
  private readonly pinkScale: number;
  private readonly hullScales: Float64Array;
  /** Each hull band's left and right gains. */
  private readonly hullLeft: Float64Array;
  private readonly hullRight: Float64Array;
  /** The params `set` gave. */
  private air = 60;
  private hullShare = 0.4;
  private warmth = DEFAULT_WARMTH;
  /** The cutoff the low-passes hold. */
  private cutoff = Number.NaN;
  /** The vent's and each hull band's gain at the end of the last render, to ramp from. */
  private vent = Number.NaN;
  private readonly hullGains = new Float64Array(HULL_RANGES.length).fill(Number.NaN);
  private readonly ramp: Ramp = { from: 0, to: 0 };
  /** Each hull band's gain at the start of this render, and its step per sample. */
  private readonly hullFrom = new Float64Array(HULL_RANGES.length);
  private readonly hullStep = new Float64Array(HULL_RANGES.length);
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.brownPrefix = hashStep(hashStep(HASH_START, seed), BROWN_STREAM);
    this.pinkPrefix = hashStep(hashStep(HASH_START, seed), PINK_STREAM);
    this.brownPole = Math.exp((-2 * Math.PI * BROWN_CORNER) / sampleRate);
    this.brownGain = UNIFORM_TO_UNIT * (1 - this.brownPole);
    this.pinkPole = Math.exp((-2 * Math.PI * PINK_CENTRE) / sampleRate);
    const pair = (cutoff: number, q: number) => [0, 1].map(() => new Svf(sampleRate, cutoff, q));
    this.highpass = pair(RUMBLE_HIGHPASS, RUMBLE_HIGHPASS_Q);
    this.lowpass = pair(ventCutoff(DEFAULT_WARMTH), VENT_Q);
    this.band = pair(PINK_CENTRE, PINK_Q);
    this.hullFrequencies = hullFrequencies(seed);
    this.hull = this.hullFrequencies.map((f) => new Svf(sampleRate, f, HULL_Q));
    const drift = (stream: number, rate: number, octaves: number) =>
      new DriftGenerator(seed, stream, rate, octaves, sampleRate);
    this.ventDrift = drift(VENT_STREAM, VENT_DRIFT_RATE, VENT_DRIFT_OCTAVES);
    this.hullDrifts = HULL_DRIFT_RATES.map((rate, i) =>
      drift(HULL_STREAM + i, rate, HULL_DRIFT_OCTAVES),
    );
    this.humLevel = drift(HUM_LEVEL_STREAM, HUM_LEVEL_DRIFT_RATE, HUM_DRIFT_OCTAVES);
    this.humWander = drift(HUM_WANDER_STREAM, HUM_WANDER_DRIFT_RATE, HUM_DRIFT_OCTAVES);

    // The brown noise keeps the vent's level whatever the Warmth; the pink
    // band and each hull band are set against it.
    this.brownScales = Float64Array.from({ length: 100 / WARMTH_STEP + 1 }, (_, i) => {
      const cutoff = ventCutoff(i * WARMTH_STEP);
      const rms = filteredRms((f) => rumblePower(f) * lowpassPower(f, cutoff, VENT_Q), sampleRate);
      return dbToGain(VENT_DB) / rms;
    });
    const pinkRms = filteredRms(
      (f) => onePolePower(f, PINK_CENTRE) * bandpassPower(f, PINK_CENTRE, PINK_Q),
      sampleRate,
    );
    this.pinkScale = dbToGain(VENT_DB + PINK_UNDER_DB) / pinkRms;
    // The hull's total power, shared equally between its bands.
    const bandDb = VENT_DB + HULL_UNDER_VENT_DB - 10 * Math.log10(HULL_RANGES.length);
    this.hullScales = Float64Array.from(
      this.hullFrequencies,
      (centre) =>
        dbToGain(bandDb) /
        filteredRms(
          (f) => onePolePower(f, PINK_CENTRE) * bandpassPower(f, centre, HULL_Q),
          sampleRate,
        ),
    );
    // Equal-power pans, scaled so each band keeps its power per channel.
    const angle = (pan: number) => ((pan + 1) * Math.PI) / 4;
    this.hullLeft = Float64Array.from(HULL_PANS, (pan) => Math.SQRT2 * Math.cos(angle(pan)));
    this.hullRight = Float64Array.from(HULL_PANS, (pan) => Math.SQRT2 * Math.sin(angle(pan)));
  }

  /** Sets the params for the next render: Ventilation, Hull and Warmth, each 0–100. */
  set(air: number, hull: number, warmth: number): void {
    this.air = air;
    this.hullShare = clamp01(hull / 100);
    this.warmth = warmth;
  }

  /**
   * Fills `outputs` (`QUARTERS_CHANNELS` arrays of one length, in channel
   * order) from absolute sample `start`.
   */
  render(outputs: readonly Float32Array[], start: number): void {
    const left = outputs[BED_LEFT];
    const right = outputs[BED_RIGHT];
    const humLevel = outputs[HUM_LEVEL];
    const humWander = outputs[HUM_WANDER];
    const length = left.length;
    const end = start + length;
    if (start !== this.expected) {
      // A fresh start: levels start where they stand rather than ramping from the past.
      this.vent = Number.NaN;
      this.hullGains.fill(Number.NaN);
    }
    this.expected = end;

    const cutoff = ventCutoff(this.warmth);
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      for (const lowpass of this.lowpass) {
        lowpass.set(cutoff, VENT_Q);
      }
    }

    // The drifts barely move in a render quantum: levels ramp between their values at either end.
    const vent = this.levelRamp(
      this.vent,
      airGain(this.air),
      this.ventDrift,
      VENT_SWING_DB,
      start,
      end,
    );
    this.vent = vent.to;
    const ventFrom = vent.from;
    const ventStep = (vent.to - vent.from) / length;
    const hullFrom = this.hullFrom;
    const hullStep = this.hullStep;
    for (let b = 0; b < HULL_RANGES.length; b++) {
      const ramp = this.levelRamp(
        this.hullGains[b],
        this.hullScales[b] * this.hullShare,
        this.hullDrifts[b],
        HULL_SWING_DB,
        start,
        end,
      );
      this.hullGains[b] = ramp.to;
      hullFrom[b] = ramp.from;
      hullStep[b] = (ramp.to - ramp.from) / length;
    }

    const brownPrefix = this.brownPrefix;
    const pinkPrefix = this.pinkPrefix;
    const [highpassLeft, highpassRight] = this.highpass;
    const [lowpassLeft, lowpassRight] = this.lowpass;
    const [bandLeft, bandRight] = this.band;
    const [hullLow, hullMid, hullHigh] = this.hull;
    const brownPole = this.brownPole;
    const brownGain = this.brownGain;
    const pinkPole = this.pinkPole;
    const pinkGain = (1 - pinkPole) * UNIFORM_TO_UNIT;
    const brownScale = this.brownScale(this.warmth);
    const pinkScale = this.pinkScale;
    const [lowFrom = 0, midFrom = 0, highFrom = 0] = hullFrom;
    const [lowStep = 0, midStep = 0, highStep = 0] = hullStep;
    const [lowLeft = 0, midLeft = 0, highLeft = 0] = this.hullLeft;
    const [lowRight = 0, midRight = 0, highRight = 0] = this.hullRight;
    let brownL = this.brown[0];
    let brownR = this.brown[1];
    let pinkL = this.pink[0];
    let pinkR = this.pink[1];
    for (let i = 0; i < length; i++) {
      const n = start + i;
      const k = i + 1;
      // One hash per noise per sample: its high half for the left, its low half for the right.
      const brownHash = hashStep(brownPrefix, n);
      const pinkHash = hashStep(pinkPrefix, n);
      brownL = brownPole * brownL + brownGain * ((brownHash >>> 16) * HALF_SCALE - 1);
      brownR = brownPole * brownR + brownGain * ((brownHash & 0xffff) * HALF_SCALE - 1);
      pinkL = pinkPole * pinkL + pinkGain * ((pinkHash >>> 16) * HALF_SCALE - 1);
      pinkR = pinkPole * pinkR + pinkGain * ((pinkHash & 0xffff) * HALF_SCALE - 1);
      highpassLeft.tick(brownL);
      highpassRight.tick(brownR);
      const rumbleL = highpassLeft.high;
      const rumbleR = highpassRight.high;
      lowpassLeft.tick(rumbleL);
      lowpassRight.tick(rumbleR);
      bandLeft.tick(pinkL);
      bandRight.tick(pinkR);
      hullLow.tick((pinkL + pinkR) * Math.SQRT1_2);
      hullMid.tick(pinkL);
      hullHigh.tick(pinkR);
      const ventGain = ventFrom + ventStep * k;
      const low = (lowFrom + lowStep * k) * hullLow.band;
      const mid = (midFrom + midStep * k) * hullMid.band;
      const high = (highFrom + highStep * k) * hullHigh.band;
      const l =
        ventGain * (brownScale * lowpassLeft.low + pinkScale * bandLeft.band) +
        lowLeft * low +
        midLeft * mid +
        highLeft * high;
      const r =
        ventGain * (brownScale * lowpassRight.low + pinkScale * bandRight.band) +
        lowRight * low +
        midRight * mid +
        highRight * high;
      // The guard only touches the rarest peaks: skip the call for the rest.
      left[i] = l > GUARD_KNEE || l < -GUARD_KNEE ? guard(l) : l;
      right[i] = r > GUARD_KNEE || r < -GUARD_KNEE ? guard(r) : r;
    }
    this.brown[0] = brownL;
    this.brown[1] = brownR;
    this.pink[0] = pinkL;
    this.pink[1] = pinkR;

    // The engine's drifts ramp between their values at either end of the quantum.
    this.fillDrift(humLevel, this.humLevel, start, end);
    this.fillDrift(humWander, this.humWander, start, end);
  }

  /** The brown noise's gain at `warmth`, between the worked-out points. */
  private brownScale(warmth: number): number {
    const x = Math.min(100, Math.max(0, warmth)) / WARMTH_STEP;
    const i = Math.min(Math.floor(x), this.brownScales.length - 2);
    const a = this.brownScales[i] ?? 0;
    const b = this.brownScales[i + 1] ?? 0;
    return a + (b - a) * (x - i);
  }

  /**
   * A level's ramp across a render: from `last` (or where it stands, on a
   * fresh start) to `base`, moved by `drift` by up to `swingDb` either way.
   */
  private levelRamp(
    last: number,
    base: number,
    drift: DriftGenerator,
    swingDb: number,
    start: number,
    end: number,
  ): Ramp {
    const at = (n: number) => base * dbToGain(swingDb * drift.valueAt(n));
    this.ramp.to = at(end);
    this.ramp.from = Number.isNaN(last) ? at(start) : last;
    return this.ramp;
  }

  private fillDrift(out: Float32Array, drift: DriftGenerator, start: number, end: number): void {
    const from = drift.valueAt(start);
    const step = (drift.valueAt(end) - from) / out.length;
    for (let i = 0; i < out.length; i++) {
      out[i] = from + step * i;
    }
  }
}

interface QuartersOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readQuartersOptions(raw: unknown): QuartersOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
