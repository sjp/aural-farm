/**
 * Singing Bowls' kernel: metal standing bowls in a quiet room, struck softly
 * now and then with a padded mallet, and optionally one rubbed around its rim.
 * No Web Audio here, so it is unit-testable in Node.
 *
 * - **Bowls.** Each bowl is a `ModalBank` of four modes at about 1, 2.7, 5.1
 *   and 8.2 times its fundamental (at 0, −4, −10 and −18 dB), the higher three
 *   detuned by a hashed ±1.5 % (the fundamental by ±0.3 %, so the set stays in
 *   tune) so every bowl is individual. Each mode is a split pair: two equal
 *   resonators at `f` and `f + b`, the beat `b` hashed per mode (0.4–1.6 Hz for
 *   the fundamental, 0.8–3 Hz above), so the tone wavers slowly and deeply as
 *   the two beat. The fundamental's pair starts in opposite phases, so it
 *   blooms from nothing over its first half-beat while the higher modes give
 *   the strike its edge (this also keeps each strike's peak about 2 dB lower
 *   for its loudness). The fundamental rings 25–40 s to −60 dB, the others about
 *   18, 12 and 7 s (±20 % per bowl). Modes above 7 kHz are left out.
 * - **The set.** Bowl `i`'s fundamental is 0, 7, 12, 14 or 19 semitones above
 *   the key in octave 3, so any overlap is consonant; bowl 0 is the deepest.
 *   Each bowl has its own place across ±0.5 (the deepest near the centre, the
 *   rest alternating sides, mirrored by a hash), the same whatever the count.
 * - **The mallet** is padded: a strike is an impulse into modes rolled off
 *   above 800 Hz (a first-order corner), the spectrum of a soft blow, which
 *   picks up in closed form, without the spectral nulls a few-millisecond
 *   pulse would put right where some modes ring.
 * - **Strikes.** Slot `n` falls at `n × interval`, give or take a hashed 30 %
 *   (`periodic.ts`), so strikes are at least 0.4 × interval apart. Slots are
 *   dealt to bowls in cycles of `count`: each cycle a hashed shuffle of the
 *   set, its first two swapped if it would start on the bowl the last one
 *   ended on, so every bowl gets struck and none twice running. Strength is
 *   hashed in 0.55–1, the deepest bowl a little harder on average.
 * - **Rim singing.** Two sines at bowl 0's fundamental split pair and a faint
 *   friction of noise band-passed around it (Q 20, 20 dB under the sines),
 *   swelling and receding between −40 and −16 dB on a slow drift (0.025 Hz),
 *   faded in or out over 4 s when it is turned on or off.
 *
 * Strike times and picks are functions of the seed, the interval and the slot
 * alone, and the sines and drift of absolute time, so a render that starts
 * afresh strikes the bowls still ringing in closed form, as they stand a
 * moment before it, then renders that moment unheard (for the friction's
 * filter): at steady params the output depends only on the seed and absolute
 * time. A change of interval re-anchors the slots at the next strike, which
 * keeps its time but comes no later than one new interval away; a change of
 * count applies from the next strike, a bowl left out ringing out.
 */
import { ModalBank } from "../../audio/dsp/modal";
import { panLeft, panRight } from "../../audio/dsp/pan";
import {
  createPeriodicEvents,
  PeriodicSchedule,
  type PeriodicEvents,
} from "../../audio/dsp/periodic";
import { svfCoefficients } from "../../audio/dsp/svf";
import { DriftGenerator } from "../../audio/drift-dsp";
import { HASH_START, hash32, hashStep, UINT32_SCALE } from "../../audio/random";
import { MAX_BOWLS, MAX_INTERVAL, MIN_INTERVAL, type BowlKey } from "./bowls.meta";

export const BOWLS_PROCESSOR = "aural-bowls";
/** The worklet's output channels: left and right. */
export const BOWLS_CHANNELS = 2;

/** Random streams. */
export const STRIKE_STREAM = 1;
const PICK_STREAM = 2;
const STRENGTH_STREAM = 3;
const BOWL_STREAM = 4;
const RUB_STREAM = 5;
const FRICTION_STREAM = 6;

/** Salts for a bowl's random properties. */
const DECAY_SALT = 21;
const DETUNE_SALT = 22;
const BEAT_SALT = 23;
const PAN_SALT = 24;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const unit = (state: number, salt: number) => hashStep(state, salt) * UINT32_SCALE;
const between = (range: readonly [number, number], u: number) =>
  range[0] + (range[1] - range[0]) * u;

// ---------------------------------------------------------------------------
// The bowls.

/** Each key's semitones above C. */
const KEY_STEPS: Readonly<Record<BowlKey, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** C3, in Hz. */
const C3 = 130.8128;
/** Each bowl's fundamental, in semitones above the key: bowl 0 is the deepest. */
export const BOWL_STEPS = [0, 7, 12, 14, 19] as const;

/** The modes' frequencies against the fundamental, their levels (dB) and decays (s to −60 dB). */
export const MODE_RATIOS = [1, 2.7, 5.1, 8.2] as const;
const MODE_LEVELS_DB = [0, -4, -10, -18] as const;
/** The fundamental's decay, from–to, hashed per bowl. */
export const FUNDAMENTAL_DECAY = [25, 40] as const;
/** The higher modes' decays, scaled by a hashed ±20 % per bowl. */
const UPPER_DECAYS = [18, 12, 7] as const;
const DECAY_SPREAD = 0.2;
/** How far each mode is detuned, either way: the fundamental and the rest. */
export const FUNDAMENTAL_DETUNE = 0.003;
export const UPPER_DETUNE = 0.015;
/** The split pairs' beats, in Hz, from–to: the fundamental's, and the higher modes'. */
export const FUNDAMENTAL_BEAT = [0.4, 1.6] as const;
export const UPPER_BEAT = [0.8, 3] as const;
/** Modes above this, in Hz, are left out: piercing over hours. */
export const MODE_TOP = 7000;
/** The padded mallet's roll-off: a first-order corner, in Hz. */
const MALLET_CORNER = 800;
/** Resonators per bowl: a split pair per mode. */
const BOWL_RESONATORS = 2 * MODE_RATIOS.length;

/** A first-order low-pass's gain at `frequency`, for a corner at `corner`. */
const rollOff = (frequency: number, corner: number) => 1 / Math.sqrt(1 + (frequency / corner) ** 2);

/** Bowl `index`'s nominal fundamental in `key`, in Hz. */
export function bowlFundamental(key: BowlKey, index: number): number {
  const steps = KEY_STEPS[key] + (BOWL_STEPS[index] ?? 0);
  return C3 * 2 ** (steps / 12);
}

/** One mode of a bowl: a split pair at `frequency` and `frequency + beat`. */
interface BowlMode {
  frequency: number;
  beat: number;
  /** Seconds to −60 dB. */
  decay: number;
  /** Each resonator's amplitude per unit strike. */
  amplitude: number;
}

/** A bowl's hash: its decays, detunes, beats and place. */
const bowlHash = (seed: number, index: number) =>
  hashStep(hashStep(hashStep(HASH_START, seed), BOWL_STREAM), index);

/** Bowl `index`'s modes in `key` for `seed`, leaving out any above `MODE_TOP`. */
export function bowlModes(key: BowlKey, seed: number, index: number): BowlMode[] {
  const hash = bowlHash(seed, index);
  const fundamental = bowlFundamental(key, index);
  const scale = 1 + DECAY_SPREAD * (2 * unit(hash, DECAY_SALT) - 1);
  const modes: BowlMode[] = [];
  for (const [m, ratio] of MODE_RATIOS.entries()) {
    const modeHash = hashStep(hash, m);
    const detune = m === 0 ? FUNDAMENTAL_DETUNE : UPPER_DETUNE;
    const frequency = fundamental * ratio * (1 + detune * (2 * unit(modeHash, DETUNE_SALT) - 1));
    const beat = between(m === 0 ? FUNDAMENTAL_BEAT : UPPER_BEAT, unit(modeHash, BEAT_SALT));
    if (frequency + beat > MODE_TOP) {
      continue;
    }
    const decay =
      m === 0
        ? between(FUNDAMENTAL_DECAY, unit(modeHash, DECAY_SALT))
        : (UPPER_DECAYS[m - 1] ?? 0) * scale;
    const amplitude = dbToGain(MODE_LEVELS_DB[m] ?? 0) * rollOff(frequency, MALLET_CORNER);
    modes.push({ frequency, beat, decay, amplitude });
  }
  return modes;
}

/** How many bowls `bowls` (the param) asks for: a whole number from 1 to 5. */
export function bowlCount(bowls: number): number {
  return Number.isFinite(bowls) ? clamp(Math.round(bowls), 1, MAX_BOWLS) : 1;
}

/** The bowls' places across the set: the deepest near the centre, then alternating sides. */
const BOWL_PLACES = [0, 0.5, -0.5, 0.25, -0.25] as const;
/** How far a bowl strays from its place, either way. */
const PLACE_JITTER = 0.06;
/** The widest place either side. */
export const BOWL_PAN = 0.5;

/** Bowl `index`'s place (−0.5 to 0.5), the same whatever the count. */
export function bowlPan(seed: number, index: number): number {
  const side = hash32(seed, BOWL_STREAM, PAN_SALT) % 2 === 0 ? 1 : -1;
  const jitter = PLACE_JITTER * (2 * unit(bowlHash(seed, index), PAN_SALT) - 1);
  return clamp(side * (BOWL_PLACES[index] ?? 0) + jitter, -BOWL_PAN, BOWL_PAN);
}

// ---------------------------------------------------------------------------
// The strikes.

/** How far each strike may stray from its slot, as a share of the interval. */
export const STRIKE_JITTER = 0.3;
/** A strike's strength, from–to; the deepest bowl's leans towards the top by this power. */
export const STRENGTH = [0.55, 1] as const;
const DEEPEST_LEAN = 0.6;

/** The interval (s) `interval` (the param) asks for: 10–60. */
export function strikeInterval(interval: number): number {
  return Number.isFinite(interval) ? clamp(interval, MIN_INTERVAL, MAX_INTERVAL) : MIN_INTERVAL;
}

/** Scratch for the cycles' shuffles: no allocation per strike. */
const shuffled = new Int32Array(MAX_BOWLS);

/** Fills `shuffled` with cycle `cycle`'s shuffle of `count` bowls, and returns its last. */
function shuffle(seed: number, cycle: number, count: number): number {
  const hash = hash32(seed, PICK_STREAM, cycle);
  for (let i = 0; i < count; i++) {
    shuffled[i] = i;
  }
  for (let i = count - 1; i > 0; i--) {
    const j = hashStep(hash, i) % (i + 1);
    const swap = shuffled[i] ?? 0;
    shuffled[i] = shuffled[j] ?? 0;
    shuffled[j] = swap;
  }
  return shuffled[count - 1] ?? 0;
}

/**
 * The bowl slot `n` strikes in a set of `count`: a pure function of the seed,
 * the slot and the count. Two bowls take turns; three or more are dealt in
 * cycles of a hashed shuffle, so none is struck twice running.
 */
export function pickBowl(seed: number, n: number, count: number): number {
  if (count <= 1) {
    return 0;
  }
  if (count === 2) {
    return (((n + (hash32(seed, PICK_STREAM) & 1)) % 2) + 2) % 2;
  }
  const cycle = Math.floor(n / count);
  const place = n - cycle * count;
  // The last cycle's last: a swap only touches a cycle's first two, never its last.
  const before = shuffle(seed, cycle - 1, count);
  shuffle(seed, cycle, count);
  if (shuffled[0] === before) {
    shuffled[0] = shuffled[1];
    shuffled[1] = before;
  }
  return shuffled[place] ?? 0;
}

/** How hard slot `n` strikes `bowl` (0–1). */
export function strikeStrength(seed: number, n: number, bowl: number): number {
  const u = hash32(seed, STRENGTH_STREAM, n) * UINT32_SCALE;
  return between(STRENGTH, bowl === 0 ? u ** DEEPEST_LEAN : u);
}

// ---------------------------------------------------------------------------
// The kernel.

/** A render quantum, in samples: the most the kernel renders at once. */
const QUANTUM = 128;
/** Each resonator's strike gain at full strength: sets the long-term level. */
const STRIKE_GAIN = dbToGain(-13.5);
/** A struck bowl has fallen 90 dB after this many of its longest decay times. */
const RING_OUT = 1.5;
/** Seconds rendered unheard before a render that starts afresh: the friction's filter settles. */
const PREROLL = 0.5;
/** Rim singing: the drift (Hz, octaves), and the level range it swings over, in dB. */
const RUB_DRIFT = { rate: 0.025, octaves: 1 } as const;
export const RUB_RANGE_DB = [-40, -16] as const;
/** The friction's band-pass Q, and its level under the sines, in dB. */
const FRICTION_Q = 20;
const FRICTION_DB = -20;
/** How long rim singing takes to fade in or out, in seconds. */
const RUB_FADE = 4;
/** Uniform noise in [−1, 1) to unit variance. */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** The guard on the sound: above the knee, a tanh curve that never passes the ceiling. */
const GUARD_KNEE = dbToGain(-8);
export const GUARD_CEILING = dbToGain(-4);

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

/** Rim singing's level (a gain, for the pair together) at the drift's value `d`. */
export function rubLevel(d: number): number {
  const [lo, hi] = RUB_RANGE_DB;
  const mid = (lo + hi) / 2;
  return dbToGain(clamp(mid + ((hi - lo) / 2) * d, lo, hi));
}

/** One bowl: its modes and its place. */
interface Bowl {
  readonly bank: ModalBank;
  readonly left: number;
  readonly right: number;
}

/** The worklet's options: the key, the seed and the offset to absolute time. */
interface BowlsOptions {
  key: BowlKey;
  seed: number;
  offset: number;
}

const isKey = (value: unknown): value is BowlKey =>
  typeof value === "string" && Object.hasOwn(KEY_STEPS, value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readBowlsOptions(raw: unknown): BowlsOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const key = get("key");
  return {
    key: isKey(key) ? key : "d",
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}

/**
 * Singing Bowls' whole sound for one key and seed, from absolute samples: the
 * same whether rendered in one go or in chunks, at steady params.
 */
export class BowlsKernel {
  private readonly sampleRate: number;
  private readonly seed: number;
  private readonly bowls: Bowl[];
  private schedule: PeriodicSchedule;
  private readonly events: PeriodicEvents = createPeriodicEvents(4);
  private readonly lookback: PeriodicEvents = createPeriodicEvents(16);
  /** How long after a strike its bowl is still heard, in seconds. */
  private readonly ringOut: number;
  private readonly preroll: number;

  /** Rim singing: the sines' frequencies, the drift, and the friction's filter. */
  private readonly rubFrequencies: readonly [number, number];
  private readonly rubDrift: DriftGenerator;
  private readonly frictionBand: Float64Array;
  private readonly frictionGain: number;
  private readonly frictionPrefix: number;
  private frictionLow = 0;
  private frictionBandState = 0;
  /** How far rim singing is faded in (0–1), and where it is heading. */
  private rubFade = 0;
  private rubTarget = 0;
  private readonly rubStep: number;

  /** Scratch: a bowl's ring, and an unheard render. */
  private readonly ring = new Float32Array(QUANTUM);
  private readonly unheard = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)] as const;

  /** The params `set` gave. */
  private count = 3;
  private interval = 25;
  /** The interval the schedule runs at. */
  private period = 25;
  /** The bowl struck last, so a live change of count never strikes it twice running. */
  private last = -1;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(key: BowlKey, seed: number, sampleRate: number) {
    const sr = sampleRate;
    this.sampleRate = sr;
    this.seed = seed;
    let longest = 0;
    this.bowls = Array.from({ length: MAX_BOWLS }, (_, index) => {
      const bank = new ModalBank(sr, BOWL_RESONATORS);
      for (const [m, mode] of bowlModes(key, seed, index).entries()) {
        bank.setMode(2 * m, mode.frequency, mode.decay, mode.amplitude);
        // The fundamental's pair starts in opposite phases, so it blooms from
        // nothing over its first half-beat; the higher pairs start together.
        const sign = m === 0 ? -1 : 1;
        bank.setMode(2 * m + 1, mode.frequency + mode.beat, mode.decay, sign * mode.amplitude);
        longest = Math.max(longest, mode.decay);
      }
      const pan = bowlPan(seed, index);
      return { bank, left: panLeft(pan) * Math.SQRT2, right: panRight(pan) * Math.SQRT2 };
    });
    this.schedule = new PeriodicSchedule(seed, STRIKE_STREAM, this.interval, STRIKE_JITTER);
    this.ringOut = RING_OUT * longest;
    this.preroll = Math.ceil(PREROLL * sr);

    // The deepest bowl's fundamental, never above the modes' ceiling.
    const [deepest] = bowlModes(key, seed, 0);
    const f0 = deepest.frequency;
    this.rubFrequencies = [f0, f0 + deepest.beat];
    this.rubDrift = new DriftGenerator(seed, RUB_STREAM, RUB_DRIFT.rate, RUB_DRIFT.octaves, sr);
    this.frictionBand = svfCoefficients(new Float64Array(4), f0, FRICTION_Q, sr);
    // Unit-variance white noise through a peak-normalised band-pass of Q `q` at
    // `f0` keeps π·f0 / (q·sr) of its power: scale it back to unit RMS.
    this.frictionGain =
      UNIFORM_TO_UNIT * Math.sqrt((FRICTION_Q * sr) / (Math.PI * f0)) * dbToGain(FRICTION_DB);
    this.frictionPrefix = hash32(seed, FRICTION_STREAM);
    this.rubStep = 1 / (RUB_FADE * sr);
  }

  /**
   * Sets the params for the next render: Bowls (1–5, latched per strike), the
   * interval (10–60 s, re-anchored at the next strike) and rim singing (on or
   * off, faded over 4 s).
   */
  set(bowls: number, interval: number, rub: boolean): void {
    this.count = bowlCount(bowls);
    this.interval = strikeInterval(interval);
    this.rubTarget = rub ? 1 : 0;
  }

  /** How many bowls are ringing. */
  get ringing(): number {
    return this.bowls.filter((b) => b.bank.ringing).length;
  }

  /**
   * Strikes `bowls` bowls of the set (the deepest first) at once, `strength`
   * (0–1) hard, from the next sample rendered: for checking the loudest the
   * bowls could get.
   */
  strikeAll(strength: number, bowls = MAX_BOWLS): void {
    for (let i = 0; i < Math.min(bowls, MAX_BOWLS); i++) {
      this.bowls[i]?.bank.strike(strength * STRIKE_GAIN);
    }
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    const length = Math.min(left.length, right.length);
    if (start !== this.expected) {
      this.warmUp(start);
    } else if (this.interval !== this.period) {
      const now = start / this.sampleRate;
      this.schedule.setPeriod(this.interval, now, now + this.interval);
      this.period = this.interval;
    }
    for (let done = 0; done < length; done += QUANTUM) {
      const n = Math.min(QUANTUM, length - done);
      this.process(left, right, done, n, start + done);
    }
    this.expected = start + length;
  }

  /**
   * A fresh start, or a jump: the schedule laid out afresh on absolute time,
   * every bowl silenced, then each strike still ringing struck in closed form
   * as it stands a moment before `start`, and that moment rendered unheard.
   */
  private warmUp(start: number): void {
    const sr = this.sampleRate;
    const from = start - this.preroll;
    this.schedule = new PeriodicSchedule(this.seed, STRIKE_STREAM, this.interval, STRIKE_JITTER);
    this.period = this.interval;
    for (const bowl of this.bowls) {
      bowl.bank.silence();
    }
    this.last = -1;
    this.rubFade = this.rubTarget;
    this.frictionLow = 0;
    this.frictionBandState = 0;
    const events = this.lookback;
    this.schedule.eventsIn(from / sr - this.ringOut, from / sr, events);
    for (let e = 0; e < events.count; e++) {
      const at = Math.floor((events.times[e] ?? 0) * sr);
      this.strike(events.indices[e] ?? 0, Math.max(0, from - at));
    }
    for (let at = from; at < start;) {
      const n = Math.min(QUANTUM, start - at);
      this.process(this.unheard[0], this.unheard[1], 0, n, at);
      at += n;
    }
  }

  /** Strikes slot `n`'s bowl, as it stands `elapsed` samples after the strike. */
  private strike(n: number, elapsed: number): void {
    let bowl = pickBowl(this.seed, n, this.count);
    if (bowl === this.last && this.count > 1) {
      // Only after a live change of count: the next bowl along instead.
      bowl = (bowl + 1) % this.count;
    }
    this.last = bowl;
    const gain = strikeStrength(this.seed, n, bowl) * STRIKE_GAIN;
    this.bowls[bowl]?.bank.strike(gain, elapsed);
  }

  /** Renders `length` samples (at most a quantum) from absolute sample `start` into the outputs at `at`. */
  private process(
    left: Float32Array,
    right: Float32Array,
    at: number,
    length: number,
    start: number,
  ): void {
    const sr = this.sampleRate;
    left.fill(0, at, at + length);
    right.fill(0, at, at + length);
    const events = this.events;
    this.schedule.eventsIn(start / sr, (start + length) / sr, events);
    let done = 0;
    for (let e = 0; e < events.count; e++) {
      const offset = clamp(Math.floor((events.times[e] ?? 0) * sr) - start, done, length);
      this.renderBowls(left, right, at, done, offset);
      done = offset;
      this.strike(events.indices[e] ?? 0, 0);
    }
    this.renderBowls(left, right, at, done, length);
    if (this.rubFade > 0 || this.rubTarget > 0) {
      this.renderRub(left, right, at, length, start);
    }
    for (let i = at; i < at + length; i++) {
      left[i] = guard(left[i] ?? 0);
      right[i] = guard(right[i] ?? 0);
    }
  }

  /** Adds the ringing bowls from `from` to `to` of this quantum into the outputs at `at`. */
  private renderBowls(
    left: Float32Array,
    right: Float32Array,
    at: number,
    from: number,
    to: number,
  ): void {
    if (to <= from) {
      return;
    }
    const ring = this.ring;
    for (const bowl of this.bowls) {
      if (!bowl.bank.ringing) {
        continue;
      }
      ring.fill(0, from, to);
      bowl.bank.render(ring, from, to);
      const l = bowl.left;
      const r = bowl.right;
      for (let i = from; i < to; i++) {
        const x = ring[i] ?? 0;
        left[at + i] += l * x;
        right[at + i] += r * x;
      }
    }
  }

  /** Adds rim singing, in the centre, into the outputs at `at`. */
  private renderRub(
    left: Float32Array,
    right: Float32Array,
    at: number,
    length: number,
    start: number,
  ): void {
    const sr = this.sampleRate;
    // The drift's level, linearly through the quantum.
    const g0 = rubLevel(this.rubDrift.valueAtTime(start / sr));
    const g1 = rubLevel(this.rubDrift.valueAtTime((start + length) / sr));
    const dg = (g1 - g0) / length;
    // The sines, from their phases at absolute time, turned a sample at a time.
    const [fa, fb] = this.rubFrequencies;
    const pa = 2 * Math.PI * ((fa * start) / sr - Math.floor((fa * start) / sr));
    const pb = 2 * Math.PI * ((fb * start) / sr - Math.floor((fb * start) / sr));
    let ca = Math.cos(pa);
    let sa = Math.sin(pa);
    let cb = Math.cos(pb);
    let sb = Math.sin(pb);
    const wa = (2 * Math.PI * fa) / sr;
    const wb = (2 * Math.PI * fb) / sr;
    const cwa = Math.cos(wa);
    const swa = Math.sin(wa);
    const cwb = Math.cos(wb);
    const swb = Math.sin(wb);
    const [a1 = 0, a2 = 0, a3 = 0, k = 0] = this.frictionBand;
    let ic1 = this.frictionBandState;
    let ic2 = this.frictionLow;
    const noiseGain = this.frictionGain;
    const prefix = this.frictionPrefix;
    let fade = this.rubFade;
    const target = this.rubTarget;
    const step = this.rubStep;
    for (let i = 0; i < length; i++) {
      // The friction: white noise through the band-pass.
      const x = hashStep(prefix, start + i) * UINT32_SCALE * 2 - 1;
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      const friction = k * v1 * noiseGain;
      fade = fade < target ? Math.min(target, fade + step) : Math.max(target, fade - step);
      const y = fade * (g0 + dg * i) * (0.5 * (sa + sb) + friction);
      left[at + i] += y;
      right[at + i] += y;
      const na = sa * cwa + ca * swa;
      ca = ca * cwa - sa * swa;
      sa = na;
      const nb = sb * cwb + cb * swb;
      cb = cb * cwb - sb * swb;
      sb = nb;
    }
    this.rubFade = fade;
    this.frictionBandState = ic1;
    this.frictionLow = ic2;
  }
}
