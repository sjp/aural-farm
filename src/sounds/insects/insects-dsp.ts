/**
 * Night Insects' crickets, katydid-like rasps and far-off chorus, and the
 * param mappings the rest of the sound uses: pure code with no Web Audio
 * globals, run by `insects.worklet.ts` and checked in Node.
 *
 * **Crickets.** Each individual (up to `CRICKET_SLOTS`, hashed from the seed
 * and its index, so adding one leaves the others alone) has its own pitch
 * (3.8–5.2 kHz), pace (a rate factor of 0.9–1.1), chirp (3–5 pulses of
 * 8–15 ms), distance and place in the stereo field. Its chirps come from a
 * `PeriodicSchedule` on absolute time, every `60 / (chirpsPerMinute × factor)`
 * seconds ±6 %, so the individuals drift in and out of step; the pulses
 * inside a chirp come at `pulseRate`. Both follow the warmth by Dolbear's law.
 *
 * - **A pulse** is a pure sine (any harmonic would sit above 8 kHz) gliding
 *   down 1 % across a raised-cosine envelope, so its edges are soft. It is
 *   worked out from the time since the pulse began, so a chirp sounds the same
 *   however it is rendered and needs no state but its start.
 * - **Latching.** Everything about a chirp (its pulse rate, level, softening
 *   and place) is fixed as it starts, so a change applies from the next chirp.
 *   A warmth change moves the schedule from the next chirp on.
 * - **Distance.** Each individual sits 0.2–1.0 away (−4 to −22 dB); the
 *   Distance param pushes them all further. The air's softening, a one-pole
 *   low-pass from 9 kHz near to 4.5 kHz far, only scales a pure sine, so it is
 *   applied as that gain.
 * - **Bouts.** In each 8 s block an individual sings with probability 0.75,
 *   fading over 1.5 s at a bout's edges, so the chorus breathes.
 *
 * **Katydids** are 1–3 far individuals, each a rasp of 2–4 short pulses of
 * counter-hashed noise through a band-pass (3–5.5 kHz, Q 3) every 1.5–4 s,
 * 14 dB under the nearest cricket, with the same bouts.
 *
 * **The chorus** of far-off insects is white noise in a band at 4.3 kHz (Q 4),
 * throbbing at about the crickets' pulse rate and drifting by ±3 dB, over a
 * faint low bed of brown noise (the same white noise, integrated) between
 * 60 and 500 Hz, all made here so the sound needs a single worklet node.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { sine } from "../../audio/dsp/osc";
import { OnePoleHighpass, OnePoleLowpass } from "../../audio/dsp/onepole";
import { panLeft, panRight } from "../../audio/dsp/pan";
import {
  createPeriodicEvents,
  PeriodicSchedule,
  type PeriodicEvents,
} from "../../audio/dsp/periodic";
import { Svf } from "../../audio/dsp/svf";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";

export const INSECTS_PROCESSOR = "aural-insects";
/** The worklet's output: one stereo mix. */
export const INSECTS_CHANNELS = 2;
/** The most crickets: the Crickets param's maximum. */
export const CRICKET_SLOTS = 12;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Evenly in log from `a` to `b`. */
const logLerp = (a: number, b: number, t: number) => a * (b / a) ** t;

/** Random streams: each individual's traits and bouts, the noises and the drift. */
const CRICKET_STREAM = 1;
const BOUT_STREAM = 2;
const KATYDID_STREAM = 3;
const KATYDID_BOUT_STREAM = 4;
const CHORUS_STREAM = 5;
const SWELL_STREAM = 7;
/** Each cricket's chirps, each katydid's rasps and its noise: these plus its index. */
const CHIRP_STREAM = 100;
const RASP_STREAM = 200;
const RASP_NOISE_STREAM = 300;

/** Keys for each individual's own traits: `hashStep(hash, key)`. */
const FREQUENCY = 1;
const FACTOR = 2;
const PULSES = 3;
const LENGTH = 4;
const DISTANCE = 5;
const PAN = 6;
const PERIOD = 7;
const SPACING = 8;
const COUNT = 9;

/** The warmth's range, in °C. */
const COOLEST = 12;
const WARMEST = 28;

/** Chirps a minute at `warmth` °C, by Dolbear's law: 54 at 12 °C, 110 at 20, 166 at 28. */
export function chirpsPerMinute(warmth: number): number {
  return 7 * (warmth - 10) + 40;
}

/** Pulses a second inside a chirp at `warmth` °C: 22 at 12 °C to 45 at 28, evenly between. */
export function pulseRate(warmth: number): number {
  return lerp(22, 45, clamp01((warmth - COOLEST) / (WARMEST - COOLEST)));
}

/** Seconds between an individual's chirps at `warmth` for its rate `factor`. */
export function chirpPeriod(warmth: number, factor: number): number {
  return 60 / (chirpsPerMinute(clamp(warmth, COOLEST, WARMEST)) * factor);
}

/** How far each chirp strays from its grid, as a fraction of the period. */
export const CHIRP_JITTER = 0.06;
/** A pulse's carrier glides down by this fraction across it: +0.5 % to −0.5 %. */
const GLIDE = 0.01;
/** A pulse lasts at most this fraction of the pulse period, so pulses never touch. */
const PULSE_DUTY = 0.7;
/** Pulses are at least this long, so their raised-cosine edges stay at least 4 ms. */
const SHORTEST_PULSE = 0.008;
/** The longest a chirp can last, in seconds: 5 pulses at the slowest pulse rate, slowest factor. */
const LONGEST_CHIRP = 4 / (pulseRate(COOLEST) * 0.9) + 0.015;

/** Bouts: blocks of this many seconds, sung with this probability, faded over this. */
const BOUT_BLOCK = 8;
const BOUT_PROBABILITY = 0.75;
const BOUT_FADE = 1.5;

/** A count change fades an individual in or out over this, in seconds. */
const COUNT_FADE = 1;

/** An individual's own random trait `key`, in [0, 1). */
const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;

/** A cricket's traits, fixed by the seed and its index. */
interface CricketTraits {
  /** The carrier, in Hz: 3.8–5.2 kHz. */
  frequency: number;
  /** Its pace against the others: 0.9–1.1. */
  factor: number;
  /** Pulses in a chirp: 3–5. */
  pulses: number;
  /** Each pulse's length, in seconds: 8–15 ms. */
  pulseLength: number;
  /** How far away it is, 0.2–1.0, before the Distance param. */
  distance: number;
  /** Its place in the stereo field, −0.8 to 0.8. */
  pan: number;
}

/** The hash an individual's traits derive from. */
const individualHash = (seed: number, stream: number, index: number) =>
  hashStep(hashStep(hashStep(HASH_START, seed), stream), index);

/**
 * Cricket `index`'s traits for `seed`. The first sits close and the second
 * fairly close, so every seed has a cricket or two to pick out and about the
 * same level; the rest are anywhere from near to far. The first is never far
 * to one side, and no near one sits beyond ±0.5.
 */
export function cricketTraits(seed: number, index: number): CricketTraits {
  const hash = individualHash(seed, CRICKET_STREAM, index);
  const u = unit(hash, DISTANCE);
  const distance =
    index === 0 ? lerp(0.2, 0.35, u) : index === 1 ? lerp(0.25, 0.5, u) : 0.3 + 0.7 * u;
  const widest = index === 0 ? 0.3 : distance < 0.5 ? 0.5 : 0.8;
  return {
    frequency: lerp(3800, 5200, unit(hash, FREQUENCY)),
    factor: lerp(0.9, 1.1, unit(hash, FACTOR)),
    pulses: 3 + Math.floor(unit(hash, PULSES) * 3),
    pulseLength: lerp(0.008, 0.015, unit(hash, LENGTH)),
    distance,
    pan: (unit(hash, PAN) * 2 - 1) * widest,
  };
}

/**
 * How far away an individual `own` away seems at the Distance param
 * `distance` (0–100): pushed up to 80 % of the way to the farthest, with the
 * square of the param, so the crickets stay close a little way back.
 */
export function effectiveDistance(own: number, distance: number): number {
  return own + (1 - own) * 0.8 * clamp01(distance / 100) ** 2;
}

/** A cricket's level at distance `d` (0.2–1.0), in dB: −4 near to −22 far. */
export function cricketDb(d: number): number {
  return -4 - 18 * clamp01((d - 0.2) / 0.8);
}

/** The air's softening at distance `d`: a low-pass from 9 kHz near to 4.5 kHz far, in Hz. */
export function airCutoff(d: number): number {
  return logLerp(9000, 4500, clamp01((d - 0.2) / 0.8));
}

/** The gain a one-pole low-pass at `cutoff` gives a sine at `frequency`. */
export function onePoleGain(frequency: number, cutoff: number): number {
  return 1 / Math.sqrt(1 + (frequency / cutoff) ** 2);
}

/**
 * A cricket's peak at 0 dB on its distance scale, before its pan (the nearest,
 * at 0.2, peaks 4 dB under it): the level everything else is set against.
 * With 12 crickets, the warmest night and Distance 0, two near pulses meeting
 * stay under −3 dBFS, and the defaults sit near −23 LUFS.
 */
const CRICKET_PEAK = dbToGain(-1.5);
/** The katydids' rasps against the nearest a cricket can be, in dB. */
const KATYDID_DB = -14;

/**
 * The chorus's RMS level against `CRICKET_PEAK`, in dB, at the Distance param
 * `distance` (0–100): −45 close by to −32 far off, where it carries the sound.
 * At the default distance it sits about 10 dB under the crickets.
 */
export function chorusDb(distance: number): number {
  return lerp(-45, -32, clamp01(distance / 100));
}

/** The chorus's band, and how much it throbs (at the pulse rate × 0.97) and swells. */
const CHORUS_CENTRE = 4300;
const CHORUS_Q = 4;
const THROB_DEPTH = 0.3;
const THROB_RATIO = 0.97;
const SWELL = { rate: 0.1, octaves: 2, db: 3 } as const;

/**
 * The night-air bed's RMS level against `CRICKET_PEAK`, in dB: about 15 dB
 * under the whole at the defaults, felt more than heard.
 */
const BED_DB = -44;
/**
 * The bed: brown noise from an integrator with its corner here, in Hz, then
 * high-passed (leaving nothing below 25 Hz for the master to cut) and
 * low-passed.
 */
const BED_CORNER = 150;
const BED_HIGHPASS = 60;
const BED_CUTOFF = 500;

/** The standard deviation of white noise uniform in [−1, 1). */
const UNIFORM_SD = 1 / Math.sqrt(3);

/**
 * The chorus's and the katydids' noise is low-passed here first (12 dB per
 * octave), so their bands fall away fast above them, well before 8 kHz.
 */
const NOISE_PRE_CUTOFF = 5000;

/** Two one-pole low-passes at `NOISE_PRE_CUTOFF`, for the noise a band-pass takes. */
class PreFilter {
  private readonly first: OnePoleLowpass;
  private readonly second: OnePoleLowpass;

  constructor(sampleRate: number) {
    this.first = new OnePoleLowpass(sampleRate, NOISE_PRE_CUTOFF);
    this.second = new OnePoleLowpass(sampleRate, NOISE_PRE_CUTOFF);
  }

  /** Its gain at `frequency`. */
  static gain(frequency: number): number {
    return onePoleGain(frequency, NOISE_PRE_CUTOFF) ** 2;
  }

  process(x: number): number {
    return this.second.process(this.first.process(x));
  }

  reset(): void {
    this.first.value = 0;
    this.second.value = 0;
  }
}

/** The outdoor reverb send, in dB: a little more far off. */
export function sendDb(distance: number): number {
  return -24 + 6 * clamp01(distance / 100);
}

/**
 * An individual's bout gain at absolute time `t`, 0 or 1 within a block and
 * a raised-cosine fade across each block's edge, from `prefix` (its seed,
 * bout stream and index).
 */
export function boutGain(prefix: number, t: number): number {
  const sings = (block: number) =>
    hashStep(prefix, block) * UINT32_SCALE < BOUT_PROBABILITY ? 1 : 0;
  const edge = Math.round(t / BOUT_BLOCK);
  const u = (t - edge * BOUT_BLOCK) / BOUT_FADE + 0.5;
  if (u > 0 && u < 1) {
    const before = sings(edge - 1);
    return before + (sings(edge) - before) * (0.5 - 0.5 * Math.cos(Math.PI * u));
  }
  return sings(Math.floor(t / BOUT_BLOCK));
}

/** The params a kernel latches from: see `InsectsGenerator.set`. */
interface Latched {
  warmth: number;
  distance: number;
}

/** One cricket: its traits, its schedule of chirps, and the chirp it is singing. */
export class Cricket {
  readonly traits: CricketTraits;
  private readonly schedule: PeriodicSchedule;
  private readonly boutPrefix: number;
  private readonly events: PeriodicEvents = createPeriodicEvents(4);
  /** The warmth its schedule's period is for. */
  private warmth: number;
  /** How present it is (a count change fades it in or out), and where that is heading. */
  presence = 0;
  target = 0;
  /** The chirp it is singing: its start (absolute seconds), end and what it latched. */
  private active = false;
  private start = 0;
  private end = 0;
  private pulseRate = 1;
  private pulseLength = 0.01;
  private gainLeft = 0;
  private gainRight = 0;

  constructor(seed: number, index: number, warmth: number) {
    this.traits = cricketTraits(seed, index);
    this.warmth = warmth;
    this.schedule = new PeriodicSchedule(
      seed,
      CHIRP_STREAM + index,
      chirpPeriod(warmth, this.traits.factor),
      CHIRP_JITTER,
    );
    this.boutPrefix = individualHash(seed, BOUT_STREAM, index);
  }

  /** Moves the schedule to `warmth` from its first chirp at or after `t` (absolute seconds). */
  setWarmth(warmth: number, t: number): void {
    if (warmth !== this.warmth) {
      this.warmth = warmth;
      this.schedule.setPeriod(chirpPeriod(warmth, this.traits.factor), t);
    }
  }

  /** Fills `out` with the chirps that start in [t0, t1) (absolute seconds), and returns how many. */
  chirpsIn(t0: number, t1: number, out: PeriodicEvents): number {
    return this.schedule.eventsIn(t0, t1, out);
  }

  /** Forgets the chirp it was singing, and picks up the one sounding at `t`, if any. */
  restart(t: number, params: Latched): void {
    this.active = false;
    this.presence = this.target;
    const count = this.schedule.eventsIn(t - LONGEST_CHIRP, t, this.events);
    if (count > 0) {
      this.begin(this.events.times[count - 1] ?? 0, params);
    }
  }

  /** Whether it is silent and will stay so until its count brings it back. */
  get idle(): boolean {
    return !this.active && this.presence === 0 && this.target === 0;
  }

  /** Starts a chirp at absolute time `t`, latching the params. */
  private begin(t: number, params: Latched): void {
    const traits = this.traits;
    const level = this.presence * boutGain(this.boutPrefix, t);
    if (level <= 0) {
      this.active = false;
      return;
    }
    const d = effectiveDistance(traits.distance, params.distance);
    const gain =
      CRICKET_PEAK * level * dbToGain(cricketDb(d)) * onePoleGain(traits.frequency, airCutoff(d));
    this.pulseRate = pulseRate(params.warmth) * traits.factor;
    this.pulseLength = Math.max(
      SHORTEST_PULSE,
      Math.min(traits.pulseLength, PULSE_DUTY / this.pulseRate),
    );
    this.gainLeft = gain * panLeft(traits.pan);
    this.gainRight = gain * panRight(traits.pan);
    this.start = t;
    this.end = t + (traits.pulses - 1) / this.pulseRate + this.pulseLength;
    this.active = true;
  }

  /**
   * Adds `length` samples into `left` and `right`, the first at absolute time
   * `t0`, `dt` seconds apart.
   */
  render(
    left: Float32Array,
    right: Float32Array,
    length: number,
    t0: number,
    dt: number,
    params: Latched,
  ): void {
    const count = this.schedule.eventsIn(t0, t0 + length * dt, this.events);
    let pos = 0;
    for (let e = 0; e < count; e++) {
      const t = this.events.times[e] ?? 0;
      const at = Math.min(length, Math.max(pos, Math.ceil((t - t0) / dt)));
      this.sing(left, right, pos, at, t0, dt);
      this.begin(t, params);
      pos = at;
    }
    this.sing(left, right, pos, length, t0, dt);
  }

  /** Adds the current chirp's samples `from` to `to`. */
  private sing(
    left: Float32Array,
    right: Float32Array,
    from: number,
    to: number,
    t0: number,
    dt: number,
  ): void {
    if (!this.active || from >= to) {
      return;
    }
    const frequency = this.traits.frequency;
    const length = this.pulseLength;
    const inverse = 1 / length;
    const gainLeft = this.gainLeft;
    const gainRight = this.gainRight;
    for (let j = 0; j < this.traits.pulses; j++) {
      const pulseStart = this.start + j / this.pulseRate;
      const i0 = Math.max(from, Math.ceil((pulseStart - t0) / dt));
      const i1 = Math.min(to, Math.ceil((pulseStart + length - t0) / dt));
      for (let i = i0; i < i1; i++) {
        const tau = t0 + i * dt - pulseStart;
        if (tau < 0 || tau >= length) {
          continue;
        }
        const x = tau * inverse;
        const envelope = 0.5 - 0.5 * sine(x + 0.25);
        const y = envelope * sine(frequency * tau * (1 + GLIDE / 2 - (GLIDE / 2) * x));
        left[i] = (left[i] ?? 0) + y * gainLeft;
        right[i] = (right[i] ?? 0) + y * gainRight;
      }
    }
    if (t0 + to * dt >= this.end) {
      this.active = false;
    }
  }
}

/** A katydid's traits, fixed by the seed and its index. */
interface KatydidTraits {
  /** Its band's centre, in Hz: 3–5.5 kHz. */
  centre: number;
  /** Pulses in a rasp: 2–4. */
  pulses: number;
  /** Each pulse's length, in seconds: 20–40 ms. */
  pulseLength: number;
  /** From one pulse's start to the next, in pulse lengths: 1.4–2. */
  spacing: number;
  /** The mean time between rasps, in seconds: 2–3.2 (each 1.5–4). */
  period: number;
  /** Its place in the stereo field, −0.8 to 0.8. */
  pan: number;
}

/** How many katydids `seed` has: 1–3. */
export function katydidCount(seed: number): number {
  return 1 + Math.floor(unit(individualHash(seed, KATYDID_STREAM, -1), COUNT) * 3);
}

/** Katydid `index`'s traits for `seed`. */
export function katydidTraits(seed: number, index: number): KatydidTraits {
  const hash = individualHash(seed, KATYDID_STREAM, index);
  return {
    centre: lerp(3000, 5500, unit(hash, FREQUENCY)),
    pulses: 2 + Math.floor(unit(hash, PULSES) * 3),
    pulseLength: lerp(0.02, 0.04, unit(hash, LENGTH)),
    spacing: lerp(1.4, 2, unit(hash, SPACING)),
    period: lerp(2, 3.2, unit(hash, PERIOD)),
    pan: (unit(hash, PAN) * 2 - 1) * 0.8,
  };
}

/** Rasps stray up to this fraction of their period from the grid: 1.5–4 s apart. */
const RASP_JITTER = 0.2;
/** The katydids are set against the nearest a cricket can be (0.2), as the Distance param moves it. */
const NEAREST = 0.2;
/** The katydids' band-pass Q. */
const KATYDID_Q = 3;
/** The longest a rasp can last, in seconds. */
const LONGEST_RASP = 4 * 0.04 * 2;

/** One katydid: its rasps of band-passed noise. */
class Katydid {
  readonly traits: KatydidTraits;
  private readonly schedule: PeriodicSchedule;
  private readonly boutPrefix: number;
  private readonly noisePrefix: number;
  private readonly events: PeriodicEvents = createPeriodicEvents(4);
  private readonly pre: PreFilter;
  private readonly filter: Svf;
  /** Scales the band-passed noise to a peak of about 1. */
  private readonly normal: number;
  private readonly sampleRate: number;
  private active = false;
  private start = 0;
  private end = 0;
  /** The next absolute sample the filter takes, while a rasp sounds. */
  private sample = 0;
  private gainLeft = 0;
  private gainRight = 0;

  constructor(seed: number, index: number, sampleRate: number) {
    this.traits = katydidTraits(seed, index);
    this.sampleRate = sampleRate;
    this.schedule = new PeriodicSchedule(
      seed,
      RASP_STREAM + index,
      this.traits.period,
      RASP_JITTER,
    );
    this.boutPrefix = individualHash(seed, KATYDID_BOUT_STREAM, index);
    this.noisePrefix = individualHash(seed, RASP_NOISE_STREAM, index);
    this.pre = new PreFilter(sampleRate);
    this.filter = new Svf(sampleRate, this.traits.centre, KATYDID_Q);
    // Band-passed white noise's RMS, so a rasp's level is the same at any rate;
    // its peaks sit about three times higher.
    const rms =
      UNIFORM_SD *
      PreFilter.gain(this.traits.centre) *
      Math.sqrt((Math.PI * this.traits.centre) / (KATYDID_Q * sampleRate));
    this.normal = 1 / (3 * rms);
  }

  /** Forgets the rasp it was making, and picks up the one sounding at absolute sample `start`, if any. */
  restart(start: number, distance: number): void {
    this.active = false;
    const t = start / this.sampleRate;
    const count = this.schedule.eventsIn(t - LONGEST_RASP, t, this.events);
    if (count > 0) {
      // Run the filter silently from the rasp's start, as it would have run.
      if (this.begin(this.events.times[count - 1] ?? 0, distance)) {
        for (; this.sample < start; this.sample++) {
          this.filter.tick(this.pre.process(this.noise(this.sample)));
        }
      }
    }
  }

  private noise(n: number): number {
    return hashStep(this.noisePrefix, n) * UINT32_SCALE * 2 - 1;
  }

  /** Starts a rasp at absolute time `t`, latching the distance; returns whether it sounds. */
  private begin(t: number, distance: number): boolean {
    const level = boutGain(this.boutPrefix, t);
    if (level <= 0) {
      this.active = false;
      return false;
    }
    const traits = this.traits;
    const d = effectiveDistance(NEAREST, distance);
    const gain = CRICKET_PEAK * level * dbToGain(cricketDb(d) + KATYDID_DB) * this.normal;
    this.gainLeft = gain * panLeft(traits.pan);
    this.gainRight = gain * panRight(traits.pan);
    this.start = t;
    this.end = t + traits.pulseLength * (traits.spacing * (traits.pulses - 1) + 1);
    this.sample = Math.ceil(t * this.sampleRate);
    this.filter.reset();
    this.pre.reset();
    this.active = true;
    return true;
  }

  /**
   * Adds `length` samples into `left` and `right` from absolute sample
   * `start`, scaled from `from` to `to` (the katydids' fade) across them.
   */
  render(
    left: Float32Array,
    right: Float32Array,
    length: number,
    start: number,
    distance: number,
    from: number,
    to: number,
  ): void {
    const dt = 1 / this.sampleRate;
    const t0 = start * dt;
    const count = this.schedule.eventsIn(t0, t0 + length * dt, this.events);
    let pos = 0;
    for (let e = 0; e < count; e++) {
      const t = this.events.times[e] ?? 0;
      const at = Math.min(length, Math.max(pos, Math.ceil(t * this.sampleRate) - start));
      this.rasp(left, right, pos, at, start, from, to, length);
      this.begin(t, distance);
      pos = at;
    }
    this.rasp(left, right, pos, length, start, from, to, length);
  }

  private rasp(
    left: Float32Array,
    right: Float32Array,
    first: number,
    last: number,
    start: number,
    from: number,
    to: number,
    length: number,
  ): void {
    if (!this.active || first >= last) {
      return;
    }
    const dt = 1 / this.sampleRate;
    const traits = this.traits;
    const pulse = traits.pulseLength;
    const step = pulse * traits.spacing;
    const inverse = 1 / pulse;
    const filter = this.filter;
    const pre = this.pre;
    const slope = (to - from) / length;
    for (let i = Math.max(first, this.sample - start); i < last; i++) {
      const n = start + i;
      filter.tick(pre.process(this.noise(n)));
      const tau = n * dt - this.start;
      const j = Math.floor(tau / step);
      const x = (tau - j * step) * inverse;
      if (j < 0 || j >= traits.pulses || x >= 1) {
        continue;
      }
      const y = filter.band * (0.5 - 0.5 * sine(x + 0.25)) * (from + slope * i);
      left[i] = (left[i] ?? 0) + y * this.gainLeft;
      right[i] = (right[i] ?? 0) + y * this.gainRight;
    }
    this.sample = start + last;
    if ((start + last) * dt >= this.end) {
      this.active = false;
    }
  }
}

interface InsectsOptions {
  seed: number;
  /** The warmth the chirps start at, in °C. */
  warmth: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readInsectsOptions(raw: unknown): InsectsOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    warmth: numberOr(get("warmth"), 20),
    offset: numberOr(get("offset"), 0),
  };
}

/**
 * Everything the insects worklet makes, as one stereo mix: the crickets, the
 * katydids and the chorus over its bed, from absolute samples, so
 * time-addressable at fixed params.
 */
export class InsectsGenerator {
  private readonly sampleRate: number;
  readonly crickets: readonly Cricket[];
  private readonly katydids: readonly Katydid[];
  private readonly params: Latched;
  private count = 0;
  /** The katydids' fade: the level at the end of the last render, and the one it heads for. */
  private katydidLevel = 0;
  private katydidTarget = 0;
  private katydidsAwake = false;
  /** The chorus's level at the end of the last render. */
  private chorusLevel = Number.NaN;
  private readonly noisePrefixes: Uint32Array;
  private readonly chorusFilters: readonly Svf[];
  private readonly chorusPreFilters: readonly PreFilter[];
  private readonly chorusNormal: number;
  private readonly swell: DriftGenerator;
  private throbPhase = 0;
  /** The bed's integrators, high-passes and low-passes, per channel. */
  private readonly bedState = new Float64Array(2);
  private readonly bedHighpasses: readonly OnePoleHighpass[];
  private readonly bedFilters: readonly OnePoleLowpass[];
  private readonly bedPole: number;
  private readonly bedGain: number;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, warmth: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.params = { warmth, distance: 40 };
    this.crickets = Array.from({ length: CRICKET_SLOTS }, (_, i) => new Cricket(seed, i, warmth));
    this.katydids = Array.from(
      { length: katydidCount(seed) },
      (_, i) => new Katydid(seed, i, sampleRate),
    );
    const base = hashStep(hashStep(HASH_START, seed), CHORUS_STREAM);
    this.noisePrefixes = Uint32Array.of(hashStep(base, 0), hashStep(base, 1));
    this.chorusFilters = [0, 1].map(() => new Svf(sampleRate, CHORUS_CENTRE, CHORUS_Q));
    this.chorusPreFilters = [0, 1].map(() => new PreFilter(sampleRate));
    const rms =
      UNIFORM_SD *
      PreFilter.gain(CHORUS_CENTRE) *
      Math.sqrt((Math.PI * CHORUS_CENTRE) / (CHORUS_Q * sampleRate));
    this.chorusNormal = CRICKET_PEAK / (rms * Math.sqrt(1 + THROB_DEPTH ** 2 / 2));
    this.swell = new DriftGenerator(seed, SWELL_STREAM, SWELL.rate, SWELL.octaves, sampleRate);
    this.bedPole = Math.exp((-2 * Math.PI * BED_CORNER) / sampleRate);
    this.bedGain =
      (CRICKET_PEAK * dbToGain(BED_DB) * Math.sqrt(1 - this.bedPole ** 2)) / UNIFORM_SD;
    this.bedHighpasses = [0, 1].map(() => new OnePoleHighpass(sampleRate, BED_HIGHPASS));
    this.bedFilters = [0, 1].map(() => new OnePoleLowpass(sampleRate, BED_CUTOFF));
  }

  /**
   * Sets the params for the next render: `count` crickets (1–12), each fading
   * in or out over a second; the `warmth` (°C) and `distance` (0–100), which
   * each chirp and rasp latches as it starts (the chorus follows the distance
   * at once, so glide it); and `katydids`, their level (0–1), faded across
   * each render.
   */
  set(count: number, warmth: number, distance: number, katydids: number): void {
    this.count = clamp(Math.round(count), 0, CRICKET_SLOTS);
    this.params.warmth = warmth;
    this.params.distance = distance;
    this.katydidTarget = clamp01(katydids);
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    const length = left.length;
    const sr = this.sampleRate;
    const dt = 1 / sr;
    const t0 = start * dt;
    const params = this.params;
    const fresh = start !== this.expected;
    this.expected = start + length;

    for (let i = 0; i < CRICKET_SLOTS; i++) {
      const cricket = this.crickets[i];
      cricket.target = i < this.count ? 1 : 0;
      cricket.setWarmth(params.warmth, t0);
    }
    if (fresh) {
      for (const cricket of this.crickets) {
        cricket.restart(t0, params);
      }
      this.katydidLevel = this.katydidTarget;
      this.katydidsAwake = false;
      this.chorusLevel = Number.NaN;
      this.throbPhase = pulseRate(params.warmth) * THROB_RATIO * t0;
      this.throbPhase -= Math.floor(this.throbPhase);
    }

    this.renderChorus(left, right, length, start);

    const fade = (length * dt) / COUNT_FADE;
    for (const cricket of this.crickets) {
      if (cricket.idle) {
        continue;
      }
      cricket.render(left, right, length, t0, dt, params);
      cricket.presence =
        cricket.target > cricket.presence
          ? Math.min(cricket.target, cricket.presence + fade)
          : Math.max(cricket.target, cricket.presence - fade);
    }

    const from = this.katydidLevel;
    const to = this.katydidTarget;
    this.katydidLevel = to;
    if (from === 0 && to === 0) {
      this.katydidsAwake = false;
      return;
    }
    for (const katydid of this.katydids) {
      if (!this.katydidsAwake) {
        katydid.restart(start, params.distance);
      }
      katydid.render(left, right, length, start, params.distance, from, to);
    }
    this.katydidsAwake = true;
  }

  /** Writes the chorus and the bed into `left` and `right`, overwriting them. */
  private renderChorus(
    left: Float32Array,
    right: Float32Array,
    length: number,
    start: number,
  ): void {
    const sr = this.sampleRate;
    const target = dbToGain(chorusDb(this.params.distance)) * this.chorusNormal;
    const level = Number.isNaN(this.chorusLevel) ? target : this.chorusLevel;
    this.chorusLevel = target;
    const from = level * dbToGain(SWELL.db * this.swell.valueAtTime(start / sr));
    const to = target * dbToGain(SWELL.db * this.swell.valueAtTime((start + length) / sr));
    const increment = (pulseRate(this.params.warmth) * THROB_RATIO) / sr;
    this.renderChorusChannel(0, left, length, start, from, to, increment);
    const phase = this.renderChorusChannel(1, right, length, start, from, to, increment);
    this.throbPhase = phase - Math.floor(phase);
  }

  /**
   * Writes channel `c`'s chorus, its level moving from `from` to `to`, over its
   * bed into `out`, and returns the throb's phase after it.
   */
  private renderChorusChannel(
    c: number,
    out: Float32Array,
    length: number,
    start: number,
    from: number,
    to: number,
    increment: number,
  ): number {
    const prefix = this.noisePrefixes[c] ?? 0;
    const filter = this.chorusFilters[c];
    const pre = this.chorusPreFilters[c];
    const highpass = this.bedHighpasses[c];
    const lowpass = this.bedFilters[c];
    let phase = this.throbPhase;
    const slope = (to - from) / length;
    const pole = this.bedPole;
    const gain = this.bedGain;
    let bed = this.bedState[c] ?? 0;
    for (let i = 0; i < length; i++) {
      const w = hashStep(prefix, start + i) * UINT32_SCALE * 2 - 1;
      filter.tick(pre.process(w));
      const throb = 1 + THROB_DEPTH * sine(phase);
      phase += increment;
      bed = pole * bed + gain * w;
      out[i] = filter.band * throb * (from + slope * i) + lowpass.process(highpass.process(bed));
    }
    this.bedState[c] = bed;
    return phase;
  }
}
