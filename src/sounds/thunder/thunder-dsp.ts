/**
 * Distant Thunder's rumbles, and the param mappings the rest of the sound uses:
 * pure code with no Web Audio globals, run by `thunder.worklet.ts` and checked
 * in Node.
 *
 * It follows Rain's pattern for random events (`rain-dsp.ts`): rumbles start
 * from per-block hashes of absolute time, each rumble's shape and noise hash
 * from the rumble alone, params latch as a rumble starts, and a render that
 * starts afresh first picks up the rumbles already sounding. The differences:
 *
 * - **Sparse.** Rumbles come minutes apart, and the kernel does nothing but
 *   check the block between them: no noise, no filters.
 * - **Spaced.** A candidate rumble is dropped if another candidate fell within
 *   `SPACING` of the mean gap before it, so two never come in quick
 *   succession. The test looks only at candidates, never at kept rumbles, so
 *   it never recurses: any block's rumbles still come from hashes alone.
 * - **A first rumble.** One rumble always swells in 1.5–2.5 s into absolute
 *   time, so a mix that starts with thunder in it rolls in soon after Play,
 *   rather than after minutes of silence. No other rumble comes near it.
 * - **Long.** A rumble lasts up to `MAX_LENGTH`, so a fresh render looks back
 *   that far for rumbles still sounding and starts each part-way through. Its
 *   envelope and texture are closed-form functions of the time since it
 *   started, and its noise is counter-hashed, so only its filters need a short
 *   warm-up to land on the same samples as an unbroken render.
 */
import { blockOf, createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { Svf } from "../../audio/dsp/svf";
import { hash32, hashStep, UINT32_SCALE } from "../../audio/random";
import type { ThunderOften } from "./thunder.meta";

export const THUNDER_PROCESSOR = "aural-thunder";
/** The worklet's output: the rumbles, in stereo. */
export const THUNDER_CHANNELS = 2;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Random streams: candidate rumbles, and the first rumble. */
const RUMBLE_STREAM = 1;
const FIRST_STREAM = 2;

/** The mean gap between rumbles for each "how often", in seconds. */
export const MEAN_GAPS: Readonly<Record<ThunderOften, number>> = {
  rarely: 480,
  sometimes: 180,
  often: 70,
  storm: 30,
};

/** A candidate is dropped if another came within this share of the mean gap before it. */
export const SPACING = 0.35;
/**
 * Candidates per mean gap. Dropping those within `SPACING` × gap of the one
 * before keeps a share e^(−SPACING × x) of x candidates per gap; this x keeps
 * exactly one: x·e^(−0.35x) = 1.
 */
const CANDIDATES_PER_GAP = 2.047_539_475_588_782;

/** The candidates' rate, per second, for a mean gap of `gap` seconds between kept rumbles. */
export function candidateRate(gap: number): number {
  return gap > 0 ? CANDIDATES_PER_GAP / gap : 0;
}

/** When the first rumble starts, from–to, in seconds of absolute time. */
const FIRST_FROM = 1.5;
const FIRST_TO = 2.5;

/** The first rumble's start, in seconds of absolute time, for `seed`. */
export function firstRumbleTime(seed: number): number {
  return FIRST_FROM + (FIRST_TO - FIRST_FROM) * hash32(seed, FIRST_STREAM) * UINT32_SCALE;
}

/** The longest a rumble lasts, in seconds (whole seconds: a fresh render looks back this many blocks). */
export const MAX_LENGTH = 25;
/** The most rumbles a block can hold: far above any rate's. */
const BLOCK_CAPACITY = 8;

/**
 * Which rumbles start in each block: candidates from `eventsInBlock`, less
 * those too soon after another candidate or the first rumble, plus the first
 * rumble itself. Allocates nothing once made.
 */
export class RumbleSchedule {
  /** The loaded block's rumbles: start offsets within the block (seconds), and hashes. */
  readonly offsets = new Float64Array(BLOCK_CAPACITY);
  readonly hashes = new Float64Array(BLOCK_CAPACITY);
  count = 0;
  private readonly seed: number;
  private readonly first: number;
  private readonly candidates = createEventBlock(BLOCK_CAPACITY);
  private readonly scan = createEventBlock(BLOCK_CAPACITY);

  constructor(seed: number) {
    this.seed = seed;
    this.first = firstRumbleTime(seed);
  }

  /** Loads block `block`'s rumbles for a mean gap of `gap` seconds, and returns their count. */
  load(block: number, gap: number): number {
    this.count = 0;
    if (block < 0) {
      return 0;
    }
    if (Math.floor(this.first) === block) {
      this.offsets[0] = this.first - block;
      this.hashes[0] = hash32(this.seed, FIRST_STREAM, 1);
      this.count = 1;
    }
    const rate = candidateRate(gap);
    const spacing = SPACING * gap;
    eventsInBlock(this.seed, RUMBLE_STREAM, block, rate, this.candidates);
    for (let i = 0; i < this.candidates.count && this.count < BLOCK_CAPACITY; i++) {
      const offset = this.candidates.offsets[i] ?? 0;
      // Another candidate earlier in this block is within the spacing: it is
      // never under a second.
      if (
        i > 0 ||
        block + offset < this.first + spacing ||
        this.crowded(block, offset, rate, spacing)
      ) {
        continue;
      }
      this.offsets[this.count] = offset;
      this.hashes[this.count] = eventHash(this.seed, RUMBLE_STREAM, block, i);
      this.count++;
    }
    return this.count;
  }

  /** Whether a candidate in a block before `block` falls within `spacing` before `block + offset`. */
  private crowded(block: number, offset: number, rate: number, spacing: number): boolean {
    const since = block + offset - spacing;
    for (let b = block - 1; b >= 0 && b + 1 > since; b--) {
      const count = eventsInBlock(this.seed, RUMBLE_STREAM, b, rate, this.scan);
      if (count > 0 && b + (this.scan.offsets[count - 1] ?? 0) > since) {
        return true;
      }
    }
    return false;
  }
}

/** The most sub-rolls a rumble has. */
const MAX_ROLLS = 8;
/** Sub-roll onsets spread over this share of a rumble's length. */
const ONSET_SPREAD = 0.6;
/** Each sub-roll is this much quieter than the one before, in dB, give or take `ROLL_JITTER_DB`. */
const ROLL_STEP_DB = -2;
const ROLL_JITTER_DB = 3;
/**
 * A sub-roll's attack never gets shorter than this, in seconds: its rise from
 * −40 dB to −6 dB of its peak (44 % of a raised-cosine attack) stays over 150 ms.
 */
const MIN_ATTACK = 0.35;
/** A sub-roll counts as over this far below its peak (−50 dB): ln(1 / 10^(−50/20)) time constants. */
const ROLL_END_TAUS = Math.log(dbToGain(50));
/** A rumble's last second and a half fades out, so the `MAX_LENGTH` cap never cuts it. */
const TAPER = 1.5;
/** Steps when finding a rumble's peak, in seconds. */
const PEAK_STEP = 0.02;

/** The crack: from this distance up, over a band from 600 Hz to 2.5 kHz. */
export const CRACK_DISTANCE = 60;
const CRACK_CENTRE = Math.sqrt(600 * 2500);
const CRACK_Q = CRACK_CENTRE / (2500 - 600);
/**
 * It starts this long after the rumble, as its first sub-roll swells, so the
 * rumble's soft onset always comes first.
 */
const CRACK_DELAY = 0.2;
/** Its decay time constant, in seconds. */
const CRACK_DECAY = 0.3;

/** The rumble's band: a high-pass (two stages) and a low-pass, over brown-ish noise. */
const RUMBLE_HIGHPASS = 38;
const RUMBLE_Q = 0.7;
/** The brown-ish noise: white noise through a one-pole low-pass at this corner, in Hz. */
const BROWN_CORNER = 40;
/** The presence band's Q, and its level against the rumble, in dB. */
const PRESENCE_Q = 0.9;
export const PRESENCE_DB = -8;
/** The right channel's presence noise runs this far behind the left's, in seconds. */
const PRESENCE_OFFSET = 0.007;
/** The grumbling texture: a value noise on each path's gain, ±4 dB, with knots this far apart. */
const WALK_DB = 4;
const WALK_STEP = 0.08;

/** The rumble's low-pass at `distance` (0 far, 100 near), in Hz: 70 to 180. */
export function rumbleCutoff(distance: number): number {
  return 70 * (180 / 70) ** clamp01(distance / 100);
}

/** The presence band's centre at `distance`, in Hz: 160 to 450. */
export function presenceCentre(distance: number): number {
  return 160 * (450 / 160) ** clamp01(distance / 100);
}

/** The crack's level against the rumble's peak at `distance`, in dB: none below 60, −14 to −6 from there. */
export function crackDb(distance: number): number {
  return distance < CRACK_DISTANCE
    ? Number.NEGATIVE_INFINITY
    : -14 + 8 * clamp01((distance - CRACK_DISTANCE) / (100 - CRACK_DISTANCE));
}

/** The outdoor reverb send at `distance`, in dB: −14 far to −22 near. */
export function sendDb(distance: number): number {
  return -14 - 8 * clamp01(distance / 100);
}

/** Keys for a rumble's own random properties: `hashStep(hash, key)`. */
const LENGTH = 1;
const COUNT = 2;
const SIZE = 3;
const PAN = 4;
const NOISE = 5;
const CRACK_ATTACK = 6;
const WALK_RUMBLE = 7;
const WALK_PRESENCE = 8;
/** Each sub-roll's: `hashStep(hashStep(hash, ROLL + i), key)`. */
const ROLL = 100;
const ONSET = 1;
const AMPLITUDE = 2;
const ATTACK = 3;
const DECAY = 4;

const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;

/**
 * One rumble's shape, from its hash and the params it latched: its sub-rolls,
 * its crack, its colour and its place. Its envelopes are functions of the time
 * since it started (`at`), in units of each path's RMS.
 */
export class RumbleShape {
  /** The length, in seconds, and the number of sub-rolls. */
  length = 0;
  count = 0;
  /** 0.5–1: how big this rumble is. */
  size = 1;
  pan = 0;
  /** The filters' corners, in Hz. */
  cutoff = 70;
  presence = 160;
  /** The rumble envelope's peak, and the crack's peak (0: none). */
  peak = 0;
  crack = 0;
  /** `at`'s results: the rumble's and the crack's envelopes. */
  rumbleLevel = 0;
  crackLevel = 0;
  private hash = 0;
  private crackAttack = 0.06;
  private readonly onsets = new Float64Array(MAX_ROLLS);
  private readonly amplitudes = new Float64Array(MAX_ROLLS);
  private readonly attacks = new Float64Array(MAX_ROLLS);
  private readonly decays = new Float64Array(MAX_ROLLS);

  /** Shapes the rumble with hash `hash` at `distance` and `roll` (0–100). */
  build(hash: number, distance: number, roll: number): void {
    this.hash = hash;
    const near = clamp01(distance / 100);
    const r = clamp01(roll / 100);
    // Nearer storms are quicker.
    const shorten = 1 - 0.25 * near;
    const length = lerp(4 + 6 * r, 8 + 12 * r, unit(hash, LENGTH)) * shorten;
    const fewest = 2 + 3 * r;
    const most = 3 + 5 * r;
    const count = Math.min(
      MAX_ROLLS,
      Math.max(1, Math.floor(fewest + unit(hash, COUNT) * (most - fewest + 1))),
    );
    this.count = count;
    this.size = 0.5 + 0.5 * unit(hash, SIZE);
    this.pan = 0.4 * (unit(hash, PAN) * 2 - 1);
    this.cutoff = rumbleCutoff(distance);
    this.presence = presenceCentre(distance);
    let end = 0;
    for (let i = 0; i < count; i++) {
      const h = hashStep(hash, ROLL + i);
      const onset = i === 0 ? 0 : (ONSET_SPREAD * length * (i - 1 + unit(h, ONSET))) / (count - 1);
      const attack = Math.max(MIN_ATTACK, lerp(0.6, 2, unit(h, ATTACK)) * (1 - 0.6 * near));
      const decay = lerp(1.5, 4, unit(h, DECAY)) * shorten;
      this.onsets[i] = onset;
      this.amplitudes[i] = dbToGain(
        ROLL_STEP_DB * i + ROLL_JITTER_DB * (unit(h, AMPLITUDE) * 2 - 1),
      );
      this.attacks[i] = attack;
      this.decays[i] = decay;
      end = Math.max(end, onset + attack + decay * ROLL_END_TAUS);
    }
    this.length = Math.min(MAX_LENGTH, end);
    this.crack = 0;
    this.crackAttack = lerp(0.04, 0.08, unit(hash, CRACK_ATTACK));
    let peak = 0;
    for (let t = 0; t < this.length; t += PEAK_STEP) {
      this.at(t);
      peak = Math.max(peak, this.rumbleLevel);
    }
    this.peak = peak;
    const crack = crackDb(distance);
    this.crack = Number.isFinite(crack) ? dbToGain(crack) * peak : 0;
  }

  /** Sets `rumbleLevel` and `crackLevel` at `t` seconds into the rumble. */
  at(t: number): void {
    if (t < 0 || t >= this.length) {
      this.rumbleLevel = 0;
      this.crackLevel = 0;
      return;
    }
    let level = 0;
    for (let i = 0; i < this.count; i++) {
      const since = t - (this.onsets[i] ?? 0);
      if (since <= 0) {
        continue;
      }
      const attack = this.attacks[i] ?? 1;
      const amplitude = this.amplitudes[i] ?? 0;
      level +=
        since < attack
          ? amplitude * 0.5 * (1 - Math.cos((Math.PI * since) / attack))
          : amplitude * Math.exp(-(since - attack) / (this.decays[i] ?? 1));
    }
    const taper =
      t > this.length - TAPER
        ? 0.5 * (1 + Math.cos((Math.PI * (t - this.length + TAPER)) / TAPER))
        : 1;
    this.rumbleLevel = level * taper;
    let crack = 0;
    const since = t - CRACK_DELAY;
    if (this.crack > 0 && since > 0) {
      crack =
        since < this.crackAttack
          ? this.crack * 0.5 * (1 - Math.cos((Math.PI * since) / this.crackAttack))
          : this.crack * Math.exp(-(since - this.crackAttack) / CRACK_DECAY);
    }
    this.crackLevel = crack * taper;
  }

  /** The rumble path's (`presence` false) or the presence path's texture gain at `t`. */
  walk(presence: boolean, t: number): number {
    const key = hashStep(this.hash, presence ? WALK_PRESENCE : WALK_RUMBLE);
    const x = Math.max(0, t) / WALK_STEP;
    const j = Math.floor(x);
    const a = hashStep(key, j) * UINT32_SCALE * 2 - 1;
    const b = hashStep(key, j + 1) * UINT32_SCALE * 2 - 1;
    const c = 0.5 * (1 - Math.cos(Math.PI * (x - j)));
    return dbToGain(WALK_DB * (a + (b - a) * c));
  }

  /** The noise hash for this rumble's samples. */
  get noise(): number {
    return hashStep(this.hash, NOISE);
  }
}

/** Uniform noise in [−1, 1) has this variance. */
const UNIFORM_VARIANCE = 1 / 3;
/** Frequencies to integrate a filter's response over, in Hz, and steps. */
const RESPONSE_FROM = 1;
const RESPONSE_STEPS = 400;

/**
 * The RMS of uniform noise at `sampleRate` through a filter whose power
 * response is `power(f)` (analogue prototypes, close to their digital forms
 * this far below Nyquist).
 */
function noiseRms(sampleRate: number, power: (f: number) => number): number {
  const top = Math.min(sampleRate / 2, 20_000);
  const ratio = (top / RESPONSE_FROM) ** (1 / RESPONSE_STEPS);
  let sum = 0;
  let f = RESPONSE_FROM;
  let previous = power(f);
  for (let i = 0; i < RESPONSE_STEPS; i++) {
    const next = f * ratio;
    const value = power(next);
    sum += ((previous + value) / 2) * (next - f);
    previous = value;
    f = next;
  }
  return Math.sqrt((UNIFORM_VARIANCE * sum) / (sampleRate / 2));
}

const lowpassPower = (f: number, fc: number, q: number) => {
  const x = f / fc;
  return 1 / ((1 - x * x) ** 2 + (x / q) ** 2);
};
const highpassPower = (f: number, fc: number, q: number) => {
  const x = f / fc;
  return x ** 4 / ((1 - x * x) ** 2 + (x / q) ** 2);
};
const bandpassPower = (f: number, centre: number, q: number) => {
  const x = f / centre;
  return (x / q) ** 2 / ((1 - x * x) ** 2 + (x / q) ** 2);
};

/** The rumble path's RMS before its gain, at low-pass `cutoff`. */
function rumbleRms(sampleRate: number, cutoff: number): number {
  return noiseRms(
    sampleRate,
    (f) =>
      (1 / (1 + (f / BROWN_CORNER) ** 2)) *
      lowpassPower(f, cutoff, RUMBLE_Q) *
      highpassPower(f, RUMBLE_HIGHPASS, RUMBLE_Q) ** 2,
  );
}

const bandRms = (sampleRate: number, centre: number, q: number) =>
  noiseRms(sampleRate, (f) => bandpassPower(f, centre, q));

/**
 * The output's level, as a gain on each path's unit RMS at a full-size
 * rumble's envelope peak: a rumble's short-term loudness peaks about −20 LUFS
 * at the defaults.
 */
const RUMBLE_LEVEL = dbToGain(-16);
/** A rumble's predicted peak stays under this, in dBFS. */
export const PEAK_LIMIT_DB = -6;
/**
 * The peak of filtered noise against its RMS (four standard deviations), plus
 * half the texture's swing (it seldom sits at its top as the noise peaks), for
 * predicting a rumble's peak. The guard catches the rest.
 */
const CREST = 4 * dbToGain(WALK_DB / 2);
/** The guard: above the knee, a tanh curve that never passes the ceiling, in dBFS. */
const GUARD_KNEE = dbToGain(-9);
const GUARD_CEILING = dbToGain(PEAK_LIMIT_DB);

/** Values ramp linearly between control points this many samples apart. */
const CONTROL = 32;

/** One rumble sounding: its noise through the rumble, presence and crack paths. */
class RumbleVoice {
  active = false;
  /** Samples since the rumble started. */
  position = 0;
  readonly shape = new RumbleShape();
  private readonly sampleRate: number;
  private readonly offset: number;
  private end = 0;
  private noise = 0;
  private pole = 0;
  private brown = 0;
  private readonly lowpass: Svf;
  private readonly highpassA: Svf;
  private readonly highpassB: Svf;
  private readonly presenceLeft: Svf;
  private readonly presenceRight: Svf;
  private readonly crackBand: Svf;
  /** Each path's gain: scale × RMS normalisation, before the envelope. */
  private rumbleScale = 0;
  private presenceScale = 0;
  private crackScale = 0;
  private panL = 0;
  private panR = 0;
  /** The gains now, their steps per sample, and samples to the next control point. */
  private rumbleGain = 0;
  private presenceGain = 0;
  private crackGain = 0;
  private rumbleStep = 0;
  private presenceStep = 0;
  private crackStep = 0;
  /** The gains at the next control point. */
  private targetRumble = 0;
  private targetPresence = 0;
  private targetCrack = 0;
  private countdown = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.offset = Math.round(PRESENCE_OFFSET * sampleRate);
    this.pole = Math.exp((-2 * Math.PI * BROWN_CORNER) / sampleRate);
    this.lowpass = new Svf(sampleRate);
    this.highpassA = new Svf(sampleRate, RUMBLE_HIGHPASS, RUMBLE_Q);
    this.highpassB = new Svf(sampleRate, RUMBLE_HIGHPASS, RUMBLE_Q);
    this.presenceLeft = new Svf(sampleRate);
    this.presenceRight = new Svf(sampleRate);
    this.crackBand = new Svf(sampleRate, CRACK_CENTRE, CRACK_Q);
  }

  /**
   * Starts the rumble with hash `hash` at `distance` and `roll`, `elapsed`
   * samples in. Returns whether it is still sounding there.
   */
  start(hash: number, distance: number, roll: number, elapsed: number): boolean {
    const sr = this.sampleRate;
    const shape = this.shape;
    shape.build(hash, distance, roll);
    this.end = Math.floor(shape.length * sr);
    if (elapsed >= this.end) {
      this.active = false;
      return false;
    }
    this.noise = shape.noise;
    this.position = elapsed;
    this.brown = 0;
    this.lowpass.reset();
    this.lowpass.set(shape.cutoff, RUMBLE_Q);
    this.highpassA.reset();
    this.highpassB.reset();
    this.presenceLeft.reset();
    this.presenceRight.reset();
    this.presenceLeft.set(shape.presence, PRESENCE_Q);
    this.presenceRight.set(shape.presence, PRESENCE_Q);
    this.crackBand.reset();
    this.panL = panLeft(shape.pan);
    this.panR = panRight(shape.pan);

    // The scale: the level at this rumble's size, unless its predicted peak
    // would pass the limit.
    const presence = dbToGain(PRESENCE_DB);
    let loudest = 0;
    for (let t = 0; t < shape.length; t += PEAK_STEP) {
      shape.at(t);
      const both = (1 + presence * presence) * shape.rumbleLevel ** 2 + shape.crackLevel ** 2;
      loudest = Math.max(loudest, both);
    }
    const predicted = CREST * Math.sqrt(loudest) * Math.max(this.panL, this.panR);
    const scale = Math.min(
      RUMBLE_LEVEL * shape.size,
      predicted > 0 ? dbToGain(PEAK_LIMIT_DB) / predicted : 0,
    );
    this.rumbleScale = scale / rumbleRms(sr, shape.cutoff);
    this.presenceScale = (scale * presence) / bandRms(sr, shape.presence, PRESENCE_Q);
    this.crackScale = shape.crack > 0 ? scale / bandRms(sr, CRACK_CENTRE, CRACK_Q) : 0;

    // The gains on the control grid of this rumble's own samples, wherever it is picked up.
    const grid = elapsed - (elapsed % CONTROL);
    this.control(grid);
    const before = this.countdown;
    this.rumbleGain = this.targetRumble - this.rumbleStep * before;
    this.presenceGain = this.targetPresence - this.presenceStep * before;
    this.crackGain = this.targetCrack - this.crackStep * before;
    const into = elapsed - grid;
    this.rumbleGain += this.rumbleStep * into;
    this.presenceGain += this.presenceStep * into;
    this.crackGain += this.crackStep * into;
    this.countdown = CONTROL - into;
    this.active = true;
    return true;
  }

  /** Sets the gains' targets at control point `grid + CONTROL`, and steps from those at `grid`. */
  private control(grid: number): void {
    const shape = this.shape;
    const sr = this.sampleRate;
    const at = (n: number) => {
      const t = n / sr;
      shape.at(t);
      return t;
    };
    const t0 = at(grid);
    const r0 = shape.rumbleLevel * shape.walk(false, t0) * this.rumbleScale;
    const p0 = shape.rumbleLevel * shape.walk(true, t0) * this.presenceScale;
    const c0 = shape.crackLevel * this.crackScale;
    const t1 = at(grid + CONTROL);
    this.targetRumble = shape.rumbleLevel * shape.walk(false, t1) * this.rumbleScale;
    this.targetPresence = shape.rumbleLevel * shape.walk(true, t1) * this.presenceScale;
    this.targetCrack = shape.crackLevel * this.crackScale;
    this.rumbleStep = (this.targetRumble - r0) / CONTROL;
    this.presenceStep = (this.targetPresence - p0) / CONTROL;
    this.crackStep = (this.targetCrack - c0) / CONTROL;
    this.countdown = CONTROL;
  }

  /** Adds samples `from` to `to` into the outputs. Returns false once the rumble has ended. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const noise = this.noise;
    const offset = this.offset;
    const pole = this.pole;
    const lowpass = this.lowpass;
    const highpassA = this.highpassA;
    const highpassB = this.highpassB;
    const presenceLeft = this.presenceLeft;
    const presenceRight = this.presenceRight;
    const crackBand = this.crackBand;
    const panL = this.panL;
    const panR = this.panR;
    const cracks = this.crackScale > 0;
    let brown = this.brown;
    let n = this.position;
    const stop = Math.min(to, from + (this.end - n));
    for (let i = from; i < stop; i++) {
      if (this.countdown === 0) {
        // Snap to the target, so rounding never accumulates past a control point.
        this.rumbleGain = this.targetRumble;
        this.presenceGain = this.targetPresence;
        this.crackGain = this.targetCrack;
        this.control(n);
      }
      this.countdown--;
      this.rumbleGain += this.rumbleStep;
      this.presenceGain += this.presenceStep;
      const white = hashStep(noise, n) * UINT32_SCALE * 2 - 1;
      const late = hashStep(noise, n - offset) * UINT32_SCALE * 2 - 1;
      brown = white + pole * (brown - white);
      lowpass.tick(brown);
      highpassA.tick(lowpass.low);
      highpassB.tick(highpassA.high);
      presenceLeft.tick(white);
      presenceRight.tick(late);
      let mono = highpassB.high * this.rumbleGain;
      if (cracks) {
        this.crackGain += this.crackStep;
        crackBand.tick(white);
        mono += crackBand.band * this.crackGain;
      }
      left[i] += (mono + presenceLeft.band * this.presenceGain) * panL;
      right[i] += (mono + presenceRight.band * this.presenceGain) * panR;
      n++;
    }
    this.brown = brown;
    this.position = n;
    this.active = n < this.end;
    return this.active;
  }
}

/** Overlapping rumbles: three at most, even in a storm (spacing 10.5 s, 25 s long). */
const VOICES = 3;
/** Seconds rendered silently before a render that starts afresh, for the filters to settle. */
const WARM_UP = 0.2;
/** The scratch buffer the warm-up renders into, in samples. */
const SCRATCH = 128;

/**
 * The guard on the kernel's output: unchanged below the knee, then a tanh
 * curve that eases towards the ceiling and never passes it.
 */
export function guard(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= GUARD_KNEE) {
    return x;
  }
  const room = GUARD_CEILING - GUARD_KNEE;
  const y = GUARD_KNEE + room * Math.tanh((magnitude - GUARD_KNEE) / room);
  return x < 0 ? -y : y;
}

/**
 * The rumbles, in stereo, rendered from any absolute sample, the same whether
 * rendered in one go or in chunks.
 */
export class ThunderKernel {
  private readonly sampleRate: number;
  private readonly schedule: RumbleSchedule;
  private readonly voices: RumbleVoice[];
  /** For checking whether a rumble picked up part-way has already ended. */
  private readonly probe = new RumbleShape();
  /** The params `set` gave, latched as each block loads (the gap) or each rumble starts. */
  private gap = MEAN_GAPS.sometimes;
  private distance = 15;
  private roll = 50;
  private readonly warmUpSamples: number;
  private readonly scratchLeft = new Float32Array(SCRATCH);
  private readonly scratchRight = new Float32Array(SCRATCH);
  /** The block whose rumbles the schedule holds, and the next of them to start. */
  private block = Number.NaN;
  private next = 0;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.schedule = new RumbleSchedule(seed);
    this.voices = Array.from({ length: VOICES }, () => new RumbleVoice(sampleRate));
    this.warmUpSamples = Math.ceil(WARM_UP * sampleRate);
  }

  /**
   * Sets the params for the next render: `gap`, the mean gap between rumbles
   * in seconds (latched per block), and `distance` and `roll` (0–100, latched
   * per rumble).
   */
  set(gap: number, distance: number, roll: number): void {
    this.gap = gap;
    this.distance = distance;
    this.roll = roll;
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    if (start !== this.expected) {
      this.warmUp(start);
    }
    this.process(left, right, left.length, start);
    this.expected = start + left.length;
  }

  /** How many rumbles are sounding. */
  get sounding(): number {
    let count = 0;
    for (const voice of this.voices) {
      if (voice.active) {
        count++;
      }
    }
    return count;
  }

  /**
   * Picks up the rumbles that started up to `MAX_LENGTH` before the warm-up
   * and are still sounding, each part-way through, then renders the
   * `WARM_UP` before `start` silently.
   */
  private warmUp(start: number): void {
    for (const voice of this.voices) {
      voice.active = false;
    }
    const sr = this.sampleRate;
    let from = start - this.warmUpSamples;
    const first = blockOf(from, sr);
    for (let b = first - MAX_LENGTH; b < first; b++) {
      this.load(b);
      for (let i = 0; i < this.schedule.count; i++) {
        this.startRumble(i, from - this.rumbleSample(i));
      }
    }
    this.load(first);
    while (this.next < this.schedule.count && this.rumbleSample(this.next) < from) {
      this.startRumble(this.next, from - this.rumbleSample(this.next));
      this.next++;
    }
    while (from < start) {
      const length = Math.min(SCRATCH, start - from);
      this.process(this.scratchLeft, this.scratchRight, length, from);
      from += length;
    }
  }

  /** Loads block `block`'s rumbles at the current gap, which the block keeps. */
  private load(block: number): void {
    this.schedule.load(block, this.gap);
    this.block = block;
    this.next = 0;
  }

  /** The absolute sample rumble `i` of the loaded block starts at. */
  private rumbleSample(i: number): number {
    return (
      this.block * this.sampleRate + Math.floor((this.schedule.offsets[i] ?? 0) * this.sampleRate)
    );
  }

  /** Starts rumble `i` of the loaded block, `elapsed` samples in, in a free voice or the oldest. */
  private startRumble(i: number, elapsed: number): void {
    const hash = this.schedule.hashes[i] ?? 0;
    if (elapsed > 0) {
      this.probe.build(hash, this.distance, this.roll);
      if (elapsed >= Math.floor(this.probe.length * this.sampleRate)) {
        return;
      }
    }
    let voice = this.voices[0];
    for (const v of this.voices) {
      if (!v.active) {
        voice = v;
        break;
      }
      if (v.position > voice.position) {
        voice = v;
      }
    }
    voice.start(hash, this.distance, this.roll, elapsed);
  }

  /** Renders `length` samples from absolute sample `start`, overwriting the outputs. */
  private process(left: Float32Array, right: Float32Array, length: number, start: number): void {
    left.fill(0, 0, length);
    right.fill(0, 0, length);
    const sr = this.sampleRate;
    let sounded = false;
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const block = blockOf(now, sr);
      if (block !== this.block) {
        this.load(block);
      }
      while (this.next < this.schedule.count && this.rumbleSample(this.next) <= now) {
        this.startRumble(this.next, now - this.rumbleSample(this.next));
        this.next++;
      }
      let end = Math.min(length, (block + 1) * sr - start);
      if (this.next < this.schedule.count) {
        end = Math.min(end, this.rumbleSample(this.next) - start);
      }
      for (const voice of this.voices) {
        if (voice.active) {
          voice.render(left, right, pos, end);
          sounded = true;
        }
      }
      pos = end;
    }
    if (sounded) {
      for (let i = 0; i < length; i++) {
        left[i] = guard(left[i] ?? 0);
        right[i] = guard(right[i] ?? 0);
      }
    }
  }
}

interface ThunderOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readThunderOptions(raw: unknown): ThunderOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
