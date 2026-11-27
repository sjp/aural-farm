/**
 * Distant City's sound: pure code with no Web Audio globals, run by
 * `city.worklet.ts` and checked in Node.
 *
 * A city heard from an open window several streets away, all from one worklet
 * per seed:
 *
 * - **Rumble.** The low wash of traffic from everywhere at once: brown noise
 *   low-passed (260 Hz at night, 420 Hz by day, Q 0.5) and high-passed at
 *   35 Hz, with white noise band-passed at 600 Hz, Q 0.8, 14 dB under it for
 *   the mid-range of tyres on tarmac that carries on small speakers (over one
 *   band, white and pink noise differ only by a slight tilt). Each side has
 *   its own noise. Two drifts at unrelated rates swell it as lights change
 *   across town: one moves its level ±3 dB, the other its low-pass ±20 %. Day
 *   lifts it 4 dB; a change of time glides over about two seconds.
 * - **Passing cars.** Now and then a single car on a nearer road: a Poisson
 *   process over 1 s blocks of absolute time, about 0.25 cars a second by day
 *   and 0.05 at night at Traffic 50. Each car is 3–7 s of its own
 *   counter-hashed white noise through a band-pass at 400–900 Hz, under a
 *   raised-cosine bump (45 % rise, 55 % fall), peaking 6–16 dB under the
 *   day's rumble. Over the bump the band's centre falls 12 % (the pitch drop
 *   as it passes), its Q eases from 1.5 to 0.9, and it pans from one side to
 *   the other (±0.7). The cars' sum goes through a one-pole low-pass at
 *   2.5 kHz: no tyre hiss carries this far.
 * - **Far signals.** If on, a very distant horn (two notes of six harmonics,
 *   0.3–0.8 s, through a low-pass at 1.4 kHz) or a siren far off (a tone and
 *   its third harmonic sweeping 600↔900 Hz every 3–4 s, 8–14 s long, fading
 *   in and out over 3 s each), peaking 24 dB under the rumble, about every 6
 *   minutes (Rare) or 2 (Occasional).
 *
 * The worklet's four channels are the sound (left, right) and its feed to the
 * outdoor reverb (left, right), which holds the cars at −18 dB, the rumble at
 * −28 and the signals at −12, so the signals lean most on the reverb. The
 * Space param scales that feed.
 *
 * Events come from per-block hashes, each car's and signal's shape and noise
 * from its own hash, and they latch the params as they start; slow modulators
 * are drifts of absolute time. A render that starts afresh picks up the
 * events already sounding, part-way through, and warms the filters up, so at
 * steady params the output depends only on the seed and absolute time.
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
import { svfCoefficients } from "../../audio/dsp/svf";
import { VoicePool } from "../../audio/dsp/voices";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import type { CitySignals, CityTime } from "./city.meta";

export const CITY_PROCESSOR = "aural-city";
/** The worklet's output channels: the sound (left, right), then its reverb feed (left, right). */
export const CITY_CHANNELS = 4;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const unit = (state: number, salt: number) => hashStep(state, salt) * UINT32_SCALE;

/** Random streams: each source of randomness its own. */
const NOISE_STREAM = 0;
export const CAR_STREAM = 1;
export const SIGNAL_STREAM = 2;
const SWELL_STREAM = 3;
const CUTOFF_STREAM = 4;

// ---------------------------------------------------------------------------
// Params.

/** Cars per second at Traffic 50, by time of day. */
const CAR_RATES: Readonly<Record<CityTime, number>> = { night: 0.05, day: 0.25 };

/** Cars per second at `traffic` (0–100), by day (`day` 1) or night (0): in proportion to it. */
export function carRate(traffic: number, day: number): number {
  const base = day >= 0.5 ? CAR_RATES.day : CAR_RATES.night;
  return (base * clamp(traffic, 0, 100)) / 50;
}

/** The mean gap between far signals, in seconds, or 0 for none. */
const SIGNAL_GAPS: Readonly<Record<CitySignals, number>> = { off: 0, rare: 360, occasional: 120 };

/** Far signals per second for a `signals` setting. */
export function signalRate(signals: CitySignals): number {
  const gap = SIGNAL_GAPS[signals];
  return gap > 0 ? 1 / gap : 0;
}

/** The reverb feed's level for Space (0–100), in dB: −12 to +12, so the cars' send runs −30 to −6. */
export function spaceDb(space: number): number {
  return 24 * (clamp(space, 0, 100) / 100 - 0.5);
}

/**
 * The rumble's gain for Rumble (0–100): none at 0, 1 at the default 60, and
 * 3 dB more at 100, on a curve that leaves low settings still faintly there.
 */
export function rumbleShare(rumble: number): number {
  return (clamp(rumble, 0, 100) / 60) ** RUMBLE_CURVE;
}

/** The power that bends Rumble's curve. */
const RUMBLE_CURVE = 0.7;

// ---------------------------------------------------------------------------
// Levels.

/** The rumble's RMS per channel by day at Rumble 60, before its swell, in dBFS. */
export const RUMBLE_DB = -21;
/** How much the day lifts the rumble, in dB: with its brighter low-pass, about 4 dB in all. */
const DAY_DB = 3.5;
/** The rumble's mid band against its brown layer, in dB. */
const MID_DB = -14;
/** How far the rumble's swell moves its level, in dB, and its drift's rate. */
const SWELL_DB = 3;
const SWELL_RATE = 0.03;
/** How far the cutoff drift moves the low-pass, as a ratio either way, and its rate. */
const CUTOFF_SWING = 1.2;
const CUTOFF_RATE = 0.011;
/** The rumble's low-pass by night and by day, in Hz, and its Q. */
const NIGHT_CUTOFF = 260;
const DAY_CUTOFF = 420;
const RUMBLE_Q = 0.5;
/** Brown noise's corner, the rumble's high-pass and the mid band, in Hz, with Qs. */
const BROWN_CORNER = 40;
const RUMBLE_HIGHPASS = 35;
/** The high-pass's two stages' Qs: together a fourth-order Butterworth, clear of the sub-bass. */
const HIGHPASS_Q = [0.5412, 1.3066] as const;
const MID_CENTRE = 600;
const MID_Q = 0.8;
/**
 * The gain that brings the brown layer, low-passed and high-passed, to about
 * unit RMS at the cutoffs it runs at (measured: its RMS moves about ±2 dB
 * between the night's and the day's cutoff, as a darker rumble should).
 */
const BROWN_SCALE = 33;
/** How fast a change of time glides, in seconds (time constant: done in about 2 s). */
const DAY_GLIDE = 0.6;

/** Each feed to the reverb at Space 50, in dB. */
const RUMBLE_SEND_DB = -28;
const CAR_SEND_DB = -18;
const SIGNAL_SEND_DB = -12;

// ---------------------------------------------------------------------------
// Cars.

/** A car's length, in seconds, from–to. */
const CAR_SHORTEST = 3;
export const CAR_LONGEST = 7;
/** Its band-pass's centre at the closest point, in Hz, from–to. */
const CAR_LOW = 400;
const CAR_HIGH = 900;
/** Its peak, in dB against the day's rumble, from–to. */
const CAR_QUIET_DB = -16;
const CAR_LOUD_DB = -6;
/** The share of the bump spent rising. */
export const CAR_RISE = 0.45;
/** How far the centre falls over the pass, as a share, and the Q's start and end. */
export const DOPPLER = 0.12;
const Q_START = 1.5;
const Q_END = 0.9;
/** How far each pass reaches either side. */
export const CAR_PAN = 0.7;
/** The low-pass on the cars, in Hz. */
const CAR_LOWPASS = 2500;
/** Voices: plenty for Traffic 100 by day (about 2.5 cars at once on average). */
const CAR_VOICES = 8;
/** Cars a 1 s block can hold. */
const CAR_CAPACITY = 16;

/** Salts for a car's random properties. */
const LENGTH_SALT = 1;
const CENTRE_SALT = 2;
const LEVEL_SALT = 3;
const DIRECTION_SALT = 4;
const NOISE_SALT = 5;

/** A car, from its event hash. */
interface CarShape {
  /** Its length, in seconds. */
  length: number;
  /** Its band-pass's centre at the middle of the pass, in Hz. */
  centre: number;
  /** Its peak, in dB against the day's rumble. */
  peakDb: number;
  /** 1 for left to right, −1 for right to left. */
  direction: number;
}

export function carShape(hash: number): CarShape {
  return {
    length: CAR_SHORTEST + (CAR_LONGEST - CAR_SHORTEST) * unit(hash, LENGTH_SALT),
    centre: CAR_LOW + (CAR_HIGH - CAR_LOW) * unit(hash, CENTRE_SALT),
    peakDb: CAR_QUIET_DB + (CAR_LOUD_DB - CAR_QUIET_DB) * unit(hash, LEVEL_SALT),
    direction: unit(hash, DIRECTION_SALT) < 0.5 ? 1 : -1,
  };
}

/**
 * A pass's envelope at `p` (0 at its start, 1 at its end): a raised-cosine
 * bump, rising over `CAR_RISE` of it and falling over the rest, 0 at both ends
 * and outside them, 1 at the peak.
 */
export function carEnvelope(p: number): number {
  if (!(p > 0 && p < 1)) {
    return 0;
  }
  return p < CAR_RISE
    ? 0.5 - 0.5 * Math.cos((Math.PI * p) / CAR_RISE)
    : 0.5 + 0.5 * Math.cos((Math.PI * (p - CAR_RISE)) / (1 - CAR_RISE));
}

/**
 * How far through the pass the car has moved at `p`, 0 to 1: half-way at the
 * envelope's peak, fastest there and easing at both ends, as a car's bearing
 * swings fastest as it passes closest. It never goes back.
 */
export function carSweep(p: number): number {
  const x = clamp(p, 0, 1);
  const q = x < CAR_RISE ? (0.5 * x) / CAR_RISE : 0.5 + (0.5 * (x - CAR_RISE)) / (1 - CAR_RISE);
  return q * q * (3 - 2 * q);
}

/** A car sounding. */
interface CarVoice {
  level: number;
  /** Samples since it started, and its length in samples. */
  position: number;
  length: number;
  noise: number;
  centre: number;
  direction: number;
  /** Its peak gain, against unit-RMS output from its band. */
  gain: number;
  /** The band-pass's coefficients and state. */
  a1: number;
  a2: number;
  a3: number;
  k: number;
  ic1: number;
  ic2: number;
  /** The gains on each side now and their steps per sample, to the next control point. */
  left: number;
  right: number;
  leftStep: number;
  rightStep: number;
}

// ---------------------------------------------------------------------------
// Far signals.

/** A signal's peak, in dB against the day's rumble. */
const SIGNAL_DB = -24;
/** The share of signals that are sirens; the rest are horns. */
const SIREN_SHARE = 0.35;
/** A horn: its lower note in Hz, the upper as a multiple of it, length, attack and release, in seconds. */
const HORN_LOW = 300;
const HORN_HIGH = 420;
const HORN_RATIO_LOW = 1.19;
const HORN_RATIO_HIGH = 1.26;
const HORN_SHORTEST = 0.3;
const HORN_LONGEST = 0.8;
const HORN_ATTACK = 0.04;
const HORN_RELEASE = 0.06;
const HORN_LOWPASS = 1400;
const HORN_HARMONICS = 6;
/** A siren: its sweep in Hz, the sweep's period and its length in seconds, and its fades. */
const SIREN_LOW = 600;
const SIREN_HIGH = 900;
const SIREN_PERIOD_LOW = 3;
const SIREN_PERIOD_HIGH = 4;
const SIREN_SHORTEST = 8;
export const SIREN_LONGEST = 14;
const SIREN_FADE = 3;
/** The siren's third harmonic against its fundamental, in dB. */
const SIREN_THIRD_DB = -12;
/** How far a signal may stand from the centre. */
export const SIGNAL_PAN = 0.6;
/** Signals sounding at once, and a block's capacity. */
const SIGNAL_VOICES = 2;
const SIGNAL_CAPACITY = 4;

/** Salts for a signal's random properties. */
const KIND_SALT = 11;
const PITCH_SALT = 12;
const RATIO_SALT = 13;
const SIGNAL_LENGTH_SALT = 14;
const PERIOD_SALT = 15;
const PAN_SALT = 16;

/** A far signal, from its event hash. */
interface SignalShape {
  siren: boolean;
  /** A horn's lower note, or a siren's period, in Hz and seconds. */
  pitch: number;
  ratio: number;
  period: number;
  length: number;
  pan: number;
}

export function signalShape(hash: number): SignalShape {
  const siren = unit(hash, KIND_SALT) < SIREN_SHARE;
  const u = unit(hash, SIGNAL_LENGTH_SALT);
  return {
    siren,
    pitch: HORN_LOW + (HORN_HIGH - HORN_LOW) * unit(hash, PITCH_SALT),
    ratio: HORN_RATIO_LOW + (HORN_RATIO_HIGH - HORN_RATIO_LOW) * unit(hash, RATIO_SALT),
    period: SIREN_PERIOD_LOW + (SIREN_PERIOD_HIGH - SIREN_PERIOD_LOW) * unit(hash, PERIOD_SALT),
    length: siren
      ? SIREN_SHORTEST + (SIREN_LONGEST - SIREN_SHORTEST) * u
      : HORN_SHORTEST + (HORN_LONGEST - HORN_SHORTEST) * u,
    pan: SIGNAL_PAN * (2 * unit(hash, PAN_SALT) - 1),
  };
}

/** A fade in and out on raised cosines, `attack` and `release` seconds long, over `length`. */
export function signalEnvelope(t: number, length: number, attack: number, release: number): number {
  if (!(t > 0 && t < length)) {
    return 0;
  }
  if (t < attack) {
    return 0.5 - 0.5 * Math.cos((Math.PI * t) / attack);
  }
  const left = length - t;
  return left < release ? 0.5 - 0.5 * Math.cos((Math.PI * left) / release) : 1;
}

/** A signal sounding. */
interface SignalVoice {
  active: boolean;
  position: number;
  end: number;
  shape: SignalShape;
  left: number;
  right: number;
  /** A horn's two one-pole low-passes. */
  low1: number;
  low2: number;
}

/** The horn's wave: harmonics 1–6 falling 6 dB an octave, scaled to a peak of 1. */
const HORN_WAVE = (() => {
  const size = 2048;
  const table = new Float32Array(size + 1);
  let peak = 0;
  for (let m = 0; m <= size; m++) {
    let sum = 0;
    for (let h = 1; h <= HORN_HARMONICS; h++) {
      sum += Math.sin((2 * Math.PI * h * m) / size) / h;
    }
    table[m] = sum;
    peak = Math.max(peak, Math.abs(sum));
  }
  for (let m = 0; m <= size; m++) {
    table[m] = (table[m] ?? 0) / peak;
  }
  return table;
})();
const HORN_WAVE_SIZE = HORN_WAVE.length - 1;

/** The horn's wave at phase `phase` cycles, linearly interpolated. */
function hornWave(phase: number): number {
  const x = (phase - Math.floor(phase)) * HORN_WAVE_SIZE;
  const i = Math.floor(x);
  const a = HORN_WAVE[i] ?? 0;
  return a + ((HORN_WAVE[i + 1] ?? 0) - a) * (x - i);
}

// ---------------------------------------------------------------------------
// The kernel.

/** Maps 16 bits of a hash, centred, onto −1..1. */
const HALF_SCALE = 2 / 65535;
/** Unit-variance white noise from uniform noise in [−1, 1). */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** The sample rate the noise's levels are set at: other rates scale it to the same density. */
const REFERENCE_RATE = 48000;
/** A render quantum, in samples: the most the kernel renders at once. */
const QUANTUM = 128;
/** A car's gains ramp between control points this many of its samples apart. */
const CONTROL = 32;
/** Seconds rendered silently before a render that starts afresh, for the filters to settle. */
const WARM_UP = 0.2;
/** The guard on the sound: above the knee, a tanh curve that never passes the ceiling. */
const GUARD_KNEE = dbToGain(-9);
const GUARD_CEILING = dbToGain(-3.5);
/** The rumble's filter states per side. */
const STATES = 9;

/** Unchanged below the knee, then easing towards the ceiling and never passing it. */
export function guard(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= GUARD_KNEE) {
    return x;
  }
  const room = GUARD_CEILING - GUARD_KNEE;
  const y = GUARD_KNEE + room * Math.tanh((magnitude - GUARD_KNEE) / room);
  return x < 0 ? -y : y;
}

/** The events of one stream, one block at a time: its offsets and which have started. */
class Schedule {
  readonly events: EventBlock;
  block = Number.NaN;
  next = 0;
  private readonly seed: number;
  private readonly stream: number;

  constructor(seed: number, stream: number, capacity: number) {
    this.seed = seed;
    this.stream = stream;
    this.events = createEventBlock(capacity);
  }

  /** Loads block `block`'s events at `rate` per second, which the block keeps. */
  load(block: number, rate: number): void {
    eventsInBlock(this.seed, this.stream, block, rate, this.events);
    this.block = block;
    this.next = 0;
  }

  /** The absolute sample event `i` of the loaded block starts at. */
  sample(i: number, sampleRate: number): number {
    return this.block * sampleRate + Math.floor((this.events.offsets[i] ?? 0) * sampleRate);
  }

  hash(i: number): number {
    return eventHash(this.seed, this.stream, this.block, i);
  }
}

/**
 * Distant City's whole sound for one seed, from absolute samples: the same
 * whether rendered in one go or in chunks, at steady params.
 */
export class CityKernel {
  private readonly sampleRate: number;
  private readonly prefix: number;
  private readonly white: number;
  private readonly brownPole: number;
  private readonly brownInput: number;
  /** As `svfCoefficients`: the rumble's low-pass (set per quantum), high-pass and mid band. */
  private readonly lowpass = new Float64Array(4);
  private readonly highpass: Float64Array;
  private readonly highpass2: Float64Array;
  private readonly mid: Float64Array;
  private readonly midGain: number;
  private readonly states = new Float64Array(2 * STATES);
  private readonly swell: DriftGenerator;
  private readonly cutoffDrift: DriftGenerator;

  private readonly cars: VoicePool<CarVoice>;
  private readonly carSchedule: Schedule;
  private readonly carPole: number;
  private carLeft = 0;
  private carRight = 0;
  private readonly signals: SignalVoice[];
  private readonly signalSchedule: Schedule;
  private readonly hornPole: number;
  private readonly scratch = Array.from({ length: 4 }, () => new Float32Array(QUANTUM));
  /** Where a warm-up renders, unheard. */
  private readonly unheard = Array.from({ length: 4 }, () => new Float32Array(QUANTUM));
  /** A car's values at this control point and the next, and its band's coefficients. */
  private readonly controlNow = new Float64Array(4);
  private readonly controlNext = new Float64Array(4);
  private readonly coefficients = new Float64Array(4);
  private readonly warmUpSamples: number;

  /** The params `set` gave. */
  private day = 0;
  private traffic = 50;
  private rumble = 60;
  private signalsPerSecond = 0;
  /** The day's share now (gliding to `day`), and the rumble's gain at the end of the last render. */
  private dayShare = Number.NaN;
  private rumbleGain = Number.NaN;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    const sr = sampleRate;
    this.sampleRate = sr;
    this.prefix = hashStep(hashStep(HASH_START, seed), NOISE_STREAM);
    this.white = UNIFORM_TO_UNIT * Math.sqrt(sr / REFERENCE_RATE);
    const pole = (corner: number) => Math.exp((-2 * Math.PI * corner) / sr);
    this.brownPole = pole(BROWN_CORNER);
    this.brownInput = (1 - this.brownPole) * BROWN_SCALE;
    this.highpass = svfCoefficients(new Float64Array(4), RUMBLE_HIGHPASS, HIGHPASS_Q[0], sr);
    this.highpass2 = svfCoefficients(new Float64Array(4), RUMBLE_HIGHPASS, HIGHPASS_Q[1], sr);
    this.mid = svfCoefficients(new Float64Array(4), MID_CENTRE, MID_Q, sr);
    // The band's RMS from unit-variance white at 48 kHz, √(π·f/(Q·sr)), brought to `MID_DB`.
    this.midGain = dbToGain(MID_DB) / Math.sqrt((Math.PI * MID_CENTRE) / (MID_Q * REFERENCE_RATE));
    this.swell = new DriftGenerator(seed, SWELL_STREAM, SWELL_RATE, 2, sr);
    this.cutoffDrift = new DriftGenerator(seed, CUTOFF_STREAM, CUTOFF_RATE, 1, sr);

    this.cars = new VoicePool<CarVoice>(CAR_VOICES, () => ({
      level: 0,
      position: 0,
      length: 0,
      noise: 0,
      centre: 0,
      direction: 1,
      gain: 0,
      a1: 0,
      a2: 0,
      a3: 0,
      k: 0,
      ic1: 0,
      ic2: 0,
      left: 0,
      right: 0,
      leftStep: 0,
      rightStep: 0,
    }));
    this.carSchedule = new Schedule(seed, CAR_STREAM, CAR_CAPACITY);
    this.carPole = pole(CAR_LOWPASS);
    this.signals = Array.from({ length: SIGNAL_VOICES }, () => ({
      active: false,
      position: 0,
      end: 0,
      shape: signalShape(0),
      left: 0,
      right: 0,
      low1: 0,
      low2: 0,
    }));
    this.signalSchedule = new Schedule(seed, SIGNAL_STREAM, SIGNAL_CAPACITY);
    this.hornPole = pole(HORN_LOWPASS);
    this.warmUpSamples = Math.ceil(WARM_UP * sr);
  }

  /**
   * Sets the params for the next render: `day` (1 day, 0 night; the rumble
   * glides to it, the cars' rate latches per block), Traffic and Rumble
   * (0–100), and the far signals per second (latched per block).
   */
  set(day: number, traffic: number, rumble: number, signals: number): void {
    this.day = day >= 0.5 ? 1 : 0;
    this.traffic = traffic;
    this.rumble = rumble;
    this.signalsPerSecond = Math.max(0, signals);
  }

  /** How many cars are sounding. */
  get carsSounding(): number {
    return this.cars.active;
  }

  /** How many far signals are sounding. */
  get signalsSounding(): number {
    return this.signals.filter((s) => s.active).length;
  }

  /** Fills `outputs` (four channels of one length) from absolute sample `start`. */
  render(outputs: readonly Float32Array[], start: number): void {
    const length = outputs[0]?.length ?? 0;
    if (start !== this.expected) {
      this.warmUp(start);
    }
    for (let done = 0; done < length; done += QUANTUM) {
      const n = Math.min(QUANTUM, length - done);
      this.process(outputs, done, n, start + done);
    }
    this.expected = start + length;
  }

  /**
   * A fresh start, or a jump: the rumble at the params' levels, the cars and
   * signals that started up to their longest before and still sound picked up
   * part-way through, then `WARM_UP` rendered silently for the filters.
   */
  private warmUp(start: number): void {
    const sr = this.sampleRate;
    this.dayShare = Number.NaN;
    this.rumbleGain = Number.NaN;
    this.states.fill(0);
    this.carLeft = 0;
    this.carRight = 0;
    this.cars.active = 0;
    for (const s of this.signals) {
      s.active = false;
    }
    let from = start - this.warmUpSamples;
    const first = blockOf(from, sr);
    for (let b = first - Math.ceil(CAR_LONGEST); b <= first; b++) {
      this.loadCars(b);
      const schedule = this.carSchedule;
      for (; schedule.next < schedule.events.count; schedule.next++) {
        const at = schedule.sample(schedule.next, sr);
        if (at >= from) {
          break;
        }
        this.startCar(schedule.hash(schedule.next), from - at);
      }
    }
    for (let b = first - Math.ceil(SIREN_LONGEST); b <= first; b++) {
      this.loadSignals(b);
      const schedule = this.signalSchedule;
      for (; schedule.next < schedule.events.count; schedule.next++) {
        const at = schedule.sample(schedule.next, sr);
        if (at >= from) {
          break;
        }
        this.startSignal(schedule.hash(schedule.next), from - at);
      }
    }
    while (from < start) {
      const n = Math.min(QUANTUM, start - from);
      this.process(this.unheard, 0, n, from);
      from += n;
    }
  }

  private loadCars(block: number): void {
    this.carSchedule.load(block, carRate(this.traffic, this.day));
  }

  private loadSignals(block: number): void {
    this.signalSchedule.load(block, this.signalsPerSecond);
  }

  /** Starts the car of hash `hash`, `elapsed` samples in, unless it has already passed. */
  private startCar(hash: number, elapsed: number): void {
    const shape = carShape(hash);
    const length = Math.floor(shape.length * this.sampleRate);
    if (elapsed >= length) {
      return;
    }
    const voice = this.cars.allocate();
    voice.position = elapsed;
    voice.length = length;
    voice.noise = hashStep(hash, NOISE_SALT);
    voice.centre = shape.centre;
    voice.direction = shape.direction;
    // Lifted 3 dB, so a car in the middle reads its level on each side.
    voice.gain = Math.SQRT2 * dbToGain(RUMBLE_DB + shape.peakDb);
    voice.ic1 = 0;
    voice.ic2 = 0;
    this.carControl(voice, elapsed - (elapsed % CONTROL));
    const into = elapsed % CONTROL;
    voice.left += voice.leftStep * into;
    voice.right += voice.rightStep * into;
  }

  /**
   * Sets a car's band-pass at its sample `grid` (a multiple of `CONTROL`), and
   * its gains there with their steps to the next control point. The band's
   * gain is normalised by its RMS from unit-variance white, √(π·f/(Q·sr)), so
   * the car's loudness follows the envelope alone.
   */
  private carControl(voice: CarVoice, grid: number): void {
    const sr = this.sampleRate;
    const gains = (n: number, into: Float64Array) => {
      const p = n / voice.length;
      const sweep = carSweep(p);
      const centre = voice.centre * (1 + DOPPLER / 2 - DOPPLER * sweep);
      const q = Q_START + (Q_END - Q_START) * sweep;
      const pan = voice.direction * CAR_PAN * (2 * sweep - 1);
      const g = (voice.gain * carEnvelope(p)) / Math.sqrt((Math.PI * centre) / (q * sr));
      into[0] = g * panLeft(pan);
      into[1] = g * panRight(pan);
      into[2] = centre;
      into[3] = q;
    };
    const now = this.controlNow;
    const next = this.controlNext;
    gains(grid, now);
    gains(grid + CONTROL, next);
    const c = svfCoefficients(this.coefficients, now[2], now[3], sr);
    voice.a1 = c[0];
    voice.a2 = c[1];
    voice.a3 = c[2];
    voice.k = c[3];
    voice.left = now[0];
    voice.right = now[1];
    voice.leftStep = (next[0] - voice.left) / CONTROL;
    voice.rightStep = (next[1] - voice.right) / CONTROL;
    voice.level = Math.max(voice.left, voice.right);
  }

  /** Starts the signal of hash `hash`, `elapsed` samples in, unless it has already ended. */
  private startSignal(hash: number, elapsed: number): void {
    const shape = signalShape(hash);
    const end = Math.floor(shape.length * this.sampleRate);
    if (elapsed >= end) {
      return;
    }
    let voice = this.signals[0];
    for (const s of this.signals) {
      if (!s.active) {
        voice = s;
        break;
      }
      if (s.position > voice.position) {
        voice = s;
      }
    }
    const gain = Math.SQRT2 * dbToGain(RUMBLE_DB + SIGNAL_DB);
    voice.active = true;
    voice.position = elapsed;
    voice.end = end;
    voice.shape = shape;
    voice.left = gain * panLeft(shape.pan);
    voice.right = gain * panRight(shape.pan);
    voice.low1 = 0;
    voice.low2 = 0;
  }

  /** Renders `length` samples (at most a quantum) from absolute sample `start` into `outputs` at `at`. */
  private process(
    outputs: readonly Float32Array[],
    at: number,
    length: number,
    start: number,
  ): void {
    const [dryL, dryR, feedL, feedR] = outputs;
    const [carL, carR, sigL, sigR] = this.scratch;
    this.renderRumble(dryL, dryR, at, length, start);
    const rumbleSend = dbToGain(RUMBLE_SEND_DB);
    for (let i = at; i < at + length; i++) {
      feedL[i] = (dryL[i] ?? 0) * rumbleSend;
      feedR[i] = (dryR[i] ?? 0) * rumbleSend;
    }

    // Events, split where a block starts or an event does.
    const sr = this.sampleRate;
    let cars = false;
    let signals = false;
    carL.fill(0, 0, length);
    carR.fill(0, 0, length);
    sigL.fill(0, 0, length);
    sigR.fill(0, 0, length);
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const block = blockOf(now, sr);
      if (block !== this.carSchedule.block) {
        this.loadCars(block);
      }
      if (block !== this.signalSchedule.block) {
        this.loadSignals(block);
      }
      const cs = this.carSchedule;
      while (cs.next < cs.events.count && cs.sample(cs.next, sr) <= now) {
        this.startCar(cs.hash(cs.next), now - cs.sample(cs.next, sr));
        cs.next++;
      }
      const ss = this.signalSchedule;
      while (ss.next < ss.events.count && ss.sample(ss.next, sr) <= now) {
        this.startSignal(ss.hash(ss.next), now - ss.sample(ss.next, sr));
        ss.next++;
      }
      let end = Math.min(length, (block + 1) * sr - start);
      if (cs.next < cs.events.count) {
        end = Math.min(end, cs.sample(cs.next, sr) - start);
      }
      if (ss.next < ss.events.count) {
        end = Math.min(end, ss.sample(ss.next, sr) - start);
      }
      if (this.cars.active > 0) {
        this.renderCars(carL, carR, pos, end);
        cars = true;
      }
      for (const s of this.signals) {
        if (s.active) {
          this.renderSignal(s, sigL, sigR, pos, end);
          signals = true;
        }
      }
      pos = end;
    }

    // The cars, through their low-pass, while any sound or their filter rings on.
    if (cars || this.carLeft !== 0 || this.carRight !== 0) {
      const pole = this.carPole;
      const carSend = dbToGain(CAR_SEND_DB);
      let l = this.carLeft;
      let r = this.carRight;
      for (let i = 0; i < length; i++) {
        l = (carL[i] ?? 0) + pole * (l - (carL[i] ?? 0));
        r = (carR[i] ?? 0) + pole * (r - (carR[i] ?? 0));
        dryL[at + i] += l;
        dryR[at + i] += r;
        feedL[at + i] += l * carSend;
        feedR[at + i] += r * carSend;
      }
      // Settled to silence: stop running it.
      this.carLeft = Math.abs(l) < 1e-9 && !cars ? 0 : l;
      this.carRight = Math.abs(r) < 1e-9 && !cars ? 0 : r;
    }
    if (signals) {
      const signalSend = dbToGain(SIGNAL_SEND_DB);
      for (let i = 0; i < length; i++) {
        dryL[at + i] += sigL[i] ?? 0;
        dryR[at + i] += sigR[i] ?? 0;
        feedL[at + i] += (sigL[i] ?? 0) * signalSend;
        feedR[at + i] += (sigR[i] ?? 0) * signalSend;
      }
    }
    for (let i = at; i < at + length; i++) {
      dryL[i] = guard(dryL[i] ?? 0);
      dryR[i] = guard(dryR[i] ?? 0);
    }
  }

  /** The rumble, written into `left` and `right` at `at`. */
  private renderRumble(
    left: Float32Array,
    right: Float32Array,
    at: number,
    length: number,
    start: number,
  ): void {
    const sr = this.sampleRate;
    const end = start + length;
    // The day's share glides to the setting; a fresh start begins there.
    const glideStep = 1 - Math.exp(-length / (DAY_GLIDE * sr));
    const share = Number.isNaN(this.dayShare)
      ? this.day
      : this.dayShare + (this.day - this.dayShare) * glideStep;
    this.dayShare = share;
    const level = (n: number) =>
      dbToGain(RUMBLE_DB - DAY_DB * (1 - share) + SWELL_DB * this.swell.valueAt(n)) *
      rumbleShare(this.rumble);
    const gainTo = level(end);
    const gainFrom = Number.isNaN(this.rumbleGain) ? level(start) : this.rumbleGain;
    this.rumbleGain = gainTo;
    const cutoff =
      (NIGHT_CUTOFF + (DAY_CUTOFF - NIGHT_CUTOFF) * share) *
      CUTOFF_SWING ** this.cutoffDrift.valueAt(start + length / 2);
    const [la1 = 0, la2 = 0, la3 = 0] = svfCoefficients(this.lowpass, cutoff, RUMBLE_Q, sr);
    const [ha1 = 0, ha2 = 0, ha3 = 0, hk = 0] = this.highpass;
    const [ga1 = 0, ga2 = 0, ga3 = 0, gk = 0] = this.highpass2;
    const [ma1 = 0, ma2 = 0, ma3 = 0, mk = 0] = this.mid;
    const gainStep = (gainTo - gainFrom) / length;
    const white = this.white;
    const bp = this.brownPole;
    const bg = this.brownInput;
    const midGain = this.midGain * mk;
    const prefix = this.prefix;
    const st = this.states;
    for (let side = 0; side < 2; side++) {
      const out = side === 0 ? left : right;
      const o = side * STATES;
      let brown = st[o];
      let l1 = st[o + 1];
      let l2 = st[o + 2];
      let h1 = st[o + 3];
      let h2 = st[o + 4];
      let g1 = st[o + 5];
      let g2 = st[o + 8];
      let m1 = st[o + 6];
      let m2 = st[o + 7];
      let gain = gainFrom;
      // Each filter is `svfCoefficients`' tick written out.
      for (let i = 0; i < length; i++) {
        gain += gainStep;
        // One hash per sample: its high half for the left, its low half for the right.
        const hash = hashStep(prefix, start + i);
        const w = ((side === 0 ? hash >>> 16 : hash & 0xffff) * HALF_SCALE - 1) * white;
        brown = bp * brown + bg * w;
        // Brown: low-pass, then the two stages of the high-pass.
        let v3 = brown - l2;
        let v1 = la1 * l1 + la2 * v3;
        let v2 = l2 + la2 * l1 + la3 * v3;
        l1 = 2 * v1 - l1;
        l2 = 2 * v2 - l2;
        const low = v2;
        v3 = low - h2;
        v1 = ha1 * h1 + ha2 * v3;
        v2 = h2 + ha2 * h1 + ha3 * v3;
        h1 = 2 * v1 - h1;
        h2 = 2 * v2 - h2;
        const high = low - hk * v1 - v2;
        v3 = high - g2;
        v1 = ga1 * g1 + ga2 * v3;
        v2 = g2 + ga2 * g1 + ga3 * v3;
        g1 = 2 * v1 - g1;
        g2 = 2 * v2 - g2;
        const highest = high - gk * v1 - v2;
        // The mid band, from the same white.
        v3 = w - m2;
        v1 = ma1 * m1 + ma2 * v3;
        v2 = m2 + ma2 * m1 + ma3 * v3;
        m1 = 2 * v1 - m1;
        m2 = 2 * v2 - m2;
        out[at + i] = gain * (highest + midGain * v1);
      }
      st[o] = brown;
      st[o + 1] = l1;
      st[o + 2] = l2;
      st[o + 3] = h1;
      st[o + 4] = h2;
      st[o + 5] = g1;
      st[o + 8] = g2;
      st[o + 6] = m1;
      st[o + 7] = m2;
    }
  }

  /** The cars sounding, added into `left` and `right` from `from` to `to`. */
  private renderCars(left: Float32Array, right: Float32Array, from: number, to: number): void {
    const pool = this.cars;
    for (let v = pool.active - 1; v >= 0; v--) {
      const voice = pool.live[v];
      const noise = voice.noise;
      let n = voice.position;
      const stop = Math.min(to, from + (voice.length - n));
      let ic1 = voice.ic1;
      let ic2 = voice.ic2;
      for (let i = from; i < stop; i++) {
        if (n % CONTROL === 0) {
          voice.ic1 = ic1;
          voice.ic2 = ic2;
          this.carControl(voice, n);
        }
        const x = (hashStep(noise, n) * UINT32_SCALE * 2 - 1) * UNIFORM_TO_UNIT;
        const v3 = x - ic2;
        const v1 = voice.a1 * ic1 + voice.a2 * v3;
        const v2 = ic2 + voice.a2 * ic1 + voice.a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        const y = voice.k * v1;
        left[i] += voice.left * y;
        right[i] += voice.right * y;
        voice.left += voice.leftStep;
        voice.right += voice.rightStep;
        n++;
      }
      voice.ic1 = ic1;
      voice.ic2 = ic2;
      voice.position = n;
      if (n >= voice.length) {
        pool.release(v);
      }
    }
  }

  /** A far signal, added into `left` and `right` from `from` to `to`. */
  private renderSignal(
    voice: SignalVoice,
    left: Float32Array,
    right: Float32Array,
    from: number,
    to: number,
  ): void {
    const sr = this.sampleRate;
    const shape = voice.shape;
    let n = voice.position;
    const stop = Math.min(to, from + (voice.end - n));
    if (shape.siren) {
      // The phase, in cycles, is the integral of a frequency sweeping sinusoidally
      // between the two pitches, so it is a closed form of the time since it started.
      const middle = (SIREN_LOW + SIREN_HIGH) / 2;
      const depth = (SIREN_HIGH - SIREN_LOW) / 2;
      const w = (2 * Math.PI) / shape.period;
      const third = dbToGain(SIREN_THIRD_DB);
      const scale = 1 / (1 + third);
      for (let i = from; i < stop; i++, n++) {
        const t = n / sr;
        const phase = 2 * Math.PI * (middle * t - (depth / w) * Math.cos(w * t));
        const y =
          signalEnvelope(t, shape.length, SIREN_FADE, SIREN_FADE) *
          scale *
          (Math.sin(phase) + third * Math.sin(3 * phase));
        left[i] += voice.left * y;
        right[i] += voice.right * y;
      }
    } else {
      const pole = this.hornPole;
      const upper = shape.pitch * shape.ratio;
      let low1 = voice.low1;
      let low2 = voice.low2;
      for (let i = from; i < stop; i++, n++) {
        const t = n / sr;
        const x =
          0.5 *
          signalEnvelope(t, shape.length, HORN_ATTACK, HORN_RELEASE) *
          (hornWave(shape.pitch * t) + hornWave(upper * t));
        low1 = x + pole * (low1 - x);
        low2 = low1 + pole * (low2 - low1);
        left[i] += voice.left * low2;
        right[i] += voice.right * low2;
      }
      voice.low1 = low1;
      voice.low2 = low2;
    }
    voice.position = n;
    if (n >= voice.end) {
      voice.active = false;
    }
  }
}

interface CityOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readCityOptions(raw: unknown): CityOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
