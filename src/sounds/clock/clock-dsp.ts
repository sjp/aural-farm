/**
 * Ticking Clock's seeded parts: pure code with no Web Audio globals, run by
 * `clock.worklet.ts` and checked in Node.
 *
 * The worklet makes one clock, for one seed, heard from the next armchair:
 *
 * - **Beats.** Beat n falls at `n · beat + skew(n) + jitter(n)` seconds of
 *   absolute time: `periodic.ts`'s grid at the clock's beat, each beat
 *   ±0.8 ms off it, and every odd beat (the tock) late by the clock's beat
 *   error, a seeded 1–3 % of the beat, so the gaps after tick and after tock
 *   differ a little, as in a real clock never quite in beat.
 * - **Clicks.** Each beat is a 1.5 ms burst of hashed white noise dying away
 *   in 0.4 ms, the pallet landing, with a burst 14 dB quieter 6–12 ms before
 *   it (seeded), the escape-wheel tooth dropping. They ring the case: a bank
 *   of four band-pass resonators (`svf.ts`'s filter, run inline) and, for the
 *   wall and grandfather clocks, a low case thump. Tocks ring the same bank
 *   4 % lower and 1.5 dB quieter, and every beat's modes vary by ±1 dB.
 * - **Tone.** The ring passes a one-pole low-pass, 2.5 kHz at Tone 0 to
 *   6.5 kHz at 100, latched as each beat starts.
 * - **Chime.** If on, a soft chime at each whole hour of absolute time from
 *   the first hour on: a descending fourth, two notes 0.9 s apart, each three
 *   inharmonic partials with a 6 ms attack. Not at time 0: a chime the
 *   moment playback starts would startle rather than mark the hour.
 * - **Room tone.** A very faint rumble of noise on each side, so the gaps
 *   between beats aren't digital silence.
 *
 * The clock sits a little off centre, by the seed. Every beat's start and detail come from the seed and its index, and the
 * chime from the hour, so the output depends only on absolute time: a fresh
 * render first runs the clicks alone, unheard, for as long as one rings, so a
 * beat struck just before it rings on as it would have.
 */
import { panLeft, panRight } from "../../audio/dsp/pan";
import { PeriodicSchedule } from "../../audio/dsp/periodic";
import { svfCoefficients } from "../../audio/dsp/svf";
import { HASH_START, hash32, hashStep, UINT32_SCALE } from "../../audio/random";
import type { ClockType } from "./clock.meta";

export const CLOCK_PROCESSOR = "aural-clock";
/** The worklet's output channels: left and right. */
export const CLOCK_CHANNELS = 2;

const dbToGain = (db: number) => 10 ** (db / 20);

/** Random streams: each source of randomness its own. */
const JITTER_STREAM = 1;
const MODE_STREAM = 2;
const NOISE_STREAM = 3;
const SKEW_STREAM = 4;
const PRE_STREAM = 5;
const PAN_STREAM = 6;
const ROOM_STREAM = 7;

// ---------------------------------------------------------------------------
// The clocks.

interface ClockSpec {
  /** Seconds between beats. */
  beat: number;
  /** The case's modes: frequency (Hz), the time to fall 60 dB (s) and level (dB). */
  modes: readonly (readonly [number, number, number])[];
  /** The click's level, in dB: a default tick peaks about −10 dBFS. */
  tickDb: number;
  /** The chime's first note, in Hz. */
  root: number;
  /** The chime's level, in dB: it peaks about 10 dB below a tick. */
  chimeDb: number;
}

/**
 * Each clock's beat and case. The four modes fall off by 3 dB each; the wall
 * and grandfather clocks' last mode is their case's low thump.
 */
export const CLOCKS: Readonly<Record<ClockType, ClockSpec>> = {
  mantel: {
    beat: 0.45,
    modes: [
      [1850, 0.035, 0],
      [2900, 0.025, -3],
      [4300, 0.018, -6],
      [5600, 0.012, -9],
    ],
    tickDb: -29.9,
    root: 523,
    chimeDb: -24,
  },
  wall: {
    beat: 0.75,
    modes: [
      [1100, 0.045, 0],
      [1750, 0.035, -3],
      [2700, 0.025, -6],
      [4100, 0.015, -9],
      [260, 0.06, -2],
    ],
    tickDb: -32.7,
    root: 392,
    chimeDb: -24,
  },
  grandfather: {
    beat: 1,
    modes: [
      [620, 0.08, 0],
      [1050, 0.06, -3],
      [1600, 0.045, -6],
      [2500, 0.03, -9],
      [140, 0.11, 0],
    ],
    tickDb: -34.9,
    root: 262,
    chimeDb: -24,
  },
};

/** Seconds between a tick and the next tick: the rhythm's period. */
export function tickTockPeriod(type: ClockType): number {
  return 2 * CLOCKS[type].beat;
}

/** How far a beat may stray from its place, in seconds either way. */
export const JITTER = 0.0008;
/** The tock's beat error, as a share of the beat. */
const SKEW_MIN = 0.01;
const SKEW_MAX = 0.03;
/** The pre-click's lead, in seconds. */
const PRE_MIN = 0.006;
const PRE_MAX = 0.012;
/** The pre-click's level against the main click, in dB. */
const PRE_DB = -14;
/** A click's burst, and its decay's time constant, in seconds. */
const BURST = 0.0015;
const BURST_DECAY = 0.0004;
/** The tock's bank: every mode this much lower, and this much quieter (dB). */
const TOCK_RATIO = 0.96;
const TOCK_DB = -1.5;
/** How far each beat's modes vary, in dB either way. */
const MODE_SPREAD_DB = 1;
/** A beat rings until its modes have fallen this far, in dB. */
const RING_FLOOR_DB = 80;
/** How far off centre the clock may sit, either way (−1 to 1). */
const PAN_SPREAD = 0.15;

/** The tone low-pass's cutoff at Tone `tone` (0–100), in Hz. */
export function toneCutoff(tone: number): number {
  return 2500 + 40 * Math.min(100, Math.max(0, tone));
}

/** The clock's beat error for `seed`: how late every tock is, in seconds. */
export function tockSkew(type: ClockType, seed: number): number {
  const u = hash32(seed, SKEW_STREAM) * UINT32_SCALE;
  return (SKEW_MIN + (SKEW_MAX - SKEW_MIN) * u) * CLOCKS[type].beat;
}

/** The pre-click's lead for `seed`, in seconds. */
export function preClickLead(seed: number): number {
  const u = hash32(seed, PRE_STREAM) * UINT32_SCALE;
  return PRE_MIN + (PRE_MAX - PRE_MIN) * u;
}

/** The longest a beat rings, from its pre-click, in seconds. */
export function ringLength(type: ClockType): number {
  let longest = 0;
  for (const [, t60] of CLOCKS[type].modes) {
    longest = Math.max(longest, t60);
  }
  return PRE_MAX + BURST + (longest * RING_FLOOR_DB) / 60;
}

/**
 * A clock's beats for one seed: beat n's absolute time, from `periodic.ts`'s
 * grid with the tocks' skew on top.
 */
export class Beats {
  private readonly schedule: PeriodicSchedule;
  readonly skew: number;

  constructor(type: ClockType, seed: number) {
    const { beat } = CLOCKS[type];
    this.schedule = new PeriodicSchedule(seed, JITTER_STREAM, beat, JITTER / beat);
    this.skew = tockSkew(type, seed);
  }

  /** Beat n's absolute time, in seconds. */
  timeOf(n: number): number {
    return this.schedule.timeOf(n) + ((n & 1) === 1 ? this.skew : 0);
  }

  /** The first beat whose time could be at or after `t`. */
  firstFrom(t: number): number {
    return this.schedule.nextIndex(t - this.skew);
  }
}

// ---------------------------------------------------------------------------
// The chime.

/** The chime's notes start this far apart, in seconds. */
const CHIME_GAP = 0.9;
/** The second note is a fourth below the first. */
const CHIME_STEP = 3 / 4;
/** The partials, as ratios of the note, and their levels (dB). */
const CHIME_RATIOS = [1, 2.76, 5.4] as const;
const CHIME_PARTIAL_DB = [0, -10, -20] as const;
/** The attack, and the fundamental's time to fall 60 dB, in seconds; higher partials die sooner. */
const CHIME_ATTACK = 0.006;
const CHIME_T60 = 3;
/** The chime's span, until its last note has fallen 80 dB, in seconds. */
export const CHIME_LENGTH = CHIME_GAP + (CHIME_T60 * RING_FLOOR_DB) / 60;
/** An hour, in seconds. */
export const HOUR = 3600;
/** The chime's on/off glide, in seconds. */
const CHIME_GLIDE = 0.05;
/** Notes × partials. */
const CHIME_PARTIALS = 2 * CHIME_RATIOS.length;

// ---------------------------------------------------------------------------
// The room tone.

/** The room tone's level, in dBFS RMS per side: very faint, so the gaps between beats aren't digital silence. */
export const ROOM_TONE_DB = -60;
/** Its low-pass, in Hz: a soft, brown-like rumble above it. */
const ROOM_LOW = 60;
/** Its high-pass, in Hz: clear of the sub-bass, which would outweigh the quiet clock's low end. */
const ROOM_HIGH = 50;
/** Maps a 16-bit half of a hash to [0, 2). */
const WHITE_SCALE = 2 / 65536;

/**
 * The RMS of uniform white noise in [−1, 1) through the room tone's one-pole
 * low-pass and high-pass, at `sampleRate`: from their responses' power,
 * summed over the spectrum.
 */
function roomToneRms(sampleRate: number): number {
  const low = Math.exp((-2 * Math.PI * ROOM_LOW) / sampleRate);
  const high = Math.exp((-2 * Math.PI * ROOM_HIGH) / sampleRate);
  const bins = 4096;
  let sum = 0;
  for (let k = 0; k < bins; k++) {
    const w = (Math.PI * (k + 0.5)) / bins;
    const c = Math.cos(w);
    // |1 − p|² / |1 − p·e^{−jw}|² for the low-pass; the high-pass is one minus its own low-pass.
    const lowPower = (1 - low) ** 2 / (1 - 2 * low * c + low * low);
    const highPower = ((2 - 2 * c) * high ** 2) / (1 - 2 * high * c + high * high);
    sum += lowPower * highPower;
  }
  return Math.sqrt(sum / bins / 3);
}

// ---------------------------------------------------------------------------
// The kernel.

const QUANTUM = 128;
/** Each mode's resonator state: two values per mode, per voice. */
const STATE = 2;
/** Up to five modes: four and the thump. */
const MAX_MODES = 5;

/** One beat's ring: a tick's or a tock's bank. */
interface Voice {
  active: boolean;
  /** The absolute sample its pre-click starts on. */
  start: number;
  /** The sample, from `start`, its main click starts on. */
  main: number;
  /** The beat's index, for its hashed noise. */
  beat: number;
  /** Each mode's input gain this beat. */
  readonly gains: Float64Array;
  /** Each mode's resonator state. */
  readonly state: Float64Array;
}

/**
 * The Ticking Clock worklet's output for one clock and seed, from absolute
 * samples: the same whether rendered in one go or in chunks, at steady params.
 */
export class ClockKernel {
  private readonly sampleRate: number;
  private readonly beats: Beats;
  private readonly modeCount: number;
  /** [a1, a2, a3, k] per mode: the tick's bank, then the tock's. */
  private readonly tickCoefficients: Float64Array;
  private readonly tockCoefficients: Float64Array;
  /** Each mode's output gain, so it rings at its level whatever its Q. */
  private readonly tickOut: Float64Array;
  private readonly tockOut: Float64Array;
  private readonly modeLevels: Float64Array;
  private readonly modePrefix: number;
  private readonly noisePrefix: number;
  private readonly pre: number;
  private readonly burst: number;
  private readonly burstDecay: number;
  private readonly ringSamples: number;
  private readonly preGain: number;
  private readonly left: number;
  private readonly right: number;
  /** Tick (even beats) and tock (odd beats): each rings in its own voice. */
  private readonly voices: Voice[];
  private readonly mono = new Float64Array(QUANTUM);
  /** The tone low-pass: its pole and state. */
  private tonePole = 0;
  private toneState = 0;
  private tone = 35;
  /** The chime's level (0–1), gliding to its target. */
  private chimeLevel = 0;
  private chimeTarget = 0;
  private readonly chimeGlide: number;
  private readonly chimeFrequencies = new Float64Array(CHIME_PARTIALS);
  private readonly chimeGains = new Float64Array(CHIME_PARTIALS);
  private readonly chimeDecays = new Float64Array(CHIME_PARTIALS);
  private readonly chimeStarts = new Float64Array(CHIME_PARTIALS);
  private readonly hourSamples: number;
  private readonly chimeSamples: number;
  private readonly attackSamples: number;
  /** The absolute sample the next render should start on, or NaN before the first. */
  private next = Number.NaN;
  /** The room tone: its filters' poles, its gain and their state per side. */
  private readonly roomPrefix: number;
  private readonly roomLowPole: number;
  private readonly roomHighPole: number;
  private readonly roomGain: number;
  private roomLowL = 0;
  private roomLowR = 0;
  private roomSlowL = 0;
  private roomSlowR = 0;

  /** `roomTone` false leaves the room tone out, so the beats alone can be checked. */
  constructor(type: ClockType, seed: number, sampleRate: number, roomTone = true) {
    const spec = CLOCKS[type];
    this.sampleRate = sampleRate;
    this.beats = new Beats(type, seed);
    this.modeCount = spec.modes.length;
    this.tickCoefficients = new Float64Array(4 * this.modeCount);
    this.tockCoefficients = new Float64Array(4 * this.modeCount);
    this.tickOut = new Float64Array(this.modeCount);
    this.tockOut = new Float64Array(this.modeCount);
    this.modeLevels = new Float64Array(this.modeCount);
    const into = new Float64Array(4);
    const tickGain = dbToGain(spec.tickDb);
    for (let m = 0; m < this.modeCount; m++) {
      const [frequency, t60, levelDb] = spec.modes[m];
      this.modeLevels[m] = dbToGain(levelDb);
      // A two-pole resonator falls 60 dB in t60 at Q = π·f·t60 / ln(1000).
      const q = (Math.PI * frequency * t60) / Math.log(1000);
      this.setBank(this.tickCoefficients, this.tickOut, m, frequency, q, into, tickGain);
      this.setBank(
        this.tockCoefficients,
        this.tockOut,
        m,
        frequency * TOCK_RATIO,
        q,
        into,
        tickGain * dbToGain(TOCK_DB),
      );
    }
    this.modePrefix = hashStep(hashStep(HASH_START, seed), MODE_STREAM);
    this.noisePrefix = hashStep(hashStep(HASH_START, seed), NOISE_STREAM);
    this.pre = Math.round(preClickLead(seed) * sampleRate);
    this.burst = Math.max(1, Math.round(BURST * sampleRate));
    this.burstDecay = Math.exp(-1 / (BURST_DECAY * sampleRate));
    this.ringSamples = Math.ceil(ringLength(type) * sampleRate);
    this.preGain = dbToGain(PRE_DB);
    const pan = (2 * (hash32(seed, PAN_STREAM) * UINT32_SCALE) - 1) * PAN_SPREAD;
    this.left = panLeft(pan) * Math.SQRT2;
    this.right = panRight(pan) * Math.SQRT2;
    this.voices = [0, 1].map(() => ({
      active: false,
      start: 0,
      main: 0,
      beat: 0,
      gains: new Float64Array(MAX_MODES),
      state: new Float64Array(STATE * MAX_MODES),
    }));
    this.setTone(this.tone);

    this.chimeGlide = Math.exp(-QUANTUM / (CHIME_GLIDE * sampleRate));
    const chimeGain = dbToGain(spec.chimeDb);
    for (let note = 0; note < 2; note++) {
      const f = spec.root * CHIME_STEP ** note;
      for (let p = 0; p < CHIME_RATIOS.length; p++) {
        const i = note * CHIME_RATIOS.length + p;
        this.chimeFrequencies[i] = (2 * Math.PI * f * CHIME_RATIOS[p]) / sampleRate;
        this.chimeGains[i] = chimeGain * dbToGain(CHIME_PARTIAL_DB[p]);
        // Falls 60 dB in CHIME_T60 / √ratio: the higher partials die sooner.
        const t60 = CHIME_T60 / Math.sqrt(CHIME_RATIOS[p]);
        this.chimeDecays[i] = Math.log(1000) / (t60 * sampleRate);
        this.chimeStarts[i] = Math.round(note * CHIME_GAP * sampleRate);
      }
    }
    this.hourSamples = HOUR * sampleRate;
    this.chimeSamples = Math.ceil(CHIME_LENGTH * sampleRate);
    this.attackSamples = Math.max(1, Math.round(CHIME_ATTACK * sampleRate));

    this.roomPrefix = hashStep(hashStep(HASH_START, seed), ROOM_STREAM);
    this.roomLowPole = Math.exp((-2 * Math.PI * ROOM_LOW) / sampleRate);
    this.roomHighPole = Math.exp((-2 * Math.PI * ROOM_HIGH) / sampleRate);
    this.roomGain = roomTone ? dbToGain(ROOM_TONE_DB) / roomToneRms(sampleRate) : 0;
  }

  private setBank(
    coefficients: Float64Array,
    out: Float64Array,
    m: number,
    frequency: number,
    q: number,
    into: Float64Array,
    gain: number,
  ): void {
    svfCoefficients(into, frequency, q, this.sampleRate);
    coefficients.set(into, 4 * m);
    // The resonator's band output, v1, rings at about a2 (≈ g) for a unit
    // impulse; dividing it out rings every mode at its own level.
    out[m] = gain / into[1];
  }

  private setTone(tone: number): void {
    this.tone = tone;
    this.tonePole = Math.exp((-2 * Math.PI * toneCutoff(tone)) / this.sampleRate);
  }

  /** Takes the params: Tone (0–100, latched as each beat starts) and the chime (0 or 1). */
  set(tone: number, chime: number): void {
    this.tone = tone;
    this.chimeTarget = chime > 0.5 ? 1 : 0;
  }

  /**
   * Renders one block of up to 128 samples into `left` and `right`, from
   * absolute sample `frame`.
   */
  render(left: Float32Array, right: Float32Array, frame: number): void {
    const length = Math.min(left.length, right.length, QUANTUM);
    if (frame !== this.next) {
      // A fresh start, or a jump: run the clicks unheard for as long as one
      // rings, so one struck just before this rings on.
      for (const v of this.voices) {
        v.active = false;
      }
      this.chimeLevel = this.chimeTarget;
      for (let f = frame - this.ringSamples; f < frame; f += QUANTUM) {
        this.renderMono(f, Math.min(QUANTUM, frame - f));
      }
    }
    this.next = frame + length;
    this.renderMono(frame, length);
    this.renderChime(frame, length);
    // The clock, panned, over the room tone: each sample's hash gives both
    // sides' white noise, one in each half, low-passed into a soft rumble and
    // high-passed clear of the sub-bass.
    const mono = this.mono;
    const lp = this.roomLowPole;
    const hp = this.roomHighPole;
    const gain = this.roomGain;
    let lowL = this.roomLowL;
    let lowR = this.roomLowR;
    let slowL = this.roomSlowL;
    let slowR = this.roomSlowR;
    for (let i = 0; i < length; i++) {
      const h = hashStep(this.roomPrefix, frame + i);
      const whiteL = (h & 0xffff) * WHITE_SCALE - 1;
      const whiteR = (h >>> 16) * WHITE_SCALE - 1;
      lowL = whiteL + lp * (lowL - whiteL);
      lowR = whiteR + lp * (lowR - whiteR);
      slowL = lowL + hp * (slowL - lowL);
      slowR = lowR + hp * (slowR - lowR);
      left[i] = mono[i] * this.left + (lowL - slowL) * gain;
      right[i] = mono[i] * this.right + (lowR - slowR) * gain;
    }
    this.roomLowL = lowL;
    this.roomLowR = lowR;
    this.roomSlowL = slowL;
    this.roomSlowR = slowR;
  }

  /** Starts the beats whose pre-click falls in [frame, frame + length). */
  private startBeats(frame: number, length: number): void {
    const sr = this.sampleRate;
    const end = frame + length;
    // Beat n's main click is at round(timeOf(n)·sr), its pre-click `pre` before.
    const from = (frame + this.pre - 1) / sr;
    for (let n = this.beats.firstFrom(from); ; n++) {
      const main = Math.round(this.beats.timeOf(n) * sr);
      const start = main - this.pre;
      if (start >= end) {
        break;
      }
      if (start < frame) {
        continue;
      }
      const v = this.voices[n & 1];
      v.active = true;
      v.start = start;
      v.main = this.pre;
      v.beat = n;
      v.state.fill(0);
      const tock = (n & 1) === 1;
      const out = tock ? this.tockOut : this.tickOut;
      const beatPrefix = hashStep(this.modePrefix, n);
      for (let m = 0; m < this.modeCount; m++) {
        const u = hashStep(beatPrefix, m) * UINT32_SCALE;
        v.gains[m] = this.modeLevels[m] * out[m] * dbToGain((2 * u - 1) * MODE_SPREAD_DB);
      }
      // Tone latches as each beat starts.
      this.setTone(this.tone);
    }
  }

  /** The clicks and their ring, through the tone low-pass, into `mono`. */
  private renderMono(frame: number, length: number): void {
    const mono = this.mono;
    mono.fill(0, 0, length);
    this.startBeats(frame, length);
    if (!this.voices[0].active && !this.voices[1].active && this.toneState === 0) {
      // Between beats: nothing rings.
      return;
    }
    for (let vi = 0; vi < 2; vi++) {
      const v = this.voices[vi];
      if (!v.active) {
        continue;
      }
      const c = (v.beat & 1) === 1 ? this.tockCoefficients : this.tickCoefficients;
      const noise = hashStep(this.noisePrefix, v.beat);
      const first = Math.max(0, v.start - frame);
      let age = frame + first - v.start;
      // It rings until its modes have died away, to the sample.
      const last = Math.min(length, v.start + this.ringSamples - frame);
      const state = v.state;
      for (let i = first; i < last; i++, age++) {
        // The pre-click's burst, then the main click's.
        let x = 0;
        if (age < this.burst) {
          const u = hashStep(noise, age) * UINT32_SCALE;
          x = (2 * u - 1) * this.preGain * this.burstDecay ** age;
        } else {
          const a = age - v.main;
          if (a >= 0 && a < this.burst) {
            const u = hashStep(noise, age) * UINT32_SCALE;
            x = (2 * u - 1) * this.burstDecay ** a;
          }
        }
        let sum = 0;
        for (let m = 0, j = 0, s = 0; m < this.modeCount; m++, j += 4, s += STATE) {
          const ic1 = state[s];
          const ic2 = state[s + 1];
          const v3 = x * v.gains[m] - ic2;
          const v1 = c[j] * ic1 + c[j + 1] * v3;
          const v2 = ic2 + c[j + 1] * ic1 + c[j + 2] * v3;
          state[s] = 2 * v1 - ic1;
          state[s + 1] = 2 * v2 - ic2;
          sum += v1;
        }
        mono[i] = sum;
      }
      if (last < length) {
        v.active = false;
      }
    }
    // The tone low-pass.
    const pole = this.tonePole;
    let y = this.toneState;
    for (let i = 0; i < length; i++) {
      y = mono[i] + pole * (y - mono[i]);
      mono[i] = y;
    }
    // Flush denormals once the ring has died away.
    this.toneState = Math.abs(y) < 1e-20 ? 0 : y;
  }

  /** Adds the hour's chime, if one is sounding, to `mono`. */
  private renderChime(frame: number, length: number): void {
    this.chimeLevel = this.chimeTarget + this.chimeGlide * (this.chimeLevel - this.chimeTarget);
    if (this.chimeTarget === 0 && this.chimeLevel < 1e-4) {
      this.chimeLevel = 0;
      return;
    }
    const hour = Math.floor(frame / this.hourSamples);
    const since = frame - hour * this.hourSamples;
    if (hour < 1 || since >= this.chimeSamples) {
      return;
    }
    const mono = this.mono;
    const level = this.chimeLevel;
    // It sounds until its last note has died away, to the sample.
    const end = Math.min(length, this.chimeSamples - since);
    for (let p = 0; p < CHIME_PARTIALS; p++) {
      const first = Math.max(0, this.chimeStarts[p] - since);
      if (first >= end) {
        continue;
      }
      let age = since + first - this.chimeStarts[p];
      // Each partial from its exact phase and level at this block's start,
      // then turned and decayed sample by sample.
      const w = this.chimeFrequencies[p];
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      let re = Math.cos(w * age);
      let im = Math.sin(w * age);
      const decay = Math.exp(-this.chimeDecays[p]);
      let env = level * this.chimeGains[p] * Math.exp(-this.chimeDecays[p] * age);
      for (let i = first; i < end; i++, age++) {
        const attack = age < this.attackSamples ? age / this.attackSamples : 1;
        mono[i] += im * env * attack;
        const r = re * cw - im * sw;
        im = re * sw + im * cw;
        re = r;
        env *= decay;
      }
    }
  }
}

interface ClockOptions {
  type: ClockType;
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const isClockType = (value: unknown): value is ClockType =>
  typeof value === "string" && Object.hasOwn(CLOCKS, value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readClockOptions(raw: unknown): ClockOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const type = get("type");
  return {
    type: isClockType(type) ? type : "mantel",
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}
