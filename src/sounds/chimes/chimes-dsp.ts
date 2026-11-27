/**
 * Wind Chimes' kernel: a set of tuned tubes on a porch, struck by a clapper
 * that the wind swings about. No Web Audio here, so it is unit-testable in Node.
 *
 * - **Gusts.** A slow drift (0.04 Hz, 3 octaves) is the wind. Its value `d`
 *   gives the gust's shape, `clamp(0.5 + 0.5·d, 0, 1)^1.8`, and the gust
 *   strength `g` is that times a share of Wind (at most 0.8, at Wind 100).
 * - **Strikes.** Candidates come from a Poisson process of 6 a second, the most
 *   the clapper manages. Each is kept if its hash falls below `g` at its time,
 *   so strikes come in clusters with the gusts and all but vanish in the lulls;
 *   a floor of one strike in about 20 s keeps the odd tone at Wind 0. A kept
 *   strike hits the tube nearest the clapper, whose place across the set is a
 *   second drift (0.15 Hz), give or take a hashed 1.5 tubes: so a cluster lands
 *   on neighbouring tubes, while each pick is a function of its time and hash
 *   alone, never of the strikes before. It strikes 0.3–1 times as hard as the
 *   gust's shape (so a strong gust strikes harder; Wind sets how often).
 * - **Tubes.** Each tube is a `ModalBank` of free-free bar modes (1, 2.76,
 *   5.40, 8.93 times its fundamental, at 0, −8, −14 and −22 dB), each detuned
 *   by a hashed ±0.4 % so no two sets ring alike, the fundamental ringing for
 *   6–9 s and each higher mode shorter by its ratio to the power 0.6. Modes
 *   above 7.5 kHz are left out, for comfort. The clapper is soft: a strike is
 *   an impulse into modes already rolled off above 4 kHz, the spectrum a short
 *   soft blow gives, so every tube is struck alike whatever its pitch (a
 *   raised-cosine pulse a few milliseconds long would have spectral nulls
 *   right where some tubes ring). The tubes pan evenly across ±0.6 in order,
 *   gliding to their new places when the set grows or shrinks.
 * - **Low bamboo** is wooden instead: modes at 1, 2.4 and 4.1, ringing for
 *   only 0.15–0.4 s, a short knock of band-passed noise (1.2 kHz, Q 2, 15 ms)
 *   with each strike, and all of it under a gentle 3 kHz low-pass (folded into
 *   the modes' levels, and run on the knock).
 *
 * Every strike comes from hashes of absolute time, and the drifts are
 * functions of absolute time. A render that starts afresh strikes the tubes
 * that are still ringing in closed form, as they stand at a moment just before
 * it, then renders the last few milliseconds unheard (for the knocks and their
 * filters): so at steady params the output depends only on the seed and
 * absolute time. Tubes and Wind latch per strike: a tube left out of the set
 * rings out and is not struck again.
 */
import { blockOf, createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { ModalBank } from "../../audio/dsp/modal";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { svfCoefficients } from "../../audio/dsp/svf";
import { DriftGenerator } from "../../audio/drift-dsp";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import { MAX_TUBES, MIN_TUBES, type ChimeTuning } from "./chimes.meta";

export const CHIMES_PROCESSOR = "aural-chimes";
/** The worklet's output channels: left and right. */
export const CHIMES_CHANNELS = 2;

/** Random streams. */
export const STRIKE_STREAM = 1;
const GUST_STREAM = 2;
const CLAPPER_STREAM = 3;
const TUBE_STREAM = 4;

/** Salts for a strike's and a tube's random properties. */
const KEEP_SALT = 11;
const STRENGTH_SALT = 12;
const OFFSET_SALT = 13;
const DECAY_SALT = 21;
const DETUNE_SALT = 22;
const KNOCK_SALT = 31;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const unit = (state: number, salt: number) => hashStep(state, salt) * UINT32_SCALE;
const between = (range: readonly [number, number], u: number) =>
  range[0] + (range[1] - range[0]) * u;

// ---------------------------------------------------------------------------
// The tubes.

/** A tuning: the scale, the tubes' modes and how long they ring. */
interface TuningSpec {
  /** The lowest tube's fundamental, in Hz. */
  root: number;
  /** The scale's degrees in semitones above the root, repeated an octave up. */
  degrees: readonly number[];
  /** The modes' frequencies against the fundamental, and their levels in dB. */
  ratios: readonly number[];
  levelsDb: readonly number[];
  /** The fundamental's decay to −60 dB, in seconds, from–to (hashed per tube). */
  decay: readonly [number, number];
  /** Wooden: a knock with each strike, and a low-pass on it all. */
  wooden: boolean;
  /** Each tube's strike gain at full strength: a short ring needs more to sit at the same level. */
  gain: number;
}

const METAL_RATIOS = [1, 2.76, 5.4, 8.93] as const;
const METAL_LEVELS = [0, -8, -14, -22] as const;
const METAL_DECAY = [6, 9] as const;
const METAL_GAIN = dbToGain(-13);
const PENTATONIC_MAJOR = [0, 2, 4, 7, 9] as const;

export const TUNINGS: Readonly<Record<ChimeTuning, TuningSpec>> = {
  major: {
    root: 440,
    degrees: PENTATONIC_MAJOR,
    ratios: METAL_RATIOS,
    levelsDb: METAL_LEVELS,
    decay: METAL_DECAY,
    wooden: false,
    gain: METAL_GAIN,
  },
  minor: {
    root: 440,
    degrees: [0, 3, 5, 7, 10],
    ratios: METAL_RATIOS,
    levelsDb: METAL_LEVELS,
    decay: METAL_DECAY,
    wooden: false,
    gain: METAL_GAIN,
  },
  "in-scale": {
    root: 329.63,
    degrees: [0, 1, 5, 7, 8],
    ratios: METAL_RATIOS,
    levelsDb: METAL_LEVELS,
    decay: METAL_DECAY,
    wooden: false,
    gain: METAL_GAIN,
  },
  bamboo: {
    root: 146.83,
    degrees: PENTATONIC_MAJOR,
    ratios: [1, 2.4, 4.1],
    levelsDb: [0, -8, -14],
    decay: [0.15, 0.4],
    wooden: true,
    gain: dbToGain(-3),
  },
};

/** The most modes a tube has. */
const MAX_MODES = 4;
/** Modes above this, in Hz, are left out: piercing over hours. */
export const MODE_TOP = 7500;
/** How far each mode is detuned, either way: ±0.4 %. */
export const DETUNE = 0.004;
/** Each higher mode rings shorter by its ratio to this power. */
export const DECAY_POWER = 0.6;
/** The soft clapper's roll-off: a first-order corner, in Hz. */
const CLAPPER_CORNER = 4000;
/** Low bamboo's low-pass, in Hz. */
const BAMBOO_LOWPASS = 3000;

/** A first-order low-pass's gain at `frequency`, for a corner at `corner`. */
const rollOff = (frequency: number, corner: number) => 1 / Math.sqrt(1 + (frequency / corner) ** 2);

/** Tube `index`'s fundamental in `tuning`, in Hz: the scale's degrees, climbing by octaves. */
export function tubeFundamental(tuning: ChimeTuning, index: number): number {
  const { root, degrees } = TUNINGS[tuning];
  const octave = Math.floor(index / degrees.length);
  const degree = degrees[index % degrees.length] ?? 0;
  return root * 2 ** ((degree + 12 * octave) / 12);
}

/** One mode of a tube. */
interface TubeMode {
  frequency: number;
  /** Seconds to −60 dB. */
  decay: number;
  /** Its amplitude per unit strike. */
  amplitude: number;
}

/** A tube's hash: its decay and detune. */
const tubeHash = (seed: number, index: number) =>
  hashStep(hashStep(hashStep(HASH_START, seed), TUBE_STREAM), index);

/** Tube `index`'s modes in `tuning` for `seed`, leaving out any above `MODE_TOP`. */
export function tubeModes(tuning: ChimeTuning, seed: number, index: number): TubeMode[] {
  const spec = TUNINGS[tuning];
  const hash = tubeHash(seed, index);
  const fundamental = tubeFundamental(tuning, index);
  const decay = between(spec.decay, unit(hash, DECAY_SALT));
  const modes: TubeMode[] = [];
  for (const [m, ratio] of spec.ratios.entries()) {
    const detune = 1 + DETUNE * (2 * unit(hashStep(hash, m), DETUNE_SALT) - 1);
    const frequency = fundamental * ratio * detune;
    if (frequency > MODE_TOP) {
      continue;
    }
    let amplitude = dbToGain(spec.levelsDb[m] ?? 0) * rollOff(frequency, CLAPPER_CORNER);
    if (spec.wooden) {
      amplitude *= rollOff(frequency, BAMBOO_LOWPASS);
    }
    modes.push({ frequency, decay: decay / ratio ** DECAY_POWER, amplitude });
  }
  return modes;
}

/** How many tubes `tubes` (the param) asks for: a whole number from 3 to 8. */
export function tubeCount(tubes: number): number {
  return Number.isFinite(tubes) ? clamp(Math.round(tubes), MIN_TUBES, MAX_TUBES) : MIN_TUBES;
}

/** How far the tubes spread either side of the centre. */
export const TUBE_PAN = 0.6;

/** Tube `index`'s place in a set of `count`: evenly across ±0.6 in order. */
export function tubePan(index: number, count: number): number {
  return count > 1 ? TUBE_PAN * ((2 * index) / (count - 1) - 1) : 0;
}

// ---------------------------------------------------------------------------
// The wind and the strikes.

/** Candidate strikes a second: the most the clapper manages, in the strongest gust. */
export const CANDIDATE_RATE = 6;
/** Strikes a second at Wind 0 (a floor on the chance of keeping a candidate). */
export const FLOOR_RATE = 1 / 20;
const FLOOR = FLOOR_RATE / CANDIDATE_RATE;
/** The gust's power: lifts its peaks above its body. */
const GUST_POWER = 1.8;
/** The wind's drift: rate (Hz) and octaves; and the clapper's. */
const GUST_DRIFT = { rate: 0.04, octaves: 3 } as const;
const CLAPPER_DRIFT = { rate: 0.15, octaves: 1 } as const;
/** The clapper's drift's usual reach either way, mapped onto the whole set. */
const CLAPPER_REACH = 0.8;
/** How far from the clapper's place a strike may land, in tubes, either way. */
export const PICK_SPREAD = 1.5;
/** A strike's strength against the gust's shape, from–to. */
export const STRENGTH = [0.3, 1] as const;
/**
 * How hard the gentlest gust still strikes, against the strongest: a strike's
 * strength rises from this to 1 with the gust's shape, so a lone tone in a
 * lull is still heard, and a gust's cluster is louder, but not by much.
 */
const STRENGTH_BASE = 0.4;

/** The gust's shape (0–1) at drift value `d`. */
export function gustShape(d: number): number {
  return clamp(0.5 + 0.5 * d, 0, 1) ** GUST_POWER;
}

/**
 * How Wind (0–100) scales the gusts: the chance of keeping a candidate in the
 * strongest gust at Wind 100, and the power of Wind's share. A light breeze
 * still stirs the set, and a strong one is busier but never a clatter.
 */
const WIND_MOST = 0.8;
const WIND_POWER = 0.5;

/** The chance a candidate strike is kept, at gust shape `shape` and Wind `wind` (0–100). */
export function keepChance(shape: number, wind: number): number {
  return Math.max(FLOOR, shape * WIND_MOST * (clamp(wind, 0, 100) / 100) ** WIND_POWER);
}

/** The clapper's place across the set, 0–1, at its drift's value `d`. */
export function clapperPlace(d: number): number {
  return clamp(0.5 + (0.5 * d) / CLAPPER_REACH, 0, 1);
}

/** The tube a strike hits: nearest the clapper's place, give or take up to 1.5 tubes by `u`. */
export function pickTube(place: number, u: number, count: number): number {
  const position = place * (count - 1) + PICK_SPREAD * (2 * u - 1);
  return clamp(Math.round(position), 0, count - 1);
}

/** A strike: which tube, and how hard (0–1). `tube` is −1 when the candidate isn't kept. */
export interface Strike {
  tube: number;
  strength: number;
}

/** The wind and the clapper for one seed: what each candidate strike does. */
export class StrikeScheduler {
  private readonly seed: number;
  private readonly gust: DriftGenerator;
  private readonly clapper: DriftGenerator;

  constructor(seed: number, sampleRate: number) {
    this.seed = seed;
    const { rate, octaves } = GUST_DRIFT;
    this.gust = new DriftGenerator(seed, GUST_STREAM, rate, octaves, sampleRate);
    this.clapper = new DriftGenerator(
      seed,
      CLAPPER_STREAM,
      CLAPPER_DRIFT.rate,
      CLAPPER_DRIFT.octaves,
      sampleRate,
    );
  }

  /** The gust's shape (0–1) at absolute time `t`. */
  gustAt(t: number): number {
    return gustShape(this.gust.valueAtTime(t));
  }

  /**
   * Fills `out` with what candidate `index` of block `block` does at absolute
   * time `t` (seconds), at Wind `wind` and `count` tubes.
   */
  strike(block: number, index: number, t: number, wind: number, count: number, out: Strike): void {
    const hash = eventHash(this.seed, STRIKE_STREAM, block, index);
    const shape = this.gustAt(t);
    if (unit(hash, KEEP_SALT) >= keepChance(shape, wind)) {
      out.tube = -1;
      out.strength = 0;
      return;
    }
    const place = clapperPlace(this.clapper.valueAtTime(t));
    out.tube = pickTube(place, unit(hash, OFFSET_SALT), count);
    const gust = STRENGTH_BASE + (1 - STRENGTH_BASE) * shape;
    out.strength = between(STRENGTH, unit(hash, STRENGTH_SALT)) * gust;
  }
}

// ---------------------------------------------------------------------------
// The knock (Low bamboo).

/** The knock's band-pass (Hz, Q) and length (s). */
const KNOCK_CENTRE = 1200;
const KNOCK_Q = 2;
const KNOCK_LENGTH = 0.015;
/** The knock's share of its attack, then it falls away. */
const KNOCK_ATTACK = 0.1;
/** The knock's level against the strike's: its band's RMS about −15 dB under the ring's peak. */
const KNOCK_GAIN = 1.2;
/** Knocks at once: more is a clatter nobody would hear apart. */
const KNOCK_VOICES = 4;
/** How long the knock's filters keep running after the last knock, in seconds. */
const KNOCK_TAIL = 0.01;

/** The knock's envelope at `x` (0–1 through it): a quick rise, then a fall to 0. */
export function knockEnvelope(x: number): number {
  if (x <= 0 || x >= 1) {
    return 0;
  }
  if (x < KNOCK_ATTACK) {
    return x / KNOCK_ATTACK;
  }
  const fall = (1 - x) / (1 - KNOCK_ATTACK);
  return fall * fall;
}

/** A knock sounding. */
interface Knock {
  active: boolean;
  /** Samples since it started. */
  position: number;
  noise: number;
  left: number;
  right: number;
}

// ---------------------------------------------------------------------------
// The kernel.

/** A render quantum, in samples: the most the kernel renders at once. */
const QUANTUM = 128;
/** Seconds rendered unheard before a render that starts afresh: past any knock and its filters. */
const PREROLL = 0.04;
/** A struck tube has fallen 90 dB after this many of its fundamental's decay times. */
const RING_OUT = 1.5;
/** How long a tube takes to glide to its new place, in seconds per unit of gain. */
const PAN_GLIDE = 0.5;
/** The sample rate the knock's noise level is set at: other rates scale it to the same density. */
const REFERENCE_RATE = 48000;
/** Uniform noise in [−1, 1) to unit variance. */
const UNIFORM_TO_UNIT = Math.sqrt(3);
/** The guard on the sound: above the knee, a tanh curve that never passes the ceiling. */
const GUARD_KNEE = dbToGain(-9);
const GUARD_CEILING = dbToGain(-4.5);

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

/** One tube: its modes, its place now and its place to be. */
interface Tube {
  readonly bank: ModalBank;
  left: number;
  right: number;
  targetLeft: number;
  targetRight: number;
}

/** The worklet's options: the tuning, the seed and the offset to absolute time. */
interface ChimesOptions {
  tuning: ChimeTuning;
  seed: number;
  offset: number;
}

const isTuning = (value: unknown): value is ChimeTuning =>
  typeof value === "string" && Object.hasOwn(TUNINGS, value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readChimesOptions(raw: unknown): ChimesOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const tuning = get("tuning");
  return {
    tuning: isTuning(tuning) ? tuning : "major",
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}

/**
 * Wind Chimes' whole sound for one tuning and seed, from absolute samples: the
 * same whether rendered in one go or in chunks, at steady params.
 */
export class ChimesKernel {
  private readonly sampleRate: number;
  private readonly seed: number;
  private readonly spec: TuningSpec;
  private readonly scheduler: StrikeScheduler;
  private readonly tubes: Tube[];
  private readonly knocks: Knock[];
  private readonly knockBand: Float64Array;
  private readonly knockPole: number;
  private readonly knockGain: number;
  /** The knock's filter states: per side, the band-pass's two and the low-pass. */
  private readonly knockState = new Float64Array(6);
  /** Samples the knock's filters still run for. */
  private knockRunning = 0;
  private readonly knockTail: number;
  private readonly panStep: number;
  /** How long after a strike its tube is still heard, in samples. */
  private readonly ringOut: number;
  private readonly preroll: number;

  /** The candidate strikes: the loaded block, its events, and the next to come. */
  private readonly events = createEventBlock(64);
  private block = Number.NaN;
  private next = 0;
  private readonly struck: Strike = { tube: -1, strength: 0 };

  /** Scratch: a tube's ring, the knocks' sum on each side, and an unheard render. */
  private readonly ring = new Float32Array(QUANTUM);
  private readonly knockL = new Float32Array(QUANTUM);
  private readonly knockR = new Float32Array(QUANTUM);
  private readonly unheard = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)] as const;

  /** The params `set` gave. */
  private count = 5;
  private wind = 35;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(tuning: ChimeTuning, seed: number, sampleRate: number) {
    const sr = sampleRate;
    this.sampleRate = sr;
    this.seed = seed;
    this.spec = TUNINGS[tuning];
    this.scheduler = new StrikeScheduler(seed, sr);
    this.tubes = Array.from({ length: MAX_TUBES }, (_, index) => {
      const bank = new ModalBank(sr, MAX_MODES);
      for (const [m, mode] of tubeModes(tuning, seed, index).entries()) {
        bank.setMode(m, mode.frequency, mode.decay, mode.amplitude);
      }
      return { bank, left: 0, right: 0, targetLeft: 0, targetRight: 0 };
    });
    this.knocks = Array.from({ length: KNOCK_VOICES }, () => ({
      active: false,
      position: 0,
      noise: 0,
      left: 0,
      right: 0,
    }));
    this.knockBand = svfCoefficients(new Float64Array(4), KNOCK_CENTRE, KNOCK_Q, sr);
    this.knockPole = Math.exp((-2 * Math.PI * BAMBOO_LOWPASS) / sr);
    this.knockGain = KNOCK_GAIN * UNIFORM_TO_UNIT * Math.sqrt(sr / REFERENCE_RATE);
    this.knockTail = Math.ceil(KNOCK_TAIL * sr);
    this.panStep = 1 / (PAN_GLIDE * sr);
    this.ringOut = Math.ceil(RING_OUT * this.spec.decay[1] * sr);
    this.preroll = Math.ceil(PREROLL * sr);
    this.place(true);
  }

  /** Sets the params for the next render: Tubes (3–8) and Wind (0–100), both latched per strike. */
  set(tubes: number, wind: number): void {
    const count = tubeCount(tubes);
    if (count !== this.count) {
      this.count = count;
      this.place(false);
    }
    this.wind = Number.isFinite(wind) ? clamp(wind, 0, 100) : 0;
  }

  /** How many tubes are ringing. */
  get ringing(): number {
    return this.tubes.filter((t) => t.bank.ringing).length;
  }

  /**
   * Strikes every tube in the set at once, `strength` (0–1) hard, from the next
   * sample rendered: the loudest moment the chimes could ever have.
   */
  strikeAll(strength: number): void {
    for (let i = 0; i < this.count; i++) {
      this.tubes[i].bank.strike(strength * this.spec.gain);
      this.startKnock(i, strength, 0);
    }
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    const length = Math.min(left.length, right.length);
    if (start !== this.expected) {
      this.warmUp(start);
    }
    for (let done = 0; done < length; done += QUANTUM) {
      const n = Math.min(QUANTUM, length - done);
      this.process(left, right, done, n, start + done);
    }
    this.expected = start + length;
  }

  /** Sets each tube's place in the set of `count`: at once, or to glide there. */
  private place(now: boolean): void {
    for (const [i, tube] of this.tubes.entries()) {
      if (i >= this.count) {
        // Left out of the set: it rings out where it hangs.
        continue;
      }
      const pan = tubePan(i, this.count);
      tube.targetLeft = panLeft(pan) * Math.SQRT2;
      tube.targetRight = panRight(pan) * Math.SQRT2;
      if (now) {
        tube.left = tube.targetLeft;
        tube.right = tube.targetRight;
      }
    }
  }

  /**
   * A fresh start, or a jump: every tube silenced, then each strike still
   * ringing struck in closed form as it stands a moment before `start`, and
   * that moment rendered unheard, for the knocks.
   */
  private warmUp(start: number): void {
    const sr = this.sampleRate;
    const from = start - this.preroll;
    for (const tube of this.tubes) {
      tube.bank.silence();
    }
    this.place(true);
    for (const knock of this.knocks) {
      knock.active = false;
    }
    this.knockState.fill(0);
    this.knockRunning = 0;
    this.load(blockOf(from - this.ringOut, sr));
    for (let at = this.candidate(); at < from; at = this.candidate()) {
      const elapsed = from - at;
      if (elapsed < this.ringOut) {
        this.evaluate(at);
        if (this.struck.tube >= 0) {
          this.tubes[this.struck.tube].bank.strike(this.struck.strength * this.spec.gain, elapsed);
        }
      }
      this.next++;
    }
    for (let at = from; at < start;) {
      const n = Math.min(QUANTUM, start - at);
      this.process(this.unheard[0], this.unheard[1], 0, n, at);
      at += n;
    }
  }

  /** Loads block `block`'s candidate strikes. */
  private load(block: number): void {
    eventsInBlock(this.seed, STRIKE_STREAM, block, CANDIDATE_RATE, this.events);
    this.block = block;
    this.next = 0;
  }

  /** The absolute sample of the next candidate strike, loading blocks as they come. */
  private candidate(): number {
    while (this.next >= this.events.count) {
      this.load(this.block + 1);
    }
    const sr = this.sampleRate;
    return this.block * sr + Math.floor((this.events.offsets[this.next] ?? 0) * sr);
  }

  /** What the next candidate, at absolute sample `at`, does: into `this.struck`. */
  private evaluate(at: number): void {
    this.scheduler.strike(
      this.block,
      this.next,
      at / this.sampleRate,
      this.wind,
      this.count,
      this.struck,
    );
  }

  /**
   * Starts a knock on tube `index`'s strike, `strength` hard, `delay` samples
   * into the quantum the knocks render next.
   */
  private startKnock(index: number, strength: number, delay: number): void {
    if (!this.spec.wooden) {
      return;
    }
    let voice = this.knocks[0];
    for (const k of this.knocks) {
      if (!k.active) {
        voice = k;
        break;
      }
      if (k.position > voice.position) {
        voice = k;
      }
    }
    const pan = tubePan(index, this.count);
    const gain = strength * this.spec.gain * this.knockGain;
    voice.active = true;
    voice.position = -delay;
    voice.noise = hashStep(eventHash(this.seed, STRIKE_STREAM, this.block, this.next), KNOCK_SALT);
    voice.left = gain * panLeft(pan) * Math.SQRT2;
    voice.right = gain * panRight(pan) * Math.SQRT2;
    this.knockRunning = Math.max(
      this.knockRunning,
      delay + Math.ceil(KNOCK_LENGTH * this.sampleRate) + this.knockTail,
    );
  }

  /** Renders `length` samples (at most a quantum) from absolute sample `start` into the outputs at `at`. */
  private process(
    left: Float32Array,
    right: Float32Array,
    at: number,
    length: number,
    start: number,
  ): void {
    left.fill(0, at, at + length);
    right.fill(0, at, at + length);
    let done = 0;
    const end = start + length;
    for (let strikeAt = this.candidate(); strikeAt < end; strikeAt = this.candidate()) {
      const offset = Math.max(done, strikeAt - start);
      this.renderTubes(left, right, at, done, offset);
      done = offset;
      this.evaluate(strikeAt);
      const tube = this.struck.tube;
      if (tube >= 0) {
        this.tubes[tube].bank.strike(this.struck.strength * this.spec.gain);
        this.startKnock(tube, this.struck.strength, offset);
      }
      this.next++;
    }
    this.renderTubes(left, right, at, done, length);
    if (this.knockRunning > 0) {
      this.renderKnocks(left, right, at, length, start);
    }
    for (let i = at; i < at + length; i++) {
      left[i] = guard(left[i] ?? 0);
      right[i] = guard(right[i] ?? 0);
    }
  }

  /** Adds the ringing tubes from `from` to `to` of this quantum into the outputs at `at`. */
  private renderTubes(
    left: Float32Array,
    right: Float32Array,
    at: number,
    from: number,
    to: number,
  ): void {
    const n = to - from;
    if (n <= 0) {
      return;
    }
    const ring = this.ring;
    const step = this.panStep * n;
    for (const tube of this.tubes) {
      // Glide towards its place, linearly through the stretch.
      const l0 = tube.left;
      const r0 = tube.right;
      const dl = tube.targetLeft - l0;
      const dr = tube.targetRight - r0;
      const l1 = Math.abs(dl) <= step ? tube.targetLeft : l0 + Math.sign(dl) * step;
      const r1 = Math.abs(dr) <= step ? tube.targetRight : r0 + Math.sign(dr) * step;
      tube.left = l1;
      tube.right = r1;
      if (!tube.bank.ringing) {
        continue;
      }
      ring.fill(0, from, to);
      tube.bank.render(ring, from, to);
      if (l0 === l1 && r0 === r1) {
        for (let i = from; i < to; i++) {
          const x = ring[i] ?? 0;
          left[at + i] += l1 * x;
          right[at + i] += r1 * x;
        }
      } else {
        const sl = (l1 - l0) / n;
        const sr = (r1 - r0) / n;
        for (let i = from; i < to; i++) {
          const x = ring[i] ?? 0;
          const k = i - from + 1;
          left[at + i] += (l0 + sl * k) * x;
          right[at + i] += (r0 + sr * k) * x;
        }
      }
    }
  }

  /** Adds the knocks, through their band-pass and low-pass, into the outputs at `at`. */
  private renderKnocks(
    left: Float32Array,
    right: Float32Array,
    at: number,
    length: number,
    start: number,
  ): void {
    const kl = this.knockL;
    const kr = this.knockR;
    kl.fill(0, 0, length);
    kr.fill(0, 0, length);
    const knockSamples = KNOCK_LENGTH * this.sampleRate;
    for (const k of this.knocks) {
      if (!k.active) {
        continue;
      }
      for (let i = 0; i < length; i++) {
        const envelope = knockEnvelope((k.position + i) / knockSamples);
        if (envelope === 0) {
          continue;
        }
        const x = envelope * (hashStep(k.noise, start + i) * UINT32_SCALE * 2 - 1);
        kl[i] += k.left * x;
        kr[i] += k.right * x;
      }
      k.position += length;
      if (k.position >= knockSamples) {
        k.active = false;
      }
    }
    const [a1 = 0, a2 = 0, a3 = 0, kq = 0] = this.knockBand;
    const pole = this.knockPole;
    const st = this.knockState;
    for (let side = 0; side < 2; side++) {
      const input = side === 0 ? kl : kr;
      const out = side === 0 ? left : right;
      const o = side * 3;
      let ic1 = st[o] ?? 0;
      let ic2 = st[o + 1] ?? 0;
      let low = st[o + 2] ?? 0;
      for (let i = 0; i < length; i++) {
        const v3 = (input[i] ?? 0) - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        const band = kq * v1;
        low = band + pole * (low - band);
        out[at + i] += low;
      }
      st[o] = ic1;
      st[o + 1] = ic2;
      st[o + 2] = low;
    }
    this.knockRunning -= length;
    if (this.knockRunning <= 0) {
      this.knockRunning = 0;
      this.knockState.fill(0);
    }
  }
}
