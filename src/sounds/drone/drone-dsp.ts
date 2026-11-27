/**
 * Drone Pad's kernel: a warm, open chord of detuned saw voices that glows for
 * a minute or so, then dissolves into another over tens of seconds. No Web
 * Audio here, so it is unit-testable in Node.
 *
 * - **Voices.** Two groups, A and B, of five notes each; each note is three
 *   voices of one band-limited saw (harmonics 1–24 at 1/n, the even ones 2 dB
 *   lower for warmth): one in the centre, which carries the note in mono, and
 *   one 7 cents flat on the left and one 7 cents sharp on the right (±0.6).
 *   Each note is 2 dB quieter than the one below it.
 * - **Voicings** are open stacks of roots, fifths and ninths, in semitones
 *   from the key's root in octave 2 (`VOICINGS`), so no note goes below 40 Hz
 *   or above 750 Hz in any key, and the saw's top harmonic stays under 18 kHz.
 * - **Slots.** Slot `n` starts at `n × period` of absolute time (the period
 *   30–120 s, from Movement). Slots come in cycles of five, each cycle a
 *   hashed shuffle of the five voicings, its first two swapped if it would
 *   start on the voicing the last one ended on, so every slot's voicing is a
 *   pure function of the seed and `n`, and none plays twice running. Even
 *   slots play on group A, odd ones on group B.
 * - **Crossfade.** Each slot opens with an equal-power crossfade, a third of
 *   the period long, from the other group (the last slot's chord) to its own,
 *   then holds. A group takes its new chord at its slot's start, where its
 *   gain is zero, having been silent since the last slot's fade ended.
 * - **Drift.** Each voice's pitch wanders by up to ±5 cents (times Movement)
 *   on its own slow drift (about 0.03 Hz), as phase modulation: its phase is
 *   its frequency times absolute time less a small drifting delay, so it stays
 *   a function of absolute time. A one-octave drift's slope peaks near 2.3
 *   per knot, so a delay swing of `(2^(c/1200) − 1) / (2.4 · rate)` keeps the
 *   pitch within ±c cents.
 * - **Filter.** The sum goes through a low-pass (Q 0.9) from 350 Hz
 *   (Brightness 0) to 3.2 kHz (100), log-mapped, its cutoff moved by a slow
 *   drift (0.02 Hz, two octaves) by up to ±35 % times Movement and a faster one
 *   (0.13 Hz) by ±8 %, then a gentle first-order shelf of −6 dB above 5 kHz.
 *
 * At steady params the output depends only on the key, the seed and absolute
 * time (the filter settles within milliseconds of a fresh start). A change of
 * Movement re-times the slots from the next one; a shorter period may bring
 * the next change forward, but never into a crossfade under way, so nothing
 * jumps. Movement's drift depth slides there at most 5 % a second, so the
 * pitch never bends by more than a few cents as it moves.
 */
import { panLeft, panRight } from "../../audio/dsp/pan";
import {
  createPeriodicEvents,
  PeriodicSchedule,
  type PeriodicEvents,
} from "../../audio/dsp/periodic";
import { svfCoefficients } from "../../audio/dsp/svf";
import { DriftGenerator } from "../../audio/drift-dsp";
import { HASH_START, hash32, hashStep, UINT32_SCALE } from "../../audio/random";
import type { DroneKey } from "./drone.meta";

export const DRONE_PROCESSOR = "aural-drone";
/** The worklet's output channels: left and right. */
export const DRONE_CHANNELS = 2;

/** Random streams. */
const SLOT_STREAM = 1;
const VOICING_STREAM = 2;
const WANDER_STREAM = 3;
const CUTOFF_STREAM = 4;
const FLUTTER_STREAM = 5;

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------
// The notes.

/** Each key's semitones above C. */
const KEY_STEPS: Readonly<Record<DroneKey, number>> = {
  c: 0,
  cs: 1,
  d: 2,
  eb: 3,
  e: 4,
  f: 5,
  fs: 6,
  g: 7,
  ab: 8,
  a: 9,
  bb: 10,
  b: 11,
};
/** C2, in Hz. */
const C2 = 65.40639;
/** Notes per voicing, and voicings in the table. */
export const NOTES = 5;
/**
 * The voicings, in semitones from the key's root in octave 2: root, fifth,
 * ninth, fifth, ninth; an open octave stack; the fifth in the bass; suspended
 * (a fourth above the octave); and the subdominant's colour, still on the key's
 * notes.
 */
export const VOICINGS: readonly (readonly number[])[] = [
  [0, 7, 14, 19, 26],
  [0, 12, 19, 26, 31],
  [-5, 7, 14, 21, 26],
  [0, 7, 17, 24, 26],
  [5, 12, 19, 24, 28],
];
/** Each note's level against the one below it, in dB. */
const NOTE_STEP_DB = -2;
/** The side voices' detune either way, in cents, and their places either side. */
export const SIDE_CENTS = 7;
const SIDE_PAN = 0.6;
/** Voices per note: centre, flat on the left, sharp on the right. */
const VOICES_PER_NOTE = 3;
const GROUP_VOICES = NOTES * VOICES_PER_NOTE;

/** Note `note` of voicing `voicing` in `key`, in Hz. */
export function noteFrequency(key: DroneKey, voicing: number, note: number): number {
  return C2 * 2 ** ((KEY_STEPS[key] + (VOICINGS[voicing]?.[note] ?? 0)) / 12);
}

// ---------------------------------------------------------------------------
// The saw.

/** The saw's harmonics, and the even ones' level against the odd, in dB. */
export const HARMONICS = 24;
export const EVEN_DB = -2;
const WAVE_BITS = 12;
const WAVE_SIZE = 1 << WAVE_BITS;

/** Harmonic `h`'s amplitude (1-based): 1/h, the even ones 2 dB lower. */
export function harmonicLevel(h: number): number {
  return (h % 2 === 0 ? dbToGain(EVEN_DB) : 1) / h;
}

let wave: Float32Array | undefined;

/**
 * The saw, one cycle of `WAVE_SIZE` points plus a wrap-around point for
 * interpolation, scaled to unit RMS.
 */
export function sawTable(): Float32Array {
  if (!wave) {
    wave = new Float32Array(WAVE_SIZE + 1);
    let power = 0;
    for (let h = 1; h <= HARMONICS; h++) {
      power += harmonicLevel(h) ** 2 / 2;
    }
    const scale = 1 / Math.sqrt(power);
    for (let m = 0; m <= WAVE_SIZE; m++) {
      let sum = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        sum += harmonicLevel(h) * Math.sin((2 * Math.PI * h * m) / WAVE_SIZE);
      }
      wave[m] = sum * scale;
    }
  }
  return wave;
}

// ---------------------------------------------------------------------------
// The slots.

/** The period (s) at Movement 0 and 100: exponential between. */
export const SLOWEST_PERIOD = 120;
export const FASTEST_PERIOD = 30;
/** Each slot's crossfade, as a share of the period. */
export const FADE_SHARE = 1 / 3;

const unitMovement = (movement: number) =>
  Number.isFinite(movement) ? clamp(movement, 0, 100) / 100 : 0;

/** The slot period (s) at Movement `movement` (0–100): 120 s to 30 s. */
export function slotPeriod(movement: number): number {
  return SLOWEST_PERIOD * (FASTEST_PERIOD / SLOWEST_PERIOD) ** unitMovement(movement);
}

/** Scratch for the cycles' shuffles: no allocation per slot. */
const shuffled = new Int32Array(VOICINGS.length);

/** Fills `shuffled` with cycle `cycle`'s shuffle of the voicings, and returns its last. */
function shuffle(seed: number, cycle: number): number {
  const count = VOICINGS.length;
  const hash = hash32(seed, VOICING_STREAM, cycle);
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
 * The voicing slot `n` plays: a pure function of the seed and `n`, never the
 * same as slot `n − 1`'s.
 */
export function slotVoicing(seed: number, n: number): number {
  const count = VOICINGS.length;
  const cycle = Math.floor(n / count);
  const place = n - cycle * count;
  // The last cycle's last: a swap only touches a cycle's first two, never its last.
  const before = shuffle(seed, cycle - 1);
  shuffle(seed, cycle);
  if (shuffled[0] === before) {
    shuffled[0] = shuffled[1];
    shuffled[1] = before;
  }
  return shuffled[place] ?? 0;
}

/**
 * The gains of the group fading in and the group fading out, `x` (0–1) of the
 * way through a crossfade: equal-power, so their squares always sum to 1.
 */
export function crossfadeGains(x: number): [incoming: number, outgoing: number] {
  // Exactly silent at the ends, so a silent group is skipped.
  if (!(x > 0)) {
    return [0, 1];
  }
  if (x >= 1) {
    return [1, 0];
  }
  const angle = x * (Math.PI / 2);
  return [Math.sin(angle), Math.cos(angle)];
}

// ---------------------------------------------------------------------------
// Drift and filter.

/** Each voice's pitch wander: its drift's rate range (Hz) and how far it strays at most. */
const WANDER_RATE = [0.025, 0.035] as const;
export const WANDER_CENTS = 5;
/** The steepest a one-octave drift gets, per knot (its slope peaks near 2.3). */
const WANDER_SLOPE = 2.4;
/** How fast Movement's drift depth may slide, per second. */
const DEPTH_SLEW = 0.05;

/** How far a voice's wander delay swings either way, in seconds, for a drift at `rate`. */
function wanderDelay(rate: number): number {
  return (2 ** (WANDER_CENTS / 1200) - 1) / (WANDER_SLOPE * rate);
}

/** The low-pass's cutoff at Brightness 0 and 100, in Hz (log-mapped), and its Q. */
export const CUTOFF_RANGE = [350, 3200] as const;
const FILTER_Q = 0.9;
/** The slow cutoff drift (rate, octaves, reach at Movement 100) and the faster flutter. */
const CUTOFF_DRIFT = { rate: 0.02, octaves: 2, reach: 0.35 } as const;
const FLUTTER = { rate: 0.13, octaves: 1, reach: 0.08 } as const;
/** The high shelf: its corner (Hz) and its gain above it. */
const SHELF_CORNER = 5000;
const SHELF_GAIN = dbToGain(-6);

/** The low-pass's cutoff (Hz) at Brightness `brightness` (0–100), before drift. */
export function cutoffFor(brightness: number): number {
  const b = Number.isFinite(brightness) ? clamp(brightness, 0, 100) / 100 : 0;
  const [lo, hi] = CUTOFF_RANGE;
  return lo * (hi / lo) ** b;
}

// ---------------------------------------------------------------------------
// The kernel.

/** A render quantum, in samples: the most the kernel renders at once. */
const QUANTUM = 128;
/** The whole pad's gain: sets the long-term level. */
const OUTPUT_GAIN = dbToGain(-34);

/** The worklet's options: the key, the seed and the offset to absolute time. */
interface DroneOptions {
  key: DroneKey;
  seed: number;
  offset: number;
}

const isKey = (value: unknown): value is DroneKey =>
  typeof value === "string" && Object.hasOwn(KEY_STEPS, value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readDroneOptions(raw: unknown): DroneOptions {
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
 * Drone Pad's whole sound for one key and seed, from absolute samples: the
 * same whether rendered in one go or in chunks, at steady params.
 */
export class DroneKernel {
  private readonly sampleRate: number;
  private readonly seed: number;
  private readonly key: DroneKey;
  private schedule: PeriodicSchedule;
  private readonly events: PeriodicEvents = createPeriodicEvents(2);

  /** Per voice (group-major, then note, then centre/left/right): its place and level. */
  private readonly lefts = new Float64Array(2 * GROUP_VOICES);
  private readonly rights = new Float64Array(2 * GROUP_VOICES);
  /** Per voice: its detune ratio, its wander drift and the delay it swings by. */
  private readonly detunes = new Float64Array(2 * GROUP_VOICES);
  private readonly wanders: DriftGenerator[];
  private readonly wanderSwings = new Float64Array(2 * GROUP_VOICES);
  /** Per voice: its frequency now, and its wander delay at the end of the last span. */
  private readonly frequencies = new Float64Array(2 * GROUP_VOICES);
  private readonly delays = new Float64Array(2 * GROUP_VOICES);
  /** Per group: the voicing it plays, and whether its delays are stale (it was silent). */
  private readonly voicings = new Int32Array(2);
  private readonly stale = [true, true];

  /** The filter: its drifts, coefficients and each side's state. */
  private readonly cutoffDrift: DriftGenerator;
  private readonly flutter: DriftGenerator;
  private readonly coefficients = new Float64Array(4);
  private readonly filterState = new Float64Array(4);
  private readonly shelfCoefficient: number;
  private readonly shelfState = new Float64Array(2);

  /** The params `set` gave: the cutoff before drift (Hz), the period (s) and the drift depth. */
  private cutoff = cutoffFor(35);
  private targetPeriod = slotPeriod(40);
  private targetDepth = 0.4;
  /** The period the schedule runs at, and the drift depth now. */
  private period = slotPeriod(40);
  private depth = 0.4;
  /** The slot sounding: its index, its start (s) and its crossfade's length (s). */
  private slot = 0;
  private slotStart = 0;
  private fadeLength = 0;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(key: DroneKey, seed: number, sampleRate: number) {
    const sr = sampleRate;
    this.sampleRate = sr;
    this.seed = seed;
    this.key = key;
    this.schedule = new PeriodicSchedule(seed, SLOT_STREAM, this.period);
    const base = hashStep(HASH_START, seed);
    const sideL = panLeft(-SIDE_PAN) * Math.SQRT2;
    const sideR = panRight(-SIDE_PAN) * Math.SQRT2;
    const flat = 2 ** (-SIDE_CENTS / 1200);
    this.wanders = [];
    for (let v = 0; v < 2 * GROUP_VOICES; v++) {
      const note = Math.floor(v / VOICES_PER_NOTE) % NOTES;
      const side = v % VOICES_PER_NOTE;
      const level = dbToGain(NOTE_STEP_DB * note);
      // Centre, then flat on the left, then sharp on the right.
      this.lefts[v] = level * (side === 0 ? 1 : side === 1 ? sideL : sideR);
      this.rights[v] = level * (side === 0 ? 1 : side === 1 ? sideR : sideL);
      this.detunes[v] = side === 0 ? 1 : side === 1 ? flat : 1 / flat;
      const u = hashStep(hashStep(base, WANDER_STREAM), v) * UINT32_SCALE;
      const rate = WANDER_RATE[0] + (WANDER_RATE[1] - WANDER_RATE[0]) * u;
      this.wanders.push(new DriftGenerator(seed, WANDER_STREAM * 64 + v, rate, 1, sr));
      this.wanderSwings[v] = wanderDelay(rate);
    }
    this.cutoffDrift = new DriftGenerator(
      seed,
      CUTOFF_STREAM,
      CUTOFF_DRIFT.rate,
      CUTOFF_DRIFT.octaves,
      sr,
    );
    this.flutter = new DriftGenerator(seed, FLUTTER_STREAM, FLUTTER.rate, FLUTTER.octaves, sr);
    this.shelfCoefficient = 1 - Math.exp((-2 * Math.PI * SHELF_CORNER) / sr);
  }

  /**
   * Sets the params for the next render: Brightness (0–100) and Movement
   * (0–100), whose period applies from the next slot and whose drift depth
   * slides there.
   */
  set(brightness: number, movement: number): void {
    this.cutoff = cutoffFor(brightness);
    this.targetPeriod = slotPeriod(movement);
    this.targetDepth = unitMovement(movement);
  }

  /** The slot sounding, and the voicing each group holds: for tests. */
  get state(): { slot: number; voicings: [number, number] } {
    return { slot: this.slot, voicings: [this.voicings[0], this.voicings[1]] };
  }

  /** The two groups' gains (A, B) at absolute time `t`, within the slot sounding. */
  groupGains(t: number): [number, number] {
    const [incoming, outgoing] = crossfadeGains((t - this.slotStart) / this.fadeLength);
    return this.slot % 2 === 0 ? [incoming, outgoing] : [outgoing, incoming];
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    const length = Math.min(left.length, right.length);
    if (start !== this.expected) {
      this.restart(start);
    } else if (this.targetPeriod !== this.period) {
      // From the next slot, which keeps its time but comes no later than one
      // new period after this one began, nor during this one's crossfade.
      const now = start / this.sampleRate;
      const latest = this.slotStart + Math.max(this.targetPeriod, this.fadeLength);
      this.schedule.setPeriod(this.targetPeriod, now, latest);
      this.period = this.targetPeriod;
    }
    for (let done = 0; done < length; done += QUANTUM) {
      const n = Math.min(QUANTUM, length - done);
      this.process(left, right, done, n, start + done);
    }
    this.expected = start + length;
  }

  /**
   * A fresh start, or a jump: the slots laid out afresh on absolute time, the
   * groups on the chords absolute time gives them, the drift depth at its
   * target and the filter cleared.
   */
  private restart(start: number): void {
    const t = start / this.sampleRate;
    this.period = this.targetPeriod;
    this.depth = this.targetDepth;
    this.schedule = new PeriodicSchedule(this.seed, SLOT_STREAM, this.period);
    // The slot before the next start at or after `t`: one starting at `t`
    // itself is entered as the render reaches it.
    const slot = this.schedule.nextIndex(t) - 1;
    this.enter(slot - 1, this.schedule.timeOf(slot - 1));
    this.enter(slot, this.schedule.timeOf(slot));
    this.stale[0] = true;
    this.stale[1] = true;
    this.filterState.fill(0);
    this.shelfState.fill(0);
  }

  /** Enters slot `n`, starting at `time` (s): its group takes its chord, silent. */
  private enter(n: number, time: number): void {
    this.slot = n;
    this.slotStart = time;
    this.fadeLength = this.period * FADE_SHARE;
    const group = ((n % 2) + 2) % 2;
    const voicing = slotVoicing(this.seed, n);
    this.voicings[group] = voicing;
    for (let note = 0; note < NOTES; note++) {
      const f = noteFrequency(this.key, voicing, note);
      for (let side = 0; side < VOICES_PER_NOTE; side++) {
        const v = group * GROUP_VOICES + note * VOICES_PER_NOTE + side;
        this.frequencies[v] = f * (this.detunes[v] ?? 1);
      }
    }
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
    // The drift depth slides towards Movement's.
    const step = (DEPTH_SLEW * length) / sr;
    this.depth =
      this.depth < this.targetDepth
        ? Math.min(this.targetDepth, this.depth + step)
        : Math.max(this.targetDepth, this.depth - step);

    const events = this.events;
    this.schedule.eventsIn(start / sr, (start + length) / sr, events);
    let done = 0;
    for (let e = 0; e < events.count; e++) {
      const time = events.times[e] ?? 0;
      const offset = clamp(Math.ceil(time * sr) - start, done, length);
      this.renderVoices(left, right, at, done, offset, start);
      done = offset;
      this.enter(events.indices[e] ?? 0, time);
    }
    this.renderVoices(left, right, at, done, length, start);
    this.filter(left, right, at, length, start);
  }

  /** Adds both groups' voices from `from` to `to` of this quantum into the outputs at `at`. */
  private renderVoices(
    left: Float32Array,
    right: Float32Array,
    at: number,
    from: number,
    to: number,
    start: number,
  ): void {
    if (to <= from) {
      return;
    }
    const sr = this.sampleRate;
    const t0 = (start + from) / sr;
    const t1 = (start + to) / sr;
    const length = to - from;
    const [a0, b0] = this.groupGains(t0);
    const [a1, b1] = this.groupGains(t1);
    const table = sawTable();
    const depth = this.depth;
    for (let group = 0; group < 2; group++) {
      const g0 = (group === 0 ? a0 : b0) * OUTPUT_GAIN;
      const g1 = (group === 0 ? a1 : b1) * OUTPUT_GAIN;
      if (g0 === 0 && g1 === 0) {
        this.stale[group] = true;
        continue;
      }
      const fresh = this.stale[group] ?? true;
      this.stale[group] = false;
      const gainStep = (g1 - g0) / length;
      for (let i = 0; i < GROUP_VOICES; i++) {
        const v = group * GROUP_VOICES + i;
        const wander = this.wanders[v];
        const swing = depth * (this.wanderSwings[v] ?? 0);
        const delayFrom = fresh ? swing * wander.valueAtTime(t0) : (this.delays[v] ?? 0);
        const delayTo = swing * wander.valueAtTime(t1);
        this.delays[v] = delayTo;
        const frequency = this.frequencies[v] ?? 0;
        const cycles = frequency * (t0 - delayFrom);
        let phase = cycles - Math.floor(cycles);
        const increment = (frequency * (t1 - delayTo - (t0 - delayFrom))) / length;
        const l = this.lefts[v] ?? 0;
        const r = this.rights[v] ?? 0;
        let gain = g0;
        for (let k = at + from; k < at + to; k++) {
          const position = phase * WAVE_SIZE;
          const index = Math.trunc(position);
          const a = table[index] ?? 0;
          const y = (a + ((table[index + 1] ?? 0) - a) * (position - index)) * gain;
          left[k] += l * y;
          right[k] += r * y;
          gain += gainStep;
          phase += increment;
          if (phase >= 1) {
            phase -= 1;
          }
        }
      }
    }
  }

  /** The low-pass and shelf, over the quantum in place, at the drifting cutoff. */
  private filter(
    left: Float32Array,
    right: Float32Array,
    at: number,
    length: number,
    start: number,
  ): void {
    const t = (start + length / 2) / this.sampleRate;
    const cutoff =
      this.cutoff *
      (1 +
        CUTOFF_DRIFT.reach * this.depth * this.cutoffDrift.valueAtTime(t) +
        FLUTTER.reach * this.flutter.valueAtTime(t));
    const [a1 = 0, a2 = 0, a3 = 0] = svfCoefficients(
      this.coefficients,
      cutoff,
      FILTER_Q,
      this.sampleRate,
    );
    const shelf = this.shelfCoefficient;
    const state = this.filterState;
    const shelves = this.shelfState;
    for (let side = 0; side < 2; side++) {
      const out = side === 0 ? left : right;
      let ic1 = state[2 * side] ?? 0;
      let ic2 = state[2 * side + 1] ?? 0;
      let low = shelves[side] ?? 0;
      for (let k = at; k < at + length; k++) {
        const v3 = (out[k] ?? 0) - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        // A first-order shelf: what lies above the corner, at −6 dB.
        low += shelf * (v2 - low);
        out[k] = low + SHELF_GAIN * (v2 - low);
      }
      state[2 * side] = ic1;
      state[2 * side + 1] = ic2;
      shelves[side] = low;
    }
  }
}
