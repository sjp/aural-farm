/**
 * Train Carriage's seeded parts: pure code with no Web Audio globals, run by
 * `train.worklet.ts` and checked in Node.
 *
 * The worklet makes, for one seed, a seat in the middle of a carriage:
 *
 * - **Rumble.** Decorrelated counter-hashed white noise per side (each
 *   sample's hash gives both sides, one in each half): brown noise
 *   high-passed at 45 Hz and low-passed at 160 Hz, the carriage's deep body,
 *   with a band of the white itself around 300–650 Hz under it, the roar of
 *   wheel on rail, louder and higher the faster the train goes.
 * - **Clacks.** The track's joints sit every 18.3 m, each a little off its
 *   place (±0.12 m) by the seed, from `periodic.ts`'s grid laid out in
 *   metres. The carriage's four axles, in two bogies, cross each one: a quick
 *   "da-dum" from the near bogie, and the same, quieter and duller, from the
 *   far one. Each crossing strikes a voice: a 2 ms burst of noise and its
 *   fading tail into four band-pass resonators, from a dull knock at 140 Hz
 *   to a metallic tick at 1.9 kHz.
 * - **Thumps.** On welded track, no joints: now and then a soft, dull thump
 *   instead, the low resonator alone.
 * - **Points.** Now and then a short, irregular rattle of brighter clacks as
 *   the train runs over points.
 * - **Sway.** Slow drifts lean the carriage: the rumble's low-pass and the
 *   balance between the sides move a little, and the level breathes by ±1 dB.
 *
 * The train's position is `s(t) = v · t + offset`, in metres. At steady
 * params `offset` is 0, so where the train is (and every clack) depends only
 * on absolute time. A change of speed glides `v` and moves `offset` so the
 * position carries on unbroken: no joint is skipped, struck twice or moved,
 * the rhythm just speeds up or slows down. The track crossfades between
 * jointed and welded inside the kernel, on the clacks and thumps' levels.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { blockOf, createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { createPeriodicEvents, PeriodicSchedule } from "../../audio/dsp/periodic";
import { svfCoefficients } from "../../audio/dsp/svf";
import { VoicePool } from "../../audio/dsp/voices";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import type { TrainPoints, TrainTrack } from "./train.meta";

export const TRAIN_PROCESSOR = "aural-train";
/** The worklet's output channels: left and right. */
export const TRAIN_CHANNELS = 2;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Random streams: each source of randomness its own. */
const NOISE_STREAM = 0;
const JOINT_STREAM = 1;
const HIT_STREAM = 2;
const THUMP_STREAM = 3;
const POINTS_STREAM = 4;
const SWAY_STREAM = 5;
const BREATH_STREAM = 6;

// ---------------------------------------------------------------------------
// Geometry and timing.

/** One rail's length, in metres: a joint at every multiple, give or take. */
export const RAIL_LENGTH = 18.3;
/** How far each joint may sit from its place, in metres either way. */
export const JOINT_JITTER = 0.12;
/**
 * The axles, in metres back from the carriage's front: two bogies of two
 * axles 2.6 m apart, their pivots 16.4 m apart. The first two are the near
 * bogie, under the seat's end of the carriage.
 */
export const AXLES = [2.0, 4.6, 18.4, 21.0] as const;
const NEAR_AXLES = 2;

/** Metres per second at `kmh` km/h. */
export const metresPerSecond = (kmh: number) => kmh / 3.6;

/** The time between joints at `kmh` km/h, in seconds: the clacks' period. */
export function jointPeriod(kmh: number): number {
  return RAIL_LENGTH / metresPerSecond(kmh);
}

/** Crossings of joints by axles: where each happens (the train's position, m), the joint and the axle. */
interface Crossings {
  readonly positions: Float64Array;
  readonly joints: Float64Array;
  readonly axles: Uint8Array;
  /** How many entries are filled. */
  count: number;
}

/** A crossing list holding at most `capacity` crossings. */
export function createCrossings(capacity: number): Crossings {
  return {
    positions: new Float64Array(capacity),
    joints: new Float64Array(capacity),
    axles: new Uint8Array(capacity),
    count: 0,
  };
}

/** Most joints one axle crosses in one call's stretch of track. */
const JOINTS_PER_AXLE = 4;

/**
 * The track's joints for one seed: joint k at `k · RAIL_LENGTH` give or take
 * `JOINT_JITTER`, the grid of a `PeriodicSchedule` laid out in metres rather
 * than seconds, so it depends only on the position along the track.
 */
export class Joints {
  private readonly schedule: PeriodicSchedule;
  private readonly found = createPeriodicEvents(JOINTS_PER_AXLE);

  constructor(seed: number) {
    this.schedule = new PeriodicSchedule(
      seed,
      JOINT_STREAM,
      RAIL_LENGTH,
      JOINT_JITTER / RAIL_LENGTH,
    );
  }

  /** Joint k's position along the track, in metres. */
  position(k: number): number {
    return this.schedule.timeOf(k);
  }

  /**
   * Fills `out` with every axle's crossings while the train's position runs
   * over [s0, s1), sorted by position, and returns their count. Crossings
   * beyond `out`'s capacity are dropped.
   */
  crossings(s0: number, s1: number, out: Crossings): number {
    out.count = 0;
    const capacity = out.positions.length;
    for (let a = 0; a < AXLES.length; a++) {
      const axle = AXLES[a];
      const n = this.schedule.eventsIn(s0 - axle, s1 - axle, this.found);
      for (let j = 0; j < n && out.count < capacity; j++) {
        const position = this.found.times[j] + axle;
        // Insertion sort: a handful at most.
        let i = out.count;
        while (i > 0 && out.positions[i - 1] > position) {
          out.positions[i] = out.positions[i - 1];
          out.joints[i] = out.joints[i - 1];
          out.axles[i] = out.axles[i - 1];
          i--;
        }
        out.positions[i] = position;
        out.joints[i] = this.found.indices[j];
        out.axles[i] = a;
        out.count++;
      }
    }
    return out.count;
  }
}

/**
 * The absolute sample at which the train reaches `position`, moving at `v`
 * m/s from `offset` (its position at time 0 on this course): the first
 * sample at or after the moment, kept within [`from`, `to`).
 */
export function crossingSample(
  position: number,
  v: number,
  offset: number,
  sampleRate: number,
  from: number,
  to: number,
): number {
  const n = Math.ceil(((position - offset) / v) * sampleRate);
  return Math.min(to - 1, Math.max(from, n));
}

// ---------------------------------------------------------------------------
// Params.

/** The speed range, in km/h, and the speed the levels are set at. */
const SLOWEST = 40;
const FASTEST = 160;
const CRUISE = 90;
/** Where `kmh` sits from 40 to 160 km/h, 0–1. */
const speedShare = (kmh: number) => clamp01((kmh - SLOWEST) / (FASTEST - SLOWEST));

/** The track as the worklet takes it: 0 jointed, 1 welded. */
export const TRACK_VALUES: Readonly<Record<TrainTrack, number>> = { jointed: 0, welded: 1 };

/** Rattles over points per second: Rarely about one in 4 minutes, Sometimes one in 90 s. */
export const POINTS_RATES: Readonly<Record<TrainPoints, number>> = {
  off: 0,
  rarely: 1 / 240,
  sometimes: 1 / 90,
};

/** Soft thumps per second on welded track. */
export const THUMP_RATE = 0.3;

/** A speed change's glide, in seconds (time constant). */
const SPEED_GLIDE = 2;
/** The crossfade between jointed and welded track, in seconds. */
const TRACK_FADE = 1.5;

// ---------------------------------------------------------------------------
// The rumble.

/** Unit-variance white noise at 48 kHz from 16 hash bits; scaled by rate so its density doesn't change. */
const HALF_SCALE = 2 / 65535;
const UNIFORM_TO_UNIT = Math.sqrt(3);
const REFERENCE_RATE = 48000;

/**
 * Brown noise: white through a one-pole at this corner, in Hz. A one-pole
 * high-pass at the same corner, then a two-pole one, keep its flat stretch
 * below the corner (18 dB per octave) well under 25 Hz.
 */
const BROWN_CORNER = 40;
const HIGHPASS = 50;
const HIGHPASS_Q = Math.SQRT1_2;
const LOWPASS = 160;
const LOWPASS_Q = Math.SQRT1_2;
/** The sway moves the low-pass this far, as a fraction either way. */
const LOWPASS_SWAY = 0.12;
/** The roar's band: its centre from 40 to 160 km/h, in Hz, and its Q. */
const ROAR_LOW = 300;
const ROAR_HIGH = 650;
const ROAR_Q = 0.7;
/** The roar against the body at 90 km/h, in dB, and how much it rises from 40 to 160 km/h. */
const ROAR_DB = -6;
const ROAR_RISE_DB = 8;
/**
 * The gains that bring the body (from the brown noise) and the roar band
 * (from the white) to unit RMS: measured, since both are fixed shapes, and
 * the same at any rate, since the white noise's density is.
 */
const BODY_SCALE = 43.4;
const ROAR_SCALE = 4.96;
/** The rumble's level at the defaults, in dBFS RMS per channel. */
const RUMBLE_DB = -25;
/** Welded track's rumble against jointed, in dB: the smoothness lets it through. */
export const WELDED_RUMBLE_DB = 2;
/** The sway's pan, either way, and the breath's level, in dB either way. */
const SWAY_PAN = 0.08;
const BREATH_DB = 1;
const SWAY_RATE = 0.18;
const SWAY_OCTAVES = 2;
const BREATH_RATE = 0.05;
const BREATH_OCTAVES = 1;

/** The roar band's centre at `kmh`, in Hz. */
export function roarCentre(kmh: number): number {
  return ROAR_LOW + (ROAR_HIGH - ROAR_LOW) * speedShare(kmh);
}

/** The roar band against the body at `kmh`, in dB. */
export function roarDb(kmh: number): number {
  return ROAR_DB + (ROAR_RISE_DB * (Math.min(FASTEST, Math.max(SLOWEST, kmh)) - CRUISE)) / 120;
}

// ---------------------------------------------------------------------------
// The clack voice.

/** The resonators: centre (Hz), Q, and the tail's decay to −40 dB (s). */
const BANDS = [
  { centre: 140, q: 6, decay: 0.12 },
  { centre: 310, q: 9, decay: 0.09 },
  { centre: 760, q: 12, decay: 0.06 },
  { centre: 1900, q: 10, decay: 0.04 },
] as const;
const BRIGHT_BAND = 3;
/** The burst of noise that strikes the resonators, in seconds, and its tail's level. */
const BURST = 0.002;
const TAIL = 0.35;
/** A voice's length, in seconds: its longest tail is more than 60 dB down by then. */
export const VOICE_LENGTH = 0.25;
/** The voices: enough for the busiest rattle over the fastest clacks. */
const VOICES = 10;
/** The low-pass over the near bogie's clacks and the far bogie's, in Hz. */
const NEAR_LOWPASS = 5000;
const FAR_LOWPASS = 1800;
/** The far bogie against the near, in dB, and the clacks' pans. */
const FAR_DB = -7;
const NEAR_PAN = 0.1;
const FAR_PAN = -0.1;
/** How far each hit and each of its resonators varies, in dB either way. */
const HIT_SWING_DB = 1.5;
const BAND_SWING_DB = 2;
/** The clacks' rise from 40 to 160 km/h, in dB. */
const CLACK_RISE_DB = 4;
/**
 * A clack's gain at Clacks 100 and 90 km/h, before its own variation: set so
 * a near clack at the defaults peaks about 10 dB over the rumble's RMS, and the loudest
 * clacks at 160 km/h and Clacks 100 stay under −3 dBFS with the rumble under them.
 */
const CLACK_GAIN = 0.8;
/** The thump against a clack, in dB. */
const THUMP_DB = -10;
/** A rattle's clacks against a joint's, in dB, and their bright resonator's lift. */
const POINTS_DB = -6;
const POINTS_BRIGHT_DB = 3;
/** A rattle's clacks: how many, and the gap between each, in seconds. */
const RATTLE_FEWEST = 6;
const RATTLE_MOST = 14;
const RATTLE_GAP = [0.03, 0.18] as const;
/** The longest rattle, in seconds. */
const RATTLE_LONGEST = RATTLE_MOST * RATTLE_GAP[1];

/** What struck a voice, for its bus's level: a joint, a thump on welded track, or points. */
const JOINT_BUS = 0;
const THUMP_BUS = 1;
const POINTS_BUS = 2;

/** The clacks' level at Clacks `clacks` (0–100) and `kmh` km/h, as a gain. */
export function clackLevel(clacks: number, kmh: number): number {
  const rise = (CLACK_RISE_DB * (Math.min(FASTEST, Math.max(SLOWEST, kmh)) - CRUISE)) / 120;
  return CLACK_GAIN * clamp01(clacks / 100) * dbToGain(rise);
}

/** The sway's balance at `balance` (−1–1), each side against the centre: equal-power. */
const balanceLeft = (balance: number) => panLeft(balance) * Math.SQRT2;
const balanceRight = (balance: number) => panRight(balance) * Math.SQRT2;

/** A hash's sub-value `i` as a float in [−1, 1). */
const signed = (h: number, i: number) => hashStep(h, i) * UINT32_SCALE * 2 - 1;

class Voice {
  /** The level now, for stealing: the low resonator's tail times its gain. */
  level = 0;
  /** Its bus, its samples since the strike, and when it starts in the quantum being rendered. */
  bus = JOINT_BUS;
  age = 0;
  /** Each band's gain, tail level and resonator state. */
  readonly gains = new Float64Array(4);
  readonly tails = new Float64Array(4);
  readonly ic1 = new Float64Array(4);
  readonly ic2 = new Float64Array(4);
  /** The low-pass's pole and state, and the pan. */
  pole = 0;
  lp = 0;
  left = 0;
  right = 0;

  strike(bus: number, gain: number, bandGains: ArrayLike<number>, pole: number, pan: number): void {
    this.bus = bus;
    this.age = 0;
    for (let b = 0; b < 4; b++) {
      this.gains[b] = gain * bandGains[b];
      this.tails[b] = TAIL;
      this.ic1[b] = 0;
      this.ic2[b] = 0;
    }
    this.pole = pole;
    this.lp = 0;
    this.left = panLeft(pan);
    this.right = panRight(pan);
    this.level = gain;
  }
}

/** A strike due in the quantum: when, on which bus, and its hash and level. */
interface Strikes {
  readonly samples: Float64Array;
  readonly buses: Uint8Array;
  readonly hashes: Uint32Array;
  /** For joints, the axle; for points and thumps, unused. */
  readonly axles: Uint8Array;
  readonly levels: Float64Array;
  count: number;
}

function createStrikes(capacity: number): Strikes {
  return {
    samples: new Float64Array(capacity),
    buses: new Uint8Array(capacity),
    hashes: new Uint32Array(capacity),
    axles: new Uint8Array(capacity),
    levels: new Float64Array(capacity),
    count: 0,
  };
}

/** Most strikes waiting: a fresh start's look back can hold several rattles' clacks and thumps. */
const PENDING = 96;
/** Most strikes in one quantum. */
const STRIKES = 16;
/** How far back a fresh render looks for a rattle still going, in blocks. */
const LOOK_BACK = Math.ceil(RATTLE_LONGEST + VOICE_LENGTH) + 1;
/**
 * A fresh render first runs the clacks alone this long, unheard, so a clack
 * struck just before it rings on as it would have. The rumble's filters
 * settle within a tenth of a second by themselves.
 */
const PRE_ROLL = VOICE_LENGTH;
const QUANTUM = 128;
/** Most thumps or rattles in one block: far above their rates. */
const BLOCK_CAPACITY = 8;

// ---------------------------------------------------------------------------
// The kernel.

/**
 * The Train Carriage worklet's output for one seed, from absolute samples:
 * the same whether rendered in one go or in chunks, at steady params.
 */
export class TrainKernel {
  private readonly sampleRate: number;
  private readonly seed: number;
  private readonly prefix: number;
  private readonly hitPrefix: number;
  private readonly joints: Joints;
  private readonly crossings = createCrossings(STRIKES);
  private readonly blockEvents = createEventBlock(BLOCK_CAPACITY);
  private readonly pending = createStrikes(PENDING);
  private readonly strikes = createStrikes(STRIKES);
  private readonly pool: VoicePool<Voice>;
  private readonly bandCoefficients: Float64Array[];
  private readonly bandDecays: Float64Array;
  private readonly burst: number;
  private readonly voiceLength: number;
  private readonly nearPole: number;
  private readonly farPole: number;
  private readonly bandGains = new Float64Array(4);
  /** The white noise each quantum's voices are struck with. */
  private white = new Float64Array(QUANTUM);
  private readonly scratchLeft = new Float32Array(QUANTUM);
  private readonly scratchRight = new Float32Array(QUANTUM);
  /** The rumble: brown one-pole, then its filters, and their states, left's then right's. */
  private readonly brownPole: number;
  private readonly brownGain: number;
  private readonly noiseScale: number;
  private readonly highpass: Float64Array;
  private readonly lowpass = new Float64Array(4);
  private readonly roar = new Float64Array(4);
  private readonly states = new Float64Array(16);
  private readonly sway: DriftGenerator;
  private readonly breath: DriftGenerator;
  /** The params `set` gave. */
  private targetKmh = CRUISE;
  private trackTarget = 0;
  private clacks = 55;
  private pointsRate = 0;
  /** The speed and course now: position = v · t + offset. */
  private v = metresPerSecond(CRUISE);
  private offset = 0;
  /** How far toward welded track, 0–1. */
  private track = 0;
  /** The filters' settings now. */
  private cutoff = Number.NaN;
  private roarKmh = Number.NaN;
  /** Levels at the end of the last quantum, to ramp from. */
  private body = Number.NaN;
  private roarGain = Number.NaN;
  private balance = Number.NaN;
  private jointBus = Number.NaN;
  private thumpBus = Number.NaN;
  /** The last block whose thumps and rattles are pending. */
  private block = Number.NaN;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.seed = seed;
    this.prefix = hashStep(hashStep(HASH_START, seed), NOISE_STREAM);
    this.hitPrefix = hashStep(hashStep(HASH_START, seed), HIT_STREAM);
    this.joints = new Joints(seed);
    this.pool = new VoicePool(VOICES, () => new Voice());
    this.bandCoefficients = BANDS.map((b) =>
      svfCoefficients(new Float64Array(4), b.centre, b.q, sampleRate),
    );
    // A tail falls 40 dB over its decay.
    this.bandDecays = Float64Array.from(BANDS, (b) => 10 ** (-2 / (b.decay * sampleRate)));
    this.burst = Math.round(BURST * sampleRate);
    this.voiceLength = Math.round(VOICE_LENGTH * sampleRate);
    this.nearPole = Math.exp((-2 * Math.PI * NEAR_LOWPASS) / sampleRate);
    this.farPole = Math.exp((-2 * Math.PI * FAR_LOWPASS) / sampleRate);
    this.noiseScale = UNIFORM_TO_UNIT * Math.sqrt(sampleRate / REFERENCE_RATE);
    this.brownPole = Math.exp((-2 * Math.PI * BROWN_CORNER) / sampleRate);
    this.brownGain = 1 - this.brownPole;
    this.highpass = svfCoefficients(new Float64Array(4), HIGHPASS, HIGHPASS_Q, sampleRate);
    this.sway = new DriftGenerator(seed, SWAY_STREAM, SWAY_RATE, SWAY_OCTAVES, sampleRate);
    this.breath = new DriftGenerator(seed, BREATH_STREAM, BREATH_RATE, BREATH_OCTAVES, sampleRate);
  }

  /**
   * Sets the params for the next render: Speed (km/h), the track (0 jointed,
   * 1 welded), Clacks (0–100) and rattles over points per second.
   */
  set(kmh: number, track: number, clacks: number, pointsRate: number): void {
    this.targetKmh = Math.min(FASTEST, Math.max(SLOWEST, kmh));
    this.trackTarget = clamp01(track);
    this.clacks = clacks;
    this.pointsRate = pointsRate;
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    if (start !== this.expected) {
      this.restart(start);
    }
    this.step(left, right, start);
  }

  /** A fresh start: the steady state at `start`, with every voice run in. */
  private restart(start: number): void {
    const sr = this.sampleRate;
    this.v = metresPerSecond(this.targetKmh);
    this.offset = 0;
    this.track = this.trackTarget;
    this.cutoff = Number.NaN;
    this.roarKmh = Number.NaN;
    this.body = Number.NaN;
    this.roarGain = Number.NaN;
    this.balance = Number.NaN;
    this.jointBus = Number.NaN;
    this.thumpBus = Number.NaN;
    this.states.fill(0);
    this.pool.active = 0;
    this.pending.count = 0;
    const preRoll = Math.ceil((PRE_ROLL * sr) / QUANTUM) * QUANTUM;
    const from = start - preRoll;
    this.block = blockOf(from, sr) - LOOK_BACK;
    for (let n = from; n < start; n += QUANTUM) {
      this.step(this.scratchLeft, this.scratchRight, n, true);
    }
  }

  /** Renders from absolute sample `start`; `unheard`, the clacks alone, for a fresh start's run-in. */
  private step(left: Float32Array, right: Float32Array, start: number, unheard = false): void {
    const length = left.length;
    const sr = this.sampleRate;
    const end = start + length;
    this.expected = end;
    if (this.white.length < length) {
      this.white = new Float64Array(length);
    }

    // The speed glides, and the course moves so the position carries on.
    const target = metresPerSecond(this.targetKmh);
    if (this.v !== target) {
      const position = (this.v * start) / sr + this.offset;
      const v = this.v + (target - this.v) * (1 - Math.exp(-length / (SPEED_GLIDE * sr)));
      this.v = Math.abs(v - target) < 1e-6 * target ? target : v;
      this.offset = position - (this.v * start) / sr;
    }
    const kmh = this.v * 3.6;
    // The track crossfades at a steady pace.
    const trackStep = length / (TRACK_FADE * sr);
    const track = this.track;
    this.track =
      this.trackTarget > track
        ? Math.min(this.trackTarget, track + trackStep)
        : Math.max(this.trackTarget, track - trackStep);

    this.schedule(start, end);
    if (unheard) {
      this.noise(start, length);
      left.fill(0);
      right.fill(0);
    } else {
      this.rumble(left, right, start, kmh);
    }
    this.voices(left, right, track);
  }

  /** Gathers the strikes due in [start, end), in order, and strikes a voice for each. */
  private schedule(start: number, end: number): void {
    const sr = this.sampleRate;
    const strikes = this.strikes;
    strikes.count = 0;
    const kmh = this.v * 3.6;
    const level = clackLevel(this.clacks, kmh);

    // Joints, unless the track is all welded.
    if (this.track < 1 || this.trackTarget < 1) {
      const s0 = (this.v * start) / sr + this.offset;
      const s1 = (this.v * end) / sr + this.offset;
      const n = this.joints.crossings(s0, s1, this.crossings);
      for (let i = 0; i < n; i++) {
        const sample = crossingSample(
          this.crossings.positions[i],
          this.v,
          this.offset,
          sr,
          start,
          end,
        );
        const axle = this.crossings.axles[i];
        const hash = hashStep(hashStep(this.hitPrefix, this.crossings.joints[i]), axle);
        this.addStrike(sample, JOINT_BUS, hash, axle, level);
      }
    }

    // Thumps and rattles, loaded a block at a time, their params latched as each block loads.
    const last = blockOf(end - 1, sr);
    for (let b = this.block + 1; b <= last; b++) {
      this.load(b, level);
    }
    this.block = last;
    const pending = this.pending;
    for (let i = pending.count - 1; i >= 0; i--) {
      const sample = pending.samples[i];
      if (sample >= end) {
        continue;
      }
      if (sample >= start) {
        this.addStrike(sample, pending.buses[i], pending.hashes[i], 0, pending.levels[i]);
      }
      // Done with: the last pending strike takes its place.
      const j = --pending.count;
      pending.samples[i] = pending.samples[j];
      pending.buses[i] = pending.buses[j];
      pending.hashes[i] = pending.hashes[j];
      pending.levels[i] = pending.levels[j];
    }

    for (let i = 0; i < strikes.count; i++) {
      this.strike(i, start);
    }
  }

  /** Adds a strike to the quantum's, in order of sample then bus then hash, so the order never depends on how it was found. */
  private addStrike(sample: number, bus: number, hash: number, axle: number, level: number): void {
    const s = this.strikes;
    if (s.count >= s.samples.length || !(level > 0)) {
      return;
    }
    let i = s.count;
    while (
      i > 0 &&
      (s.samples[i - 1] > sample ||
        (s.samples[i - 1] === sample &&
          (s.buses[i - 1] > bus || (s.buses[i - 1] === bus && s.hashes[i - 1] > hash))))
    ) {
      s.samples[i] = s.samples[i - 1];
      s.buses[i] = s.buses[i - 1];
      s.hashes[i] = s.hashes[i - 1];
      s.axles[i] = s.axles[i - 1];
      s.levels[i] = s.levels[i - 1];
      i--;
    }
    s.samples[i] = sample;
    s.buses[i] = bus;
    s.hashes[i] = hash;
    s.axles[i] = axle;
    s.levels[i] = level;
    s.count++;
  }

  /** Adds block `b`'s thumps and rattles to the pending strikes, at clack level `level`. */
  private load(b: number, level: number): void {
    const sr = this.sampleRate;
    const events = this.blockEvents;
    if (this.track > 0 || this.trackTarget > 0) {
      const n = eventsInBlock(this.seed, THUMP_STREAM, b, THUMP_RATE, events);
      for (let i = 0; i < n; i++) {
        const hash = eventHash(this.seed, THUMP_STREAM, b, i);
        this.addPending(Math.ceil((b + events.offsets[i]) * sr), THUMP_BUS, hash, level);
      }
    }
    const n = eventsInBlock(this.seed, POINTS_STREAM, b, this.pointsRate, events);
    for (let i = 0; i < n; i++) {
      const hash = eventHash(this.seed, POINTS_STREAM, b, i);
      const count =
        RATTLE_FEWEST +
        Math.floor(hashStep(hash, 0) * UINT32_SCALE * (RATTLE_MOST - RATTLE_FEWEST + 1));
      let time = b + events.offsets[i];
      for (let c = 0; c < count; c++) {
        this.addPending(Math.ceil(time * sr), POINTS_BUS, hashStep(hash, c + 1), level);
        const u = hashStep(hash, 100 + c) * UINT32_SCALE;
        time += RATTLE_GAP[0] + (RATTLE_GAP[1] - RATTLE_GAP[0]) * u;
      }
    }
  }

  /** Adds a strike to the pending ones, unless they are full. */
  private addPending(sample: number, bus: number, hash: number, level: number): void {
    const pending = this.pending;
    if (pending.count < pending.samples.length) {
      const k = pending.count++;
      pending.samples[k] = sample;
      pending.buses[k] = bus;
      pending.hashes[k] = hash;
      pending.levels[k] = level;
    }
  }

  /** Strikes a voice for strike `i` of the quantum starting at `start`. */
  private strike(i: number, start: number): void {
    const s = this.strikes;
    const bus = s.buses[i];
    const hash = s.hashes[i];
    const bands = this.bandGains;
    for (let b = 0; b < 4; b++) {
      bands[b] = dbToGain(BAND_SWING_DB * signed(hash, b + 1));
    }
    let gain = s.levels[i] * dbToGain(HIT_SWING_DB * signed(hash, 0));
    let pole = this.nearPole;
    let pan = NEAR_PAN;
    if (bus === JOINT_BUS) {
      if (s.axles[i] >= NEAR_AXLES) {
        gain *= dbToGain(FAR_DB);
        pole = this.farPole;
        pan = FAR_PAN;
      }
    } else if (bus === THUMP_BUS) {
      gain *= dbToGain(THUMP_DB);
      bands[1] = 0;
      bands[2] = 0;
      bands[3] = 0;
      pan = 0.1 * signed(hash, 5);
    } else {
      gain *= dbToGain(POINTS_DB);
      bands[BRIGHT_BAND] *= dbToGain(POINTS_BRIGHT_DB);
      pan = 0.1 * signed(hash, 5);
    }
    const voice = this.pool.allocate();
    voice.strike(bus, gain, bands, pole, pan);
    // Its age at the quantum's start: negative until it is struck.
    voice.age = start - s.samples[i];
  }

  /** Leaves the voices' noise in `white`, as `rumble` does, without the rumble. */
  private noise(start: number, length: number): void {
    const white = this.white;
    const prefix = this.prefix;
    const scale = this.noiseScale;
    for (let i = 0; i < length; i++) {
      const hash = hashStep(prefix, start + i);
      const wl = (hash >>> 16) * HALF_SCALE - 1;
      const wr = (hash & 0xffff) * HALF_SCALE - 1;
      white[i] = (wl + wr) * Math.SQRT1_2 * scale;
    }
  }

  /** Writes the rumble into `left` and `right`, and leaves the voices' noise in `white`. */
  private rumble(left: Float32Array, right: Float32Array, start: number, kmh: number): void {
    const length = left.length;
    const sr = this.sampleRate;
    const end = start + length;

    const sway = this.sway.valueAt(end);
    const cutoff = LOWPASS * (1 + LOWPASS_SWAY * sway);
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      svfCoefficients(this.lowpass, cutoff, LOWPASS_Q, sr);
    }
    if (kmh !== this.roarKmh) {
      this.roarKmh = kmh;
      svfCoefficients(this.roar, roarCentre(kmh), ROAR_Q, sr);
    }

    // Levels ramp across the quantum from where the last one left them.
    const bodyTo =
      dbToGain(RUMBLE_DB + WELDED_RUMBLE_DB * this.track + BREATH_DB * this.breath.valueAt(end)) *
      BODY_SCALE *
      this.noiseScale;
    const bodyFrom = Number.isNaN(this.body) ? bodyTo : this.body;
    this.body = bodyTo;
    const roarTo = (dbToGain(roarDb(kmh)) * ROAR_SCALE) / BODY_SCALE;
    const roarFrom = Number.isNaN(this.roarGain) ? roarTo : this.roarGain;
    this.roarGain = roarTo;
    const balanceTo = sway * SWAY_PAN;
    const balanceFrom = Number.isNaN(this.balance) ? balanceTo : this.balance;
    this.balance = balanceTo;
    const bodyStep = (bodyTo - bodyFrom) / length;
    const roarStep = (roarTo - roarFrom) / length;
    // Equal-power balance against the centre, ramped too.
    const leftFrom = balanceLeft(balanceFrom);
    const rightFrom = balanceRight(balanceFrom);
    const leftStep = (balanceLeft(balanceTo) - leftFrom) / length;
    const rightStep = (balanceRight(balanceTo) - rightFrom) / length;

    const prefix = this.prefix;
    const p = this.brownPole;
    const g = this.brownGain;
    const [ha1, ha2, ha3, hk] = this.highpass;
    const [la1, la2, la3] = this.lowpass;
    const [ra1, ra2, ra3, rk] = this.roar;
    const st = this.states;
    let bl = st[0];
    let hl1 = st[1];
    let hl2 = st[2];
    let ll1 = st[3];
    let ll2 = st[4];
    let rl1 = st[5];
    let rl2 = st[6];
    let br = st[7];
    let dl = st[14];
    let dr = st[15];
    let hr1 = st[8];
    let hr2 = st[9];
    let lr1 = st[10];
    let lr2 = st[11];
    let rr1 = st[12];
    let rr2 = st[13];
    const white = this.white;
    const scale = this.noiseScale;
    for (let i = 0; i < length; i++) {
      const k = i + 1;
      const hash = hashStep(prefix, start + i);
      const wl = (hash >>> 16) * HALF_SCALE - 1;
      const wr = (hash & 0xffff) * HALF_SCALE - 1;
      white[i] = (wl + wr) * Math.SQRT1_2 * scale;
      const body = bodyFrom + bodyStep * k;
      const roar = roarFrom + roarStep * k;
      const toLeft = leftFrom + leftStep * k;
      const toRight = rightFrom + rightStep * k;

      // Left: brown, high-pass, low-pass; the roar band from the white.
      bl = p * bl + g * wl;
      dl = p * dl + g * bl;
      let x = bl - dl;
      let v3 = x - hl2;
      let v1 = ha1 * hl1 + ha2 * v3;
      let v2 = hl2 + ha2 * hl1 + ha3 * v3;
      hl1 = 2 * v1 - hl1;
      hl2 = 2 * v2 - hl2;
      x -= hk * v1 + v2;
      v3 = x - ll2;
      v1 = la1 * ll1 + la2 * v3;
      v2 = ll2 + la2 * ll1 + la3 * v3;
      ll1 = 2 * v1 - ll1;
      ll2 = 2 * v2 - ll2;
      x = v2;
      v3 = wl - rl2;
      v1 = ra1 * rl1 + ra2 * v3;
      v2 = rl2 + ra2 * rl1 + ra3 * v3;
      rl1 = 2 * v1 - rl1;
      rl2 = 2 * v2 - rl2;
      left[i] = body * (x + roar * rk * v1) * toLeft;

      // Right: the same.
      br = p * br + g * wr;
      dr = p * dr + g * br;
      x = br - dr;
      v3 = x - hr2;
      v1 = ha1 * hr1 + ha2 * v3;
      v2 = hr2 + ha2 * hr1 + ha3 * v3;
      hr1 = 2 * v1 - hr1;
      hr2 = 2 * v2 - hr2;
      x -= hk * v1 + v2;
      v3 = x - lr2;
      v1 = la1 * lr1 + la2 * v3;
      v2 = lr2 + la2 * lr1 + la3 * v3;
      lr1 = 2 * v1 - lr1;
      lr2 = 2 * v2 - lr2;
      x = v2;
      v3 = wr - rr2;
      v1 = ra1 * rr1 + ra2 * v3;
      v2 = rr2 + ra2 * rr1 + ra3 * v3;
      rr1 = 2 * v1 - rr1;
      rr2 = 2 * v2 - rr2;
      right[i] = body * (x + roar * rk * v1) * toRight;
    }
    st[0] = bl;
    st[1] = hl1;
    st[2] = hl2;
    st[3] = ll1;
    st[4] = ll2;
    st[5] = rl1;
    st[6] = rl2;
    st[7] = br;
    st[14] = dl;
    st[15] = dr;
    st[8] = hr1;
    st[9] = hr2;
    st[10] = lr1;
    st[11] = lr2;
    st[12] = rr1;
    st[13] = rr2;
  }

  /** Adds every sounding voice into `left` and `right`, each on its bus's level. */
  private voices(left: Float32Array, right: Float32Array, track: number): void {
    const length = left.length;
    const pool = this.pool;
    if (pool.active === 0) {
      this.jointBus = Number.NaN;
      this.thumpBus = Number.NaN;
      return;
    }
    // The track's crossfade, equal-power, ramped across the quantum.
    const jointTo = Math.cos((this.track * Math.PI) / 2);
    const thumpTo = Math.sin((this.track * Math.PI) / 2);
    const jointFrom = Number.isNaN(this.jointBus) ? Math.cos((track * Math.PI) / 2) : this.jointBus;
    const thumpFrom = Number.isNaN(this.thumpBus) ? Math.sin((track * Math.PI) / 2) : this.thumpBus;
    this.jointBus = jointTo;
    this.thumpBus = thumpTo;
    const balance = Number.isNaN(this.balance) ? 0 : this.balance;
    const toLeft = balanceLeft(balance);
    const toRight = balanceRight(balance);

    const white = this.white;
    const burst = this.burst;
    const decays = this.bandDecays;
    const [d0, d1, d2, d3] = decays;
    const [c0, c1, c2, c3] = this.bandCoefficients;
    for (let v = pool.active - 1; v >= 0; v--) {
      const voice = pool.live[v];
      let from = 1;
      let to = 1;
      if (voice.bus === JOINT_BUS) {
        from = jointFrom;
        to = jointTo;
      } else if (voice.bus === THUMP_BUS) {
        from = thumpFrom;
        to = thumpTo;
      }
      const busStep = (to - from) / length;
      const g = voice.gains;
      const tails = voice.tails;
      const ic1 = voice.ic1;
      const ic2 = voice.ic2;
      let t0 = tails[0];
      let t1 = tails[1];
      let t2 = tails[2];
      let t3 = tails[3];
      let a1 = ic1[0];
      let a2 = ic2[0];
      let b1 = ic1[1];
      let b2 = ic2[1];
      let e1 = ic1[2];
      let e2 = ic2[2];
      let f1 = ic1[3];
      let f2 = ic2[3];
      let lp = voice.lp;
      const pole = voice.pole;
      const lpGain = 1 - pole;
      const vl = voice.left * toLeft;
      const vr = voice.right * toRight;
      let age = voice.age;
      const first = Math.max(0, -age);
      age += first;
      for (let i = first; i < length; i++, age++) {
        const w = white[i];
        let x0: number;
        let x1: number;
        let x2: number;
        let x3: number;
        if (age < burst) {
          x0 = w;
          x1 = w;
          x2 = w;
          x3 = w;
        } else {
          x0 = w * t0;
          x1 = w * t1;
          x2 = w * t2;
          x3 = w * t3;
          t0 *= d0;
          t1 *= d1;
          t2 *= d2;
          t3 *= d3;
        }
        // Four band-passes, `svfCoefficients`' tick written out.
        let v3 = x0 - a2;
        let v1 = c0[0] * a1 + c0[1] * v3;
        let v2 = a2 + c0[1] * a1 + c0[2] * v3;
        a1 = 2 * v1 - a1;
        a2 = 2 * v2 - a2;
        let y = g[0] * c0[3] * v1;
        v3 = x1 - b2;
        v1 = c1[0] * b1 + c1[1] * v3;
        v2 = b2 + c1[1] * b1 + c1[2] * v3;
        b1 = 2 * v1 - b1;
        b2 = 2 * v2 - b2;
        y += g[1] * c1[3] * v1;
        v3 = x2 - e2;
        v1 = c2[0] * e1 + c2[1] * v3;
        v2 = e2 + c2[1] * e1 + c2[2] * v3;
        e1 = 2 * v1 - e1;
        e2 = 2 * v2 - e2;
        y += g[2] * c2[3] * v1;
        v3 = x3 - f2;
        v1 = c3[0] * f1 + c3[1] * v3;
        v2 = f2 + c3[1] * f1 + c3[2] * v3;
        f1 = 2 * v1 - f1;
        f2 = 2 * v2 - f2;
        y += g[3] * c3[3] * v1;
        lp += lpGain * (y - lp);
        const out = lp * (from + busStep * (i + 1));
        left[i] += out * vl;
        right[i] += out * vr;
      }
      voice.age = age;
      tails[0] = t0;
      tails[1] = t1;
      tails[2] = t2;
      tails[3] = t3;
      ic1[0] = a1;
      ic2[0] = a2;
      ic1[1] = b1;
      ic2[1] = b2;
      ic1[2] = e1;
      ic2[2] = e2;
      ic1[3] = f1;
      ic2[3] = f2;
      voice.lp = lp;
      voice.level = Math.abs(g[0]) * t0 + Math.abs(g[3]) * t3;
      if (age >= this.voiceLength) {
        pool.release(v);
      }
    }
  }
}

interface TrainOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readTrainOptions(raw: unknown): TrainOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
