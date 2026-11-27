/**
 * Birdsong's birds and its air, and the param mappings the rest of the sound
 * uses: pure code with no Web Audio globals, run by `birdsong.worklet.ts` and
 * checked in Node.
 *
 * **Birds.** Up to `BIRD_SLOTS` generic songbirds, each with a profile built
 * once from the seed and its slot (so a slot's bird never depends on the
 * others): a base pitch (2.2–4.8 kHz), a pitch range (0.4–1.2 octaves), a tempo
 * (0.8–1.25), a place (distance 0.25–1.0, pan ±0.8), 3–5 preferred syllable
 * types and a repertoire of 3–6 phrase patterns built from them by a small
 * Markov chain. The first slot is always the nearest bird and the second fairly
 * near, so every seed has a bird or two to pick out.
 *
 * **Syllables** are one sine each, with an optional second harmonic for colour
 * (left out where it would pass 7.5 kHz), shaped by a smooth pitch contour and
 * a raised-cosine amplitude envelope, so nothing ever steps:
 *
 * - a **whistle** (120–400 ms) holds, rises, falls or arches, with a gentle
 *   vibrato;
 * - a **slur** (60–150 ms), the commonest, glides fast down (or up) 0.3–1 octave;
 * - a **chip** (15–40 ms) sweeps down about half an octave after a 3 ms attack;
 * - a **trill** (0.4–1.5 s) repeats 8–25 short slurs at 10–22 a second, each
 *   a little different in pitch and level;
 * - a **warble** (200–600 ms) wobbles fast (25–45 Hz) by 4–10 %, its depth
 *   drifting across it.
 *
 * Each syllable's pitch is worked out from the time since it began; only its
 * phase is accumulated, and a render that starts part-way through a syllable
 * first runs that phase silently from the syllable's start, so a chunked
 * render matches an unbroken one sample for sample.
 *
 * **Phrases.** A phrase is one of the bird's patterns (2–8 syllables with
 * 20–120 ms gaps), sung with variation: ±4 % pitch, ±8 % tempo, and a 20 %
 * chance to drop or repeat its last syllable. A bird keeps to one pattern for a
 * while (it changes every 24 s or so) and now and then sings another, so its
 * phrases recur as a real bird's do, but never exactly.
 *
 * **Schedule.** Time is cut into 1 s blocks of absolute time. In each, every
 * active bird has a candidate phrase with a probability set by the time of day
 * and the Activity, at a hashed offset. A candidate is cut short to end the
 * bird's minimum gap before its next candidate (and dropped if fewer than two
 * syllables fit), so a bird never starts a phrase while singing; and,
 * turn-taking, it is dropped with probability 0.6 if a nearer bird's candidate
 * began within the 0.8 s before it. Both rules look at candidates only, never
 * at which phrases survived, so the schedule is a pure function of time and
 * needs no history. The nearest bird always has a candidate early in the first
 * second of absolute time, so a fresh start opens with a song.
 *
 * **Latching.** A phrase latches the time of day and the Activity as it is
 * scheduled; each syllable latches the distance as it starts.
 *
 * **Placement and air.** Each bird's level falls from −4 dB (nearest) to
 * −24 dB (furthest), a low-pass from 7 kHz near to 3 kHz far softens it (on a
 * near-pure tone, applied as the 12 dB-per-octave low-pass's gain at the
 * syllable's frequency, sample by sample), and it is panned equal-power. Its
 * reverb send rises from −20 dB near to −10 dB far: the worklet writes each
 * bird's dry and reverb signals to their own stereo pair. Under the birds, a
 * faint band of air noise (300 Hz to 2 kHz) keeps the gaps from being digital
 * silence.
 */
import { sine } from "../../audio/dsp/osc";
import { OnePoleHighpass, OnePoleLowpass } from "../../audio/dsp/onepole";
import { panLeft, panRight } from "../../audio/dsp/pan";
import {
  createRng,
  HASH_START,
  hash32,
  hashStep,
  type Rng,
  UINT32_SCALE,
} from "../../audio/random";

export const BIRDSONG_PROCESSOR = "aural-birdsong";
/** The worklet's output: the dry stereo mix, then the reverb send's stereo mix. */
export const BIRDSONG_CHANNELS = 4;
/** The most birds: the dawn chorus's most. */
export const BIRD_SLOTS = 8;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Evenly in log from `a` to `b`. */
const logLerp = (a: number, b: number, t: number) => a * (b / a) ** t;

/** Random streams: the birds' profiles, their schedules and phrases, the air. */
const PROFILE_STREAM = 1;
const SCHEDULE_STREAM = 2;
const PATTERN_STREAM = 3;
const COUNT_STREAM = 4;
const FIRST_STREAM = 5;
const AIR_STREAM = 9;

/** Keys for a candidate's own random choices: `hashStep(candidate, key)`. */
const OFFSET = 1;
const TURN = 2;
const PATTERN = 3;
const PITCH = 4;
const TEMPO = 5;
const ENDING = 6;
const CALL = 7;

/** Syllable types, the alphabet a bird's phrases are built from. */
export const WHISTLE = 0;
export const SLUR = 1;
export const CHIP = 2;
export const TRILL = 3;
export const WARBLE = 4;
export const SYLLABLE_TYPES = [WHISTLE, SLUR, CHIP, TRILL, WARBLE] as const;

/** How likely each type is in a bird's chain, before its own taste: slurs are the commonest. */
const TYPE_WEIGHT = [1, 1.6, 1, 0.5, 0.6];
/** How much more likely each type is to follow itself: chips come in runs, trills never. */
const TYPE_SELF = [0.6, 1.4, 2.5, 0, 0.5];
/** The chance a syllable that follows its own type repeats the one before exactly. */
const REPEAT_SYLLABLE = 0.7;

/** Syllables in a phrase. */
export const FEWEST_SYLLABLES = 2;
export const MOST_SYLLABLES = 8;
/** A pattern's nominal length stays under this, in seconds, gaps included. */
const LONGEST_PATTERN = 3;
/** A sung phrase never lasts longer than this, in seconds, so look-back finds every one. */
export const LONGEST_PHRASE = 4.6;
/** Blocks a restart looks back for a phrase still sounding. */
const LOOKBACK = 6;

/** Every syllable's pitch stays within these, in Hz, after all its variation. */
export const LOWEST_PITCH = 1500;
export const HIGHEST_PITCH = 7500;
/** Syllables are fitted inside these, leaving room for a phrase's ±4 % and a trill's ±3 %. */
const FIT_LOW = 1600;
const FIT_HIGH = 7000;
/** A phrase's pitch and tempo vary by these fractions either way. */
const PHRASE_PITCH = 0.04;
const PHRASE_TEMPO = 0.08;
/** The chances a phrase drops its last syllable, and that it repeats it. */
const DROP_LAST = 0.1;
const REPEAT_LAST = 0.1;

/** A trill's notes sound for this share of their period. */
const TRILL_DUTY = 0.7;
/** A trill's notes vary by this fraction either way, in pitch and level. */
const TRILL_SPREAD = 0.03;
/** A chip's attack, in seconds. */
const CHIP_ATTACK = 0.003;
/** A whistle's vibrato depth, as a fraction of its pitch. */
const VIBRATO = 0.01;

/** A bird keeps mostly to one pattern for runs of this many blocks. */
const RUN_BLOCKS = 24;
/** The chance a phrase is the run's pattern rather than any other. */
const RUN_SHARE = 0.75;

/** Turn-taking: a nearer bird's candidate this recently (s) silences a candidate with this chance. */
const TURN_WINDOW = 0.8;
const TURN_CHANCE = 0.6;
/** A bird's candidate chance per block never passes this, so even the busiest has gaps. */
const MOST_LIKELY = 0.9;
/** The candidate chances tried when meeting a target rate. */
const CHANCE_STEPS = 90;

/** The chance that the difference of two uniform offsets in [0, 1) is below `x`. */
function triangular(x: number): number {
  if (x <= -1) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return x <= 0 ? ((1 + x) * (1 + x)) / 2 : 1 - ((1 - x) * (1 - x)) / 2;
}

/**
 * The chance that a candidate's opening and minimum gap, `w` seconds, fit
 * before the bird's next candidate, when each block has one with chance `p`.
 */
function fitSurvival(p: number, w: number): number {
  let soon = 0;
  let none = 1;
  for (let j = 1; j <= Math.ceil(w) + 1; j++) {
    soon += none * p * triangular(w - j);
    none *= 1 - p;
  }
  return 1 - soon;
}

/** The nearest bird's first candidate falls between these, in seconds of absolute time. */
const FIRST_FROM = 0.15;
const FIRST_TO = 0.6;

/** What each time of day sets. */
interface TimeOfDay {
  /** Active birds: from–to, by the seed. */
  fewest: number;
  most: number;
  /** A bird's mean gap between phrases, in seconds: from–to, by the bird. */
  gapFrom: number;
  gapTo: number;
  /** Pushes every bird this share of the way to the farthest. */
  push: number;
  /** The chance a phrase is only a short call: its first 2–3 syllables. */
  calls: number;
  /** Scales every bird's minimum gap between phrases: a dawn chorus hardly pauses. */
  restScale: number;
}

/** Dawn chorus, morning and daytime, in the order of the worklet's `time` param. */
export const TIMES_OF_DAY: readonly TimeOfDay[] = [
  { fewest: 6, most: 8, gapFrom: 1.5, gapTo: 4, push: 0, calls: 0, restScale: 0.5 },
  { fewest: 4, most: 5, gapFrom: 4, gapTo: 9, push: 0, calls: 0.15, restScale: 1 },
  { fewest: 2, most: 3, gapFrom: 8, gapTo: 25, push: 0.35, calls: 0.5, restScale: 1 },
];

/** How many birds sing at time of day `time` (an index into `TIMES_OF_DAY`) for `seed`. */
export function activeBirds(seed: number, time: number): number {
  const tod = TIMES_OF_DAY[clamp(Math.round(time), 0, TIMES_OF_DAY.length - 1)];
  const u = hash32(seed, COUNT_STREAM, time) * UINT32_SCALE;
  return tod.fewest + Math.floor(u * (tod.most - tod.fewest + 1));
}

/**
 * How much more often every bird sings at Activity `density` (0–100): 1 at 50,
 * a quarter at 0 and two and a half times at 100, evenly in log each side.
 */
export function activityFactor(density: number): number {
  const d = clamp(density, 0, 100);
  return d < 50 ? 0.25 ** ((50 - d) / 50) : 2.5 ** ((d - 50) / 50);
}

/**
 * How far away a bird `own` away seems at the Distance param `distance`
 * (0–100): pushed up to 80 % of the way to the farthest, with the square of
 * the param, so the birds stay close a little way back.
 */
export function effectiveDistance(own: number, distance: number): number {
  return own + (1 - own) * 0.8 * clamp01(distance / 100) ** 2;
}

/** Where distance `d` (0.25–1) falls between the nearest and the farthest, 0–1. */
const farness = (d: number) => clamp01((d - 0.25) / 0.75);

/** A bird's level at distance `d`, in dB: −4 near to −24 far. */
export function birdDb(d: number): number {
  return -4 - 20 * farness(d);
}

/** The air's softening at distance `d`: a low-pass from 7 kHz near to 3 kHz far, in Hz. */
export function airCutoff(d: number): number {
  return logLerp(7000, 3000, farness(d));
}

/** A bird's reverb send at distance `d`, in dB against its dry level: −20 near to −10 far. */
export function sendDb(d: number): number {
  return -20 + 10 * farness(d);
}

/**
 * A bird's peak at 0 dB on its distance scale, before its pan: the level
 * everything else is set against. The nearest bird at Distance 0 peaks about
 * 10 dB under full scale, and the defaults sit near −23 LUFS.
 */
const BIRD_PEAK = dbToGain(-7);
/** The air's RMS level, in dBFS per channel. */
const AIR_DB = -40;
/** The air's band: a high-pass, then two low-passes, all one-pole, in Hz. */
const AIR_HIGHPASS = 300;
const AIR_LOWPASS = 2000;

/** The standard deviation of white noise uniform in [−1, 1). */
const UNIFORM_SD = 1 / Math.sqrt(3);

/** One syllable of a bird's pattern, at tempo 1 and before a phrase's pitch. */
export interface Syllable {
  type: number;
  /** How long it lasts, in seconds. */
  length: number;
  /** Its pitch at the start and at the end, in Hz; an arching whistle peaks at `to` and ends at `from`. */
  from: number;
  to: number;
  arch: boolean;
  /** A whistle's vibrato, a trill's notes or a warble's wobble, a second. */
  rate: number;
  /** A whistle's vibrato depth, or a warble's depth at its start and its end, as fractions. */
  depth: number;
  depthEnd: number;
  /** A trill's notes, and each note's pitch and level factors. */
  notes: number;
  notePitch: Float64Array;
  noteLevel: Float64Array;
  /** The second harmonic's level against the first, 0 when it would sit too high. */
  harmonic: number;
  /** The silence after it in a phrase, in seconds. */
  gap: number;
  /** The lowest and highest its pitch goes, in Hz. */
  low: number;
  high: number;
}

/** A bird's voice and character, fixed by the seed and its slot. */
interface BirdProfile {
  /** Its base pitch, in Hz: 2.2–4.8 kHz. */
  pitch: number;
  /** How far its syllables spread around the base, in octaves: 0.4–1.2. */
  range: number;
  /** How fast it sings: 0.8–1.25. */
  tempo: number;
  /** The syllable types it uses: 3–5. */
  types: readonly number[];
  /** Its phrase patterns: 3–6. */
  repertoire: readonly (readonly Syllable[])[];
  /** How far away it is, 0.25–1.0, before the time of day and the Distance param. */
  distance: number;
  /** Its place in the stereo field, −0.8 to 0.8. */
  pan: number;
  /** Where its mean gap between phrases falls in the time of day's range, 0–1. */
  gap: number;
  /** The least silence it leaves between phrases, in seconds: 0.3–0.7. */
  minGap: number;
}

/** The pitch's lowest and highest across `s`, in Hz. */
function extent(s: Syllable): void {
  const lo = Math.min(s.from, s.to);
  const hi = Math.max(s.from, s.to);
  switch (s.type) {
    case WHISTLE:
      s.low = lo * (1 - s.depth);
      s.high = hi * (1 + s.depth);
      return;
    case TRILL: {
      let a = Number.POSITIVE_INFINITY;
      let b = 0;
      for (let j = 0; j < s.notes; j++) {
        const v = s.notePitch[j] ?? 1;
        a = Math.min(a, lo * v);
        b = Math.max(b, hi * v);
      }
      s.low = a;
      s.high = b;
      return;
    }
    case WARBLE: {
      const deepest = Math.max(s.depth, s.depthEnd);
      s.low = lo * (1 - deepest);
      s.high = hi * (1 + deepest);
      return;
    }
    default:
      s.low = lo;
      s.high = hi;
  }
}

/** A glide of `octaves` around `centre`: down (or up, if `up`). */
function glide(s: Syllable, centre: number, octaves: number, up: boolean): void {
  const top = centre * 2 ** (octaves / 2);
  const bottom = centre * 2 ** (-octaves / 2);
  s.from = up ? bottom : top;
  s.to = up ? top : bottom;
}

/** A new syllable of `type` for a bird with this base pitch and range. */
export function makeSyllable(rng: Rng, type: number, pitch: number, range: number): Syllable {
  const centre = pitch * 2 ** (range * (rng.next() - 0.5));
  const s: Syllable = {
    type,
    length: 0.1,
    from: centre,
    to: centre,
    arch: false,
    rate: 0,
    depth: 0,
    depthEnd: 0,
    notes: 0,
    notePitch: new Float64Array(0),
    noteLevel: new Float64Array(0),
    harmonic: 0,
    gap: 0,
    low: centre,
    high: centre,
  };
  switch (type) {
    case WHISTLE: {
      s.length = rng.range(0.12, 0.4);
      const shape = rng.int(4);
      if (shape === 0) {
        // Held, with only a slight drift.
        s.to = centre * 2 ** rng.range(-0.05, 0.05);
      } else {
        glide(s, centre, rng.range(0.1, 0.6), shape !== 2);
        s.arch = shape === 3;
      }
      s.rate = rng.range(5, 8);
      s.depth = VIBRATO;
      break;
    }
    case SLUR:
      s.length = rng.range(0.06, 0.15);
      glide(s, centre, rng.range(0.3, 1), rng.next() < 0.25);
      break;
    case CHIP:
      s.length = rng.range(0.015, 0.04);
      glide(s, centre, rng.range(0.4, 0.6), false);
      break;
    case TRILL: {
      s.rate = rng.range(10, 22);
      s.notes = clamp(Math.round(s.rate * rng.range(0.4, 1.5)), 8, 25);
      s.length = (s.notes - 1 + TRILL_DUTY) / s.rate;
      glide(s, centre, rng.range(0.15, 0.5), rng.next() < 0.2);
      // The notes drift a little across the trill, each a little different.
      const drift = rng.range(-0.2, 0.2);
      s.notePitch = new Float64Array(s.notes);
      s.noteLevel = new Float64Array(s.notes);
      for (let j = 0; j < s.notes; j++) {
        s.notePitch[j] = 2 ** ((drift * j) / (s.notes - 1)) * (1 + TRILL_SPREAD * rng.range(-1, 1));
        s.noteLevel[j] = 1 + TRILL_SPREAD * rng.range(-1, 1);
      }
      break;
    }
    default: {
      s.length = rng.range(0.2, 0.6);
      s.from = centre * 2 ** rng.range(-0.15, 0.15);
      s.to = centre * 2 ** rng.range(-0.15, 0.15);
      s.rate = rng.range(25, 45);
      s.depth = rng.range(0.04, 0.1);
      s.depthEnd = rng.range(0.04, 0.1);
    }
  }
  s.gap = rng.range(0.02, 0.12);
  const harmonicDb = rng.range(-26, -18);
  // Fit the syllable inside the band, keeping its shape.
  extent(s);
  const fit = s.high > FIT_HIGH ? FIT_HIGH / s.high : s.low < FIT_LOW ? FIT_LOW / s.low : 1;
  s.from *= fit;
  s.to *= fit;
  extent(s);
  s.harmonic = 2 * s.high * (1 + PHRASE_PITCH) <= HIGHEST_PITCH ? dbToGain(harmonicDb) : 0;
  return s;
}

/** Picks an index from `weights` (not all zero) with `u` in [0, 1). */
function pick(weights: readonly number[], u: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = u * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i] ?? 0;
    if (x < 0) {
      return i;
    }
  }
  return weights.length - 1;
}

/**
 * A phrase pattern from a bird's chain: `weights` for the first syllable's type
 * (one per type in `types`) and `chain[a]` for the one after a syllable of type
 * `types[a]`. At most one trill, and its nominal length under `LONGEST_PATTERN`.
 */
function makePattern(
  rng: Rng,
  types: readonly number[],
  weights: readonly number[],
  chain: readonly (readonly number[])[],
  pitch: number,
  range: number,
): Syllable[] {
  const count = FEWEST_SYLLABLES + rng.int(MOST_SYLLABLES - FEWEST_SYLLABLES + 1);
  const pattern: Syllable[] = [];
  let state = pick(weights, rng.next());
  let total = 0;
  let trilled = false;
  while (pattern.length < count) {
    let type = types[state] ?? SLUR;
    if (type === TRILL && trilled) {
      state = types.findIndex((t) => t !== TRILL);
      type = types[state] ?? SLUR;
    }
    const last = pattern.at(-1);
    const s =
      last?.type === type && rng.next() < REPEAT_SYLLABLE
        ? last
        : makeSyllable(rng, type, pitch, range);
    if (pattern.length >= FEWEST_SYLLABLES && total + s.length + s.gap > LONGEST_PATTERN) {
      break;
    }
    pattern.push(s);
    total += s.length + s.gap;
    trilled ||= type === TRILL;
    state = pick(chain[state] ?? weights, rng.next());
  }
  return pattern;
}

/**
 * Bird `slot`'s profile for `seed`. The first sits close and the second fairly
 * close; the rest anywhere from near to far. The first is never far to one
 * side, and no near one sits beyond ±0.5.
 */
export function birdProfile(seed: number, slot: number): BirdProfile {
  const rng = createRng(hash32(seed, PROFILE_STREAM, slot));
  const pitch = rng.range(2200, 4800);
  const range = rng.range(0.4, 1.2);
  const tempo = rng.range(0.8, 1.25);
  const distance =
    slot === 0 ? rng.range(0.25, 0.35) : slot === 1 ? rng.range(0.35, 0.6) : rng.range(0.35, 1);
  const widest = slot === 0 ? 0.3 : distance < 0.5 ? 0.5 : 0.8;
  const pan = rng.range(-1, 1) * widest;

  // Its preferred types: 3–5 of the five, always with slurs, the commonest.
  const shuffled: number[] = [...SYLLABLE_TYPES];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j] ?? 0, shuffled[i] ?? 0];
  }
  const types = shuffled.slice(0, 3 + rng.int(3));
  if (!types.includes(SLUR)) {
    types[types.length - 1] = SLUR;
  }
  const weights = types.map((t) => (TYPE_WEIGHT[t] ?? 1) * rng.range(0.5, 1.5));
  const chain = types.map((a) =>
    types.map((b, i) => (weights[i] ?? 0) * (a === b ? (TYPE_SELF[a] ?? 1) : 1)),
  );
  const repertoire = Array.from({ length: 3 + rng.int(4) }, () =>
    makePattern(rng, types, weights, chain, pitch, range),
  );
  return {
    pitch,
    range,
    tempo,
    types,
    repertoire,
    distance,
    pan,
    gap: rng.next(),
    minGap: rng.range(0.3, 0.7),
  };
}

/** A pattern's nominal length, in seconds: its syllables and the gaps between them. */
const patternLength = (pattern: readonly Syllable[]) =>
  pattern.reduce((sum, s) => sum + s.length + s.gap, 0) - (pattern.at(-1)?.gap ?? 0);

/** The raised-cosine rise from 0 to 1 as `u` goes from 0 to 1. */
const rise = (u: number) => 0.5 - 0.5 * sine(u * 0.5 + 0.25);

/** An envelope over `x` in [0, 1]: raised-cosine attack over `a`, release over `r`, 0 outside. */
function envelope(x: number, a: number, r: number): number {
  if (x <= 0 || x >= 1) {
    return 0;
  }
  if (x < a) {
    return rise(x / a);
  }
  if (x > 1 - r) {
    return rise((1 - x) / r);
  }
  return 1;
}

/** A syllable's pitch and amplitude at a moment: see `at`. */
export class Contour {
  /** The pitch, in Hz. */
  frequency = 0;
  /** The amplitude, 0–1 (a trill's notes up to 1.03). */
  amplitude = 0;
  /** Which of a trill's notes it is in (0 for other types): a new note starts its phase afresh. */
  note = 0;

  /**
   * Works out syllable `s`, sung at `pitch` times its pitch and `tempo` times
   * its speed, `tau` seconds after it began.
   */
  at(s: Syllable, pitch: number, tempo: number, tau: number): void {
    const x = (tau * tempo) / s.length;
    this.note = 0;
    switch (s.type) {
      case WHISTLE: {
        const g = s.arch ? sine(clamp01(x) * 0.5) : x * x * (3 - 2 * x);
        this.frequency =
          pitch * (s.from + (s.to - s.from) * g) * (1 + s.depth * sine(s.rate * tau));
        this.amplitude = envelope(x, 0.2, 0.3);
        return;
      }
      case SLUR: {
        const y = 1 - clamp01(x);
        this.frequency = pitch * (s.from + (s.to - s.from) * (1 - y * y));
        this.amplitude = envelope(x, 0.15, 0.35);
        return;
      }
      case CHIP: {
        const y = 1 - clamp01(x);
        this.frequency = pitch * (s.from + (s.to - s.from) * (1 - y * y * y));
        const a = (CHIP_ATTACK * tempo) / s.length;
        this.amplitude = envelope(x, a, 1 - a);
        return;
      }
      case TRILL: {
        const rate = s.rate * tempo;
        const j = clamp(Math.floor(tau * rate), 0, s.notes - 1);
        const into = (tau * rate - j) / TRILL_DUTY;
        const y = 1 - clamp01(into);
        this.note = j;
        this.frequency = pitch * (s.notePitch[j] ?? 1) * (s.from + (s.to - s.from) * (1 - y * y));
        this.amplitude = (s.noteLevel[j] ?? 1) * envelope(into, 0.2, 0.4);
        return;
      }
      default: {
        const c = clamp01(x);
        const depth = s.depth + (s.depthEnd - s.depth) * c;
        this.frequency = pitch * (s.from + (s.to - s.from) * c) * (1 + depth * sine(s.rate * tau));
        this.amplitude = envelope(x, 0.2, 0.3);
      }
    }
  }
}

/** A phrase as sung: its syllables and where each falls, in absolute samples. */
export class Phrase {
  count = 0;
  readonly syllables: Syllable[] = [];
  readonly starts = new Float64Array(MOST_SYLLABLES);
  readonly lengths = new Float64Array(MOST_SYLLABLES);
  /** The phrase's pitch and tempo factors. */
  pitch = 1;
  tempo = 1;
  /** The bird's distance before the Distance param, at the phrase's time of day. */
  distance = 0;

  /** The absolute sample just after its last syllable. */
  get end(): number {
    const last = this.count - 1;
    return last < 0 ? 0 : (this.starts[last] ?? 0) + (this.lengths[last] ?? 0);
  }
}

/** The params the schedule and the voices latch from: see `BirdsongGenerator.set`. */
interface Latched {
  time: number;
  density: number;
  distance: number;
}

/**
 * Every bird's schedule of phrases: which candidates survive and what each
 * sings, at the latched time of day and Activity. Pure but for its params.
 */
export class Schedule {
  readonly profiles: readonly BirdProfile[];
  private readonly seed: number;
  private readonly sampleRate: number;
  private readonly prefixes: Uint32Array;
  private readonly runPrefixes: Uint32Array;
  /** Each bird's mean phrase length at tempo 1. */
  private readonly meanLength: Float64Array;
  /** Each of a bird's patterns' first two syllables at its tempo: with its minimum gap, what must fit. */
  private readonly openings: readonly Float64Array[];
  /** Each bird's candidate chance per block, and the active birds nearer than it. */
  readonly chance = new Float64Array(BIRD_SLOTS);
  private readonly nearer: Int8Array[];
  private readonly nearerCount = new Int32Array(BIRD_SLOTS);
  private readonly first: number;
  time = -1;
  density = -1;
  active = 0;

  constructor(seed: number, sampleRate: number) {
    this.seed = seed;
    this.sampleRate = sampleRate;
    this.profiles = Array.from({ length: BIRD_SLOTS }, (_, i) => birdProfile(seed, i));
    const base = hashStep(hashStep(HASH_START, seed), SCHEDULE_STREAM);
    const runs = hashStep(hashStep(HASH_START, seed), PATTERN_STREAM);
    this.prefixes = Uint32Array.from(this.profiles, (_, i) => hashStep(base, i));
    this.runPrefixes = Uint32Array.from(this.profiles, (_, i) => hashStep(runs, i));
    this.meanLength = Float64Array.from(this.profiles, (p) => {
      const sum = p.repertoire.reduce((a, pattern) => a + patternLength(pattern), 0);
      return sum / p.repertoire.length;
    });
    this.openings = this.profiles.map((p) =>
      Float64Array.from(
        p.repertoire,
        (pattern) => patternLength(pattern.slice(0, FEWEST_SYLLABLES)) / p.tempo,
      ),
    );
    this.nearer = this.profiles.map(() => new Int8Array(BIRD_SLOTS));
    this.first = lerp(FIRST_FROM, FIRST_TO, hash32(seed, FIRST_STREAM) * UINT32_SCALE);
  }

  /**
   * Latches time of day `time` (an index into `TIMES_OF_DAY`) and Activity
   * `density` (0–100) for the phrases scheduled from now on.
   */
  set(time: number, density: number): void {
    const t = clamp(Math.round(time), 0, TIMES_OF_DAY.length - 1);
    if (t === this.time && density === this.density) {
      return;
    }
    this.time = t;
    this.density = density;
    this.active = activeBirds(this.seed, t);
    const target = this.targets(t, density);
    // Nearest first, so each bird's turn-taking sees its nearer birds' chances.
    const order = Array.from({ length: this.active }, (_, i) => i).toSorted(
      (a, b) => (this.profiles[a]?.distance ?? 0) - (this.profiles[b]?.distance ?? 0),
    );
    this.chance.fill(0);
    let quiet = 1;
    for (let n = 0; n < order.length; n++) {
      const b = order[n] ?? 0;
      const nearer = this.nearer[b];
      for (let m = 0; m < n; m++) {
        nearer[m] = order[m] ?? 0;
      }
      this.nearerCount[b] = n;
      // A candidate survives turn-taking (`quiet`: no nearer candidate in the
      // window) and the fit: take the least chance that meets the target, or
      // the one that comes closest.
      const turn = 1 - TURN_CHANCE * (1 - quiet);
      const openings = this.openings[b];
      const minGap = this.minGap(b);
      let best = 0;
      let bestRate = 0;
      for (let step = 1; step <= CHANCE_STEPS; step++) {
        const p = (MOST_LIKELY * step) / CHANCE_STEPS;
        let fit = 0;
        for (const w of openings) {
          fit += fitSurvival(p, w + minGap);
        }
        const rate = (p * turn * fit) / openings.length;
        if (rate > bestRate) {
          best = p;
          bestRate = rate;
        }
        if (rate >= (target[b] ?? 0)) {
          break;
        }
      }
      this.chance[b] = best;
      quiet *= 1 - TURN_WINDOW * best;
    }
  }

  /**
   * Each bird's target phrase rate (phrases a second) at time of day `time`
   * and Activity `density`: the Activity's factor over its mean phrase length
   * plus its mean gap. Inactive birds' are 0.
   */
  targets(time: number, density: number): Float64Array {
    const t = clamp(Math.round(time), 0, TIMES_OF_DAY.length - 1);
    const tod = TIMES_OF_DAY[t];
    const active = activeBirds(this.seed, t);
    const out = new Float64Array(BIRD_SLOTS);
    for (let b = 0; b < active; b++) {
      const p = this.profiles[b];
      const gap = logLerp(tod.gapFrom, tod.gapTo, p.gap);
      out[b] = activityFactor(density) / ((this.meanLength[b] ?? 1) / p.tempo + gap);
    }
    return out;
  }

  /** Bird `b`'s least silence between phrases at the latched time of day, in seconds. */
  private minGap(b: number): number {
    return (this.profiles[b]?.minGap ?? 0) * (TIMES_OF_DAY[this.time]?.restScale ?? 1);
  }

  /** Bird `b`'s candidate in block `k`, in absolute seconds, or NaN if it has none. */
  candidateTime(b: number, k: number): number {
    if (b === 0 && k === 0) {
      return this.first;
    }
    const h = hashStep(this.prefixes[b] ?? 0, k);
    if (h * UINT32_SCALE >= (this.chance[b] ?? 0)) {
      return Number.NaN;
    }
    return k + hashStep(h, OFFSET) * UINT32_SCALE;
  }

  /** Whether an active bird nearer than bird `b` has a candidate in the `TURN_WINDOW` before `t`, in block `k`. */
  private nearerJustBefore(b: number, k: number, t: number): boolean {
    const nearer = this.nearer[b];
    for (let m = 0; m < (this.nearerCount[b] ?? 0); m++) {
      const n = nearer[m] ?? 0;
      for (let kk = Math.floor(t - TURN_WINDOW); kk <= k; kk++) {
        const tn = this.candidateTime(n, kk);
        if (tn >= t - TURN_WINDOW && tn < t) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Fills `out` with what bird `b` sings for its candidate in block `k`, at
   * absolute time `t`, and returns whether it sings at all.
   */
  phrase(b: number, k: number, t: number, out: Phrase): boolean {
    out.count = 0;
    const profile = this.profiles[b];
    const h = hashStep(hashStep(this.prefixes[b] ?? 0, k), -1);
    const u = (key: number) => hashStep(h, key) * UINT32_SCALE;

    // Turn-taking: a nearer bird's candidate just before.
    if (this.nearerJustBefore(b, k, t) && u(TURN) < TURN_CHANCE) {
      return false;
    }

    // The pattern: mostly this run's, sometimes any.
    const repertoire = profile.repertoire;
    const run = hashStep(this.runPrefixes[b] ?? 0, Math.floor(k / RUN_BLOCKS)) * UINT32_SCALE;
    const choice = u(PATTERN);
    const index =
      choice < RUN_SHARE
        ? Math.floor(run * repertoire.length)
        : Math.floor(((choice - RUN_SHARE) / (1 - RUN_SHARE)) * repertoire.length);
    const pattern = repertoire[clamp(index, 0, repertoire.length - 1)] ?? [];

    let count = pattern.length;
    const ending = u(ENDING);
    const repeat =
      ending >= DROP_LAST && ending < DROP_LAST + REPEAT_LAST && count < MOST_SYLLABLES;
    if (ending < DROP_LAST && count > FEWEST_SYLLABLES) {
      count--;
    }
    const tod = TIMES_OF_DAY[this.time] ?? TIMES_OF_DAY[1];
    const call = u(CALL);
    if (call < tod.calls) {
      count = Math.min(count, FEWEST_SYLLABLES + Math.floor((call / tod.calls) * 2));
    }

    const tempo = profile.tempo * (1 + PHRASE_TEMPO * (2 * u(TEMPO) - 1));
    out.pitch = 1 + PHRASE_PITCH * (2 * u(PITCH) - 1);
    out.tempo = tempo;
    out.distance = profile.distance + (1 - profile.distance) * tod.push;

    // End the bird's minimum gap before its next candidate.
    let limit = t + LONGEST_PHRASE;
    for (let kk = k + 1; kk <= k + LOOKBACK; kk++) {
      const next = this.candidateTime(b, kk);
      if (!Number.isNaN(next)) {
        limit = Math.min(limit, next - this.minGap(b));
        break;
      }
    }

    const sr = this.sampleRate;
    const start = Math.ceil(t * sr);
    let offset = 0;
    const total = repeat ? count + 1 : count;
    for (let i = 0; i < total; i++) {
      const s = pattern[Math.min(i, count - 1)];
      const length = s.length / tempo;
      if (t + offset + length > limit) {
        break;
      }
      out.syllables[i] = s;
      out.starts[i] = start + Math.round(offset * sr);
      out.lengths[i] = Math.max(1, Math.round(length * sr));
      out.count = i + 1;
      offset += length + s.gap / tempo;
    }
    if (out.count < FEWEST_SYLLABLES) {
      out.count = 0;
      return false;
    }
    return true;
  }
}

/** One bird's voice: the phrase it is singing and where it has got to. */
class Voice {
  readonly phrase = new Phrase();
  active = false;
  /** The syllable it is on, its phase (in cycles) and which of a trill's notes. */
  index = 0;
  phase = 0;
  note = -1;
  /** Whether the syllable's gains are set: each syllable latches the distance as it starts. */
  latched = false;
  dryLeft = 0;
  dryRight = 0;
  wetLeft = 0;
  wetRight = 0;
  /** 1 / the air's cutoff, in 1/Hz. */
  inverseCutoff = 0;

  begin(): void {
    this.active = this.phrase.count > 0;
    this.index = 0;
    this.phase = 0;
    this.note = -1;
    this.latched = false;
  }

  /** Moves on to the next syllable. */
  next(): void {
    this.index++;
    this.phase = 0;
    this.note = -1;
    this.latched = false;
    if (this.index >= this.phrase.count) {
      this.active = false;
    }
  }

  /** Sets the syllable's gains for a bird panned to `pan`, at the Distance param `distance`. */
  latch(pan: number, distance: number): void {
    const d = effectiveDistance(this.phrase.distance, distance);
    const gain = BIRD_PEAK * dbToGain(birdDb(d));
    const wet = dbToGain(sendDb(d));
    this.dryLeft = gain * panLeft(pan);
    this.dryRight = gain * panRight(pan);
    this.wetLeft = this.dryLeft * wet;
    this.wetRight = this.dryRight * wet;
    this.inverseCutoff = 1 / airCutoff(d);
    this.latched = true;
  }
}

interface BirdsongOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readBirdsongOptions(raw: unknown): BirdsongOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}

/**
 * Everything the birdsong worklet makes: the birds, dry and to the reverb,
 * and the air under them, from absolute samples, so time-addressable at fixed
 * params.
 */
export class BirdsongGenerator {
  readonly schedule: Schedule;
  private readonly sampleRate: number;
  private readonly voices: readonly Voice[];
  private readonly contour = new Contour();
  private readonly params: Latched = { time: 1, density: 50, distance: 40 };
  private readonly airPrefixes: Uint32Array;
  private readonly airHighpasses: readonly OnePoleHighpass[];
  private readonly airLowpasses: readonly (readonly [OnePoleLowpass, OnePoleLowpass])[];
  private readonly airGain: number;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.schedule = new Schedule(seed, sampleRate);
    this.voices = Array.from({ length: BIRD_SLOTS }, () => new Voice());
    const base = hashStep(hashStep(HASH_START, seed), AIR_STREAM);
    this.airPrefixes = Uint32Array.of(hashStep(base, 0), hashStep(base, 1));
    this.airHighpasses = [0, 1].map(() => new OnePoleHighpass(sampleRate, AIR_HIGHPASS));
    this.airLowpasses = [0, 1].map(
      () =>
        [
          new OnePoleLowpass(sampleRate, AIR_LOWPASS),
          new OnePoleLowpass(sampleRate, AIR_LOWPASS),
        ] as const,
    );
    // Normalise from the band's impulse response energy, so the level is the same at any rate.
    const hp = new OnePoleHighpass(sampleRate, AIR_HIGHPASS);
    const lp1 = new OnePoleLowpass(sampleRate, AIR_LOWPASS);
    const lp2 = new OnePoleLowpass(sampleRate, AIR_LOWPASS);
    let energy = 0;
    for (let i = 0; i < sampleRate * 0.1; i++) {
      const y = lp2.process(lp1.process(hp.process(i === 0 ? 1 : 0)));
      energy += y * y;
    }
    this.airGain = dbToGain(AIR_DB) / (UNIFORM_SD * Math.sqrt(energy));
    this.set(1, 50, 40);
  }

  /**
   * Sets the params for the next render: time of day `time` (an index into
   * `TIMES_OF_DAY`) and Activity `density` (0–100), which each phrase latches
   * as it is scheduled, and the Distance `distance` (0–100), which each
   * syllable latches as it starts.
   */
  set(time: number, density: number, distance: number): void {
    this.params.time = time;
    this.params.density = density;
    this.params.distance = distance;
    this.schedule.set(time, density);
  }

  /**
   * Fills `dryLeft`, `dryRight`, `wetLeft` and `wetRight` (one length) from
   * absolute sample `start`: the dry mix and the reverb send's.
   */
  render(
    dryLeft: Float32Array,
    dryRight: Float32Array,
    wetLeft: Float32Array,
    wetRight: Float32Array,
    start: number,
  ): void {
    const length = dryLeft.length;
    const sr = this.sampleRate;
    const fresh = start !== this.expected;
    this.expected = start + length;
    this.renderAir(0, dryLeft, start);
    this.renderAir(1, dryRight, start);
    wetLeft.fill(0);
    wetRight.fill(0);

    const firstBlock = Math.floor(start / sr);
    const lastBlock = Math.floor((start + length - 1) / sr);
    for (let b = 0; b < BIRD_SLOTS; b++) {
      const voice = this.voices[b];
      if (fresh) {
        this.restart(b, voice, start);
      }
      let pos = 0;
      for (let k = firstBlock; k <= lastBlock; k++) {
        const t = this.schedule.candidateTime(b, k);
        if (Number.isNaN(t)) {
          continue;
        }
        const at = Math.ceil(t * sr) - start;
        if (at < 0 || at >= length) {
          continue;
        }
        this.sing(b, voice, dryLeft, dryRight, wetLeft, wetRight, pos, at, start);
        pos = at;
        // A bird still singing (only after a param change) lets the candidate go.
        if (!voice.active && this.schedule.phrase(b, k, t, voice.phrase)) {
          voice.begin();
        }
      }
      this.sing(b, voice, dryLeft, dryRight, wetLeft, wetRight, pos, length, start);
    }
  }

  /** Forgets what bird `b` was singing, and picks up the phrase sounding at absolute sample `start`, if any. */
  private restart(b: number, voice: Voice, start: number): void {
    voice.active = false;
    const sr = this.sampleRate;
    const k = Math.floor(start / sr);
    for (let kk = k; kk >= k - LOOKBACK; kk--) {
      const t = this.schedule.candidateTime(b, kk);
      if (Number.isNaN(t) || Math.ceil(t * sr) >= start) {
        continue;
      }
      if (!this.schedule.phrase(b, kk, t, voice.phrase)) {
        continue;
      }
      // The latest phrase to start ended before any later candidate: no earlier one can sound.
      const phrase = voice.phrase;
      if (phrase.end <= start) {
        return;
      }
      voice.begin();
      while ((phrase.starts[voice.index] ?? 0) + (phrase.lengths[voice.index] ?? 0) <= start) {
        voice.next();
      }
      // Run the syllable's phase silently from its start, as it would have run.
      const s = phrase.syllables[voice.index];
      const s0 = phrase.starts[voice.index] ?? 0;
      const dt = 1 / sr;
      const c = this.contour;
      for (let m = s0; m < start; m++) {
        c.at(s, phrase.pitch, phrase.tempo, (m - s0) * dt);
        if (c.note !== voice.note) {
          voice.note = c.note;
          voice.phase = 0;
        }
        voice.phase += c.frequency * dt;
        voice.phase -= Math.floor(voice.phase);
      }
      return;
    }
  }

  /** Adds bird `b`'s samples `from` to `to` of the render from absolute sample `start`. */
  private sing(
    b: number,
    voice: Voice,
    dryLeft: Float32Array,
    dryRight: Float32Array,
    wetLeft: Float32Array,
    wetRight: Float32Array,
    from: number,
    to: number,
    start: number,
  ): void {
    const dt = 1 / this.sampleRate;
    const c = this.contour;
    const phrase = voice.phrase;
    let pos = from;
    while (voice.active && pos < to) {
      const s = phrase.syllables[voice.index];
      const s0 = (phrase.starts[voice.index] ?? 0) - start;
      const s1 = s0 + (phrase.lengths[voice.index] ?? 0);
      const i0 = Math.max(pos, s0);
      if (i0 >= to) {
        return;
      }
      if (!voice.latched) {
        voice.latch(this.schedule.profiles[b]?.pan ?? 0, this.params.distance);
      }
      const i1 = Math.min(to, s1);
      const pitch = phrase.pitch;
      const tempo = phrase.tempo;
      const harmonic = s.harmonic;
      const inverse = voice.inverseCutoff;
      const dl = voice.dryLeft;
      const dr = voice.dryRight;
      const wl = voice.wetLeft;
      const wr = voice.wetRight;
      let phase = voice.phase;
      for (let i = i0; i < i1; i++) {
        c.at(s, pitch, tempo, (i - s0) * dt);
        if (c.note !== voice.note) {
          voice.note = c.note;
          phase = 0;
        }
        const f = c.frequency;
        const a = c.amplitude;
        if (a > 0) {
          // The air's 12 dB-per-octave low-pass, as its gain at each partial.
          const r = f * inverse;
          const r4 = r * r * r * r;
          let y = sine(phase) / Math.sqrt(1 + r4);
          if (harmonic > 0) {
            y += (harmonic * sine(2 * phase)) / Math.sqrt(1 + 16 * r4);
          }
          y *= a;
          dryLeft[i] = (dryLeft[i] ?? 0) + y * dl;
          dryRight[i] = (dryRight[i] ?? 0) + y * dr;
          wetLeft[i] = (wetLeft[i] ?? 0) + y * wl;
          wetRight[i] = (wetRight[i] ?? 0) + y * wr;
        }
        phase += f * dt;
        phase -= Math.floor(phase);
      }
      voice.phase = phase;
      pos = i1;
      if (i1 >= s1) {
        voice.next();
      }
    }
  }

  /** Writes channel `c`'s air into `out`, overwriting it. */
  private renderAir(c: number, out: Float32Array, start: number): void {
    const prefix = this.airPrefixes[c] ?? 0;
    const hp = this.airHighpasses[c];
    const [lp1, lp2] = this.airLowpasses[c];
    const gain = this.airGain;
    for (let i = 0; i < out.length; i++) {
      const w = hashStep(prefix, start + i) * UINT32_SCALE * 2 - 1;
      out[i] = lp2.process(lp1.process(hp.process(w * gain)));
    }
  }
}
