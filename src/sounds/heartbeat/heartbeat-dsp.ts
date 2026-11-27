/**
 * Heartbeat's seeded parts: pure code with no Web Audio globals, run by
 * `heartbeat.worklet.ts` and checked in Node.
 *
 * The worklet makes a resting heart heard from inside, before the muffling
 * low-pass (native, after it):
 *
 * - **Beats.** Beat n falls at `(n + v(n)) · T` seconds of absolute time, on
 *   `periodic.ts`'s grid at the period `T = 60 / rate`. Its offset `v(n)`
 *   is a pure function of the seed and n: a slow drift (value noise over the
 *   beats, a new value every 8, ±3 %), a sway with the breath (a sine over a
 *   4.3-beat cycle, ±1.5 %) and a little per-beat scatter (±0.5 %), so the
 *   rhythm is alive but never strays from its rate on average. A rate change
 *   re-anchors the grid at the next beat, which keeps its time (or comes
 *   sooner, when the new rate is faster), so no beat is doubled or dropped.
 * - **Lub and dub.** Each beat is two low thumps: a sine sweeping down
 *   (62 → 46 Hz for the lub, 74 → 56 Hz for the dub, over 70 ms), with its
 *   2nd and 3rd harmonics and a short band-passed noise thump at 220 Hz, so
 *   the beat carries on small speakers. The dub is 5 dB softer and comes
 *   `0.24 + 0.1 · T` seconds after the lub. Each has a 6 ms raised-cosine
 *   attack and an exponential decay that lands exactly on zero at its end.
 *   Every beat's strength varies by ±1 dB.
 * - **Flow.** Brown noise, band-limited to 40–280 Hz, swelling to full over
 *   120 ms after each lub and easing away between beats, never below 35 %.
 *
 * Every beat comes from the seed and its index, and the noise from the
 * absolute sample, so at steady params the output depends only on absolute
 * time: a fresh render first runs unheard for as long as a beat and its flow
 * last, so it picks up the beat sounding as it would have.
 */
import { PeriodicSchedule } from "../../audio/dsp/periodic";
import { svfCoefficients } from "../../audio/dsp/svf";
import { HASH_START, hashStep, UINT32_SCALE } from "../../audio/random";
import { MAX_RATE, MIN_RATE } from "./heartbeat.meta";

export const HEARTBEAT_PROCESSOR = "aural-heartbeat";
/** The worklet's output channels: one, as the heart is heard from inside, everywhere at once. */
export const HEARTBEAT_CHANNELS = 1;

const dbToGain = (db: number) => 10 ** (db / 20);

/** Random streams: each source of randomness its own. */
const DRIFT_STREAM = 1;
const SCATTER_STREAM = 2;
const SWAY_STREAM = 3;
const STRENGTH_STREAM = 4;
const THUMP_STREAM = 5;
const FLOW_STREAM = 6;

// ---------------------------------------------------------------------------
// Timing.

/** The slow drift: its reach either way (a share of the period), and the beats between its values. */
export const DRIFT = 0.03;
const DRIFT_SPAN = 8;
/** The sway with the breath: its reach either way, and its cycle in beats. */
export const SWAY = 0.015;
const SWAY_CYCLE = 4.3;
/** Each beat's own scatter, either way. */
export const SCATTER = 0.005;

/** The period, in seconds, at `rate` beats a minute (held within its range). */
export function beatPeriod(rate: number): number {
  return 60 / Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/**
 * Beat n's offset from its place on the grid, as a share of the period, for
 * `seed`: a pure function of the two. Allocates nothing.
 */
export function beatOffset(seed: number): (n: number) => number {
  const seedHash = hashStep(HASH_START, seed);
  const drift = hashStep(seedHash, DRIFT_STREAM);
  const scatter = hashStep(seedHash, SCATTER_STREAM);
  const phase = 2 * Math.PI * hashStep(seedHash, SWAY_STREAM) * UINT32_SCALE;
  const value = (k: number) => 2 * hashStep(drift, k) * UINT32_SCALE - 1;
  return (n) => {
    const k = Math.floor(n / DRIFT_SPAN);
    const f = n / DRIFT_SPAN - k;
    const a = value(k);
    const w = 0.5 - 0.5 * Math.cos(Math.PI * f);
    const slow = DRIFT * (a + (value(k + 1) - a) * w);
    const sway = SWAY * Math.sin((2 * Math.PI * n) / SWAY_CYCLE + phase);
    const own = SCATTER * (2 * hashStep(scatter, n) * UINT32_SCALE - 1);
    return slow + sway + own;
  };
}

/**
 * A heart's beats for one seed: beat n's absolute time, re-anchored at the next
 * beat when the rate changes.
 */
export class HeartBeats {
  private readonly seed: number;
  private readonly offset: (n: number) => number;
  private schedule: PeriodicSchedule;
  /** The period the beats follow now, in seconds. */
  period: number;

  constructor(seed: number, rate: number) {
    this.seed = seed;
    this.offset = beatOffset(seed);
    this.period = beatPeriod(rate);
    this.schedule = this.grid();
  }

  private grid(): PeriodicSchedule {
    return new PeriodicSchedule(this.seed, DRIFT_STREAM, this.period, this.offset);
  }

  /** Lays the beats out afresh on absolute time at `rate`, as a fresh render finds them. */
  reset(rate: number): void {
    this.period = beatPeriod(rate);
    this.schedule = this.grid();
  }

  /**
   * Moves to `rate` from the first beat at or after `t` (absolute seconds):
   * that beat keeps its time, or comes a new period after `t` if that is
   * sooner, and the new spacing follows it.
   */
  setRate(rate: number, t: number): void {
    const period = beatPeriod(rate);
    if (period !== this.period) {
      this.period = period;
      this.schedule.setPeriod(period, t, t + period);
    }
  }

  /** Beat n's absolute time, in seconds. */
  timeOf(n: number): number {
    return this.schedule.timeOf(n);
  }

  /** The first beat at or after `t` (absolute seconds). */
  firstFrom(t: number): number {
    return this.schedule.nextIndex(t);
  }
}

// ---------------------------------------------------------------------------
// Lub and dub.

interface ThumpSpec {
  /** The sweep's start and end, in Hz. */
  from: number;
  to: number;
  /** The decay's time constant, in seconds. */
  decay: number;
  /** Its level against the lub, in dB. */
  db: number;
}

export const LUB: ThumpSpec = { from: 62, to: 46, decay: 0.11, db: 0 };
export const DUB: ThumpSpec = { from: 74, to: 56, decay: 0.08, db: -5 };

/** The sweep's length, and the attack's, in seconds. */
const SWEEP = 0.07;
const ATTACK = 0.006;
/** A thump lasts this many of its decay's time constants, ending on zero. */
const DECAY_SPANS = 5;
/** The 2nd and 3rd harmonics' levels, in dB. */
const HARMONIC_2_DB = -8;
const HARMONIC_3_DB = -14;
/** The noise thump: its band (Hz), Q, length (s) and level against the sine's (dB, RMS). */
const NOISE_CENTRE = 220;
const NOISE_Q = 1.2;
const NOISE_LENGTH = 0.04;
const NOISE_DB = -12;
/** The band-pass rings on this long after its noise, dying away well below hearing. */
const NOISE_RING = 0.02;
/** How far each beat's strength varies, in dB either way. */
const STRENGTH_SPREAD_DB = 1;
/** The lub's sine at full strength: its peak level, in dBFS (before the harmonics add up). */
const LUB_DB = -9.4;

/** The dub's delay after the lub, in seconds, at period `period`. */
export function dubDelay(period: number): number {
  return 0.24 + 0.1 * period;
}

/** How long a thump lasts, from its start, in seconds. */
export function thumpLength(spec: ThumpSpec): number {
  return DECAY_SPANS * spec.decay;
}

// ---------------------------------------------------------------------------
// Flow.

/** The flow's swell after each lub, in seconds, and its floor (0–1) between beats. */
const SWELL = 0.12;
export const FLOW_FLOOR = 0.35;
/** Its decay's time constant, as a share of the period. */
const EASE = 0.45;
/** The brown noise's corner, and the band it is held in, in Hz, with each filter's Q. */
const BROWN_CORNER = 25;
const FLOW_HIGHPASS = 40;
const FLOW_HIGHPASS_Q = Math.SQRT1_2;
const FLOW_LOWPASS = 280;
const FLOW_LOWPASS_Q = 0.5;
/**
 * The flow's level at Flow 100, against the beats' long-term level, in dB:
 * the beats' RMS at the default rate, measured, so the flow sits 4 dB under.
 */
const BEATS_RMS_DB = -23.4;
const FLOW_DB = BEATS_RMS_DB - 4;
/** Flow's glide, in seconds. */
const BED_GLIDE = 0.1;

/**
 * The flow is computed at an eighth of the sample rate, as it holds nothing
 * above a few hundred hertz, and joined up with straight lines: their images
 * near multiples of 6 kHz sit some 50 dB down, under the muffle.
 */
const FLOW_DECIMATION = 8;
const FLOW_MASK = FLOW_DECIMATION - 1;

/** Maps a 32-bit hash to [−1, 1). */
const WHITE_SCALE = 2 * UINT32_SCALE;

/**
 * The RMS of uniform white noise in [−1, 1) through the flow's filters at
 * `sampleRate`, with the envelope at full: from their responses' power,
 * summed over the spectrum. The two state-variable filters are the bilinear
 * transforms of their analogue prototypes, prewarped at the cutoff.
 */
function flowRms(sampleRate: number): number {
  const brown = Math.exp((-2 * Math.PI * BROWN_CORNER) / sampleRate);
  const gHigh = Math.tan((Math.PI * FLOW_HIGHPASS) / sampleRate);
  const gLow = Math.tan((Math.PI * FLOW_LOWPASS) / sampleRate);
  const bins = 8192;
  let sum = 0;
  for (let k = 0; k < bins; k++) {
    const w = (Math.PI * (k + 0.5)) / bins;
    const brownPower = (1 - brown) ** 2 / (1 - 2 * brown * Math.cos(w) + brown * brown);
    const t = Math.tan(w / 2);
    const xh = t / gHigh;
    const highPower = xh ** 4 / ((1 - xh * xh) ** 2 + (xh / FLOW_HIGHPASS_Q) ** 2);
    const xl = t / gLow;
    const lowPower = 1 / ((1 - xl * xl) ** 2 + (xl / FLOW_LOWPASS_Q) ** 2);
    sum += brownPower * highPower * lowPower;
  }
  return Math.sqrt(sum / bins / 3);
}

/**
 * The power uniform white noise in [−1, 1) keeps through the noise thump's
 * band-pass, run twice, at `sampleRate`: summed over the spectrum, from the
 * analogue prototype's response, prewarped at the centre.
 */
function thumpBandPower(sampleRate: number): number {
  const g = Math.tan((Math.PI * NOISE_CENTRE) / sampleRate);
  const bins = 8192;
  let sum = 0;
  for (let k = 0; k < bins; k++) {
    const x = Math.tan((Math.PI * (k + 0.5)) / bins / 2) / g;
    const power = (x / NOISE_Q) ** 2 / ((1 - x * x) ** 2 + (x / NOISE_Q) ** 2);
    sum += power * power;
  }
  return sum / bins / 3;
}

/** The flow's gain at Flow `bed` (0–100): off at 0. */
export function flowLevel(bed: number): number {
  return Math.min(100, Math.max(0, bed)) / 100;
}

// ---------------------------------------------------------------------------
// The kernel.

const QUANTUM = 128;
/** A fresh render runs this long unheard first: a whole beat at the slowest rate, its dub and flow. */
const WARM_UP = 1.6;

/** One lub or dub, sounding. */
interface Voice {
  active: boolean;
  /** The absolute sample it starts on. */
  start: number;
  /** How many samples it lasts, ending on zero. */
  length: number;
  /**
   * Its sine as a turning phasor (cosine, sine), its step (radians a sample)
   * falling each sample of the sweep, and the step's cosine and sine.
   */
  re: number;
  im: number;
  step: number;
  sweepFall: number;
  cw: number;
  sw: number;
  /** Its decay: the falling exponential, its fall a sample, and where it lands at the end. */
  decay: number;
  fall: number;
  floor: number;
  /** Its level this beat, and its noise thump's. */
  gain: number;
  noiseGain: number;
  /** Its noise's hash prefix, and its band-pass's state. */
  noise: number;
  ic1: number;
  ic2: number;
  ic3: number;
  ic4: number;
}

const newVoice = (): Voice => ({
  active: false,
  start: 0,
  length: 0,
  re: 1,
  im: 0,
  step: 0,
  sweepFall: 1,
  cw: 1,
  sw: 0,
  decay: 1,
  fall: 1,
  floor: 0,
  gain: 0,
  noiseGain: 0,
  noise: 0,
  ic1: 0,
  ic2: 0,
  ic3: 0,
  ic4: 0,
});

/**
 * The Heartbeat worklet's output for one seed, from absolute samples: the same
 * whether rendered in one go or in chunks, at steady params.
 */
export class HeartbeatKernel {
  private readonly sampleRate: number;
  private readonly beats: HeartBeats;
  /** Lub and dub of even beats, then of odd ones: each rings in its own voice. */
  private readonly voices: Voice[];
  private readonly strengthPrefix: number;
  private readonly thumpPrefix: number;
  private readonly flowPrefix: number;
  private readonly sweepSamples: number;
  private readonly attackSamples: number;
  private readonly noiseSamples: number;
  private readonly ringSamples: number;
  private readonly harmonic2 = dbToGain(HARMONIC_2_DB);
  private readonly harmonic3 = dbToGain(HARMONIC_3_DB);
  /** The noise thump's band-pass: [a1, a2, a3, k]. */
  private readonly band = new Float64Array(4);
  /** Scales hashed white noise so the band-passed thump sits `NOISE_DB` under the sine. */
  private readonly noiseScale: number;
  private readonly mix = new Float64Array(QUANTUM);
  private rate: number;
  private bedTarget = 0;
  private bed = 0;
  private readonly bedGlide: number;
  /**
   * The flow's envelope: 0–1 over its floor, the value it swells from, the
   * last lub's absolute sample, and its ease and fall each low-rate step.
   */
  private swell = 0;
  private swellFrom = 0;
  private lubStart = Number.NEGATIVE_INFINITY;
  private ease = 1;
  private easeFall = 1;
  /** The next lub's absolute sample (NaN when none is due), and its beat's ease. */
  private pendingLub = Number.NaN;
  private pendingFall = 1;
  private readonly swellSamples: number;
  /** The flow's filters and gain. */
  private readonly brownPole: number;
  private readonly flowHigh = new Float64Array(4);
  private readonly flowLow = new Float64Array(4);
  private readonly flowGain: number;
  private brown = 0;
  private high1 = 0;
  private high2 = 0;
  private low1 = 0;
  private low2 = 0;
  /** The flow's last two values at the low rate, joined up between. */
  private flowFrom = 0;
  private flowTo = 0;
  /** The next beat's first sample, once known: no beat starts before it. */
  private nextBeat = Number.NEGATIVE_INFINITY;
  /** The absolute sample the next render should start on, or NaN before the first. */
  private next = Number.NaN;

  constructor(seed: number, sampleRate: number, rate = 64) {
    this.sampleRate = sampleRate;
    this.rate = rate;
    this.beats = new HeartBeats(seed, rate);
    this.voices = [newVoice(), newVoice(), newVoice(), newVoice()];
    const seedHash = hashStep(HASH_START, seed);
    this.strengthPrefix = hashStep(seedHash, STRENGTH_STREAM);
    this.thumpPrefix = hashStep(seedHash, THUMP_STREAM);
    this.flowPrefix = hashStep(seedHash, FLOW_STREAM);
    this.sweepSamples = Math.round(SWEEP * sampleRate);
    this.attackSamples = Math.max(1, Math.round(ATTACK * sampleRate));
    this.noiseSamples = Math.max(2, Math.round(NOISE_LENGTH * sampleRate));
    this.ringSamples = this.noiseSamples + Math.round(NOISE_RING * sampleRate);
    svfCoefficients(this.band, NOISE_CENTRE, NOISE_Q, sampleRate);
    // The Hann window keeps 3/8 of the band-passed noise's power. The sine's RMS is 1/√2.
    this.noiseScale =
      (dbToGain(NOISE_DB) * Math.SQRT1_2) / Math.sqrt(thumpBandPower(sampleRate) * (3 / 8));
    this.bedGlide = Math.exp(-FLOW_DECIMATION / (BED_GLIDE * sampleRate));
    this.swellSamples = Math.round(SWELL * sampleRate);
    const flowRate = sampleRate / FLOW_DECIMATION;
    this.brownPole = Math.exp((-2 * Math.PI * BROWN_CORNER) / flowRate);
    svfCoefficients(this.flowHigh, FLOW_HIGHPASS, FLOW_HIGHPASS_Q, flowRate);
    svfCoefficients(this.flowLow, FLOW_LOWPASS, FLOW_LOWPASS_Q, flowRate);
    this.flowGain = dbToGain(FLOW_DB) / (flowRms(flowRate) * flowMean());
  }

  /** The flow's envelope now: from its floor between beats to 1 just after a lub. */
  get flowEnvelope(): number {
    return FLOW_FLOOR + (1 - FLOW_FLOOR) * this.swell;
  }

  /** Takes the params: the rate (bpm, from the next beat) and Flow (0–100, glided). */
  set(rate: number, bed: number): void {
    this.rate = rate;
    this.bedTarget = flowLevel(bed);
  }

  /** Renders one block of up to 128 samples into `out`, from absolute sample `frame`. */
  render(out: Float32Array, frame: number): void {
    const length = Math.min(out.length, QUANTUM);
    if (frame !== this.next) {
      this.warmUp(frame);
    } else if (beatPeriod(this.rate) !== this.beats.period) {
      // Half a sample early, so a beat rounding onto this block's first sample is the next.
      this.beats.setRate(this.rate, (frame - 0.5) / this.sampleRate);
      this.nextBeat = Number.NEGATIVE_INFINITY;
    }
    this.next = frame + length;
    this.renderBlock(frame, length);
    const mix = this.mix;
    for (let i = 0; i < length; i++) {
      out[i] = mix[i];
    }
  }

  /**
   * A fresh start, or a jump: the beats laid out afresh on absolute time,
   * everything silenced, then run unheard up to `frame`, so a beat struck
   * before it sounds on and the flow is where it would be.
   */
  private warmUp(frame: number): void {
    this.beats.reset(this.rate);
    this.nextBeat = Number.NEGATIVE_INFINITY;
    for (const v of this.voices) {
      v.active = false;
    }
    this.bed = this.bedTarget;
    this.swell = 0;
    this.lubStart = Number.NEGATIVE_INFINITY;
    this.pendingLub = Number.NaN;
    this.ease = 0;
    this.brown = 0;
    this.high1 = 0;
    this.high2 = 0;
    this.low1 = 0;
    this.low2 = 0;
    this.flowFrom = 0;
    this.flowTo = 0;
    const from = frame - Math.ceil(WARM_UP * this.sampleRate);
    for (let f = from; f < frame; f += QUANTUM) {
      this.renderBlock(f, Math.min(QUANTUM, frame - f));
    }
  }

  /** Starts the lubs (and arms their dubs) of the beats starting in [frame, frame + length). */
  private startBeats(frame: number, length: number): void {
    const sr = this.sampleRate;
    const end = frame + length;
    if (end <= this.nextBeat) {
      return;
    }
    for (let n = this.beats.firstFrom((frame - 0.5) / sr); ; n++) {
      const start = Math.round(this.beats.timeOf(n) * sr);
      if (start >= end) {
        this.nextBeat = start;
        break;
      }
      if (start < frame) {
        continue;
      }
      const period = this.beats.period;
      const u = hashStep(this.strengthPrefix, n) * UINT32_SCALE;
      const strength = dbToGain((2 * u - 1) * STRENGTH_SPREAD_DB);
      const pair = 2 * (n & 1);
      const thump = hashStep(this.thumpPrefix, n);
      this.strike(this.voices[pair], LUB, start, strength, hashStep(thump, 0));
      this.strike(
        this.voices[pair + 1],
        DUB,
        start + Math.round(dubDelay(period) * sr),
        strength,
        hashStep(thump, 1),
      );
      // The flow swells from the lub, then eases with this beat's period.
      this.pendingLub = start;
      this.pendingFall = Math.exp(-FLOW_DECIMATION / (EASE * period * sr));
    }
  }

  private strike(v: Voice, spec: ThumpSpec, start: number, strength: number, noise: number): void {
    const sr = this.sampleRate;
    const length = Math.round(thumpLength(spec) * sr);
    v.active = true;
    v.start = start;
    v.length = length;
    v.re = 1;
    v.im = 0;
    v.step = (2 * Math.PI * spec.from) / sr;
    v.sweepFall = (spec.to / spec.from) ** (1 / this.sweepSamples);
    v.cw = Math.cos(v.step);
    v.sw = Math.sin(v.step);
    v.decay = 1;
    v.fall = Math.exp(-1 / (spec.decay * sr));
    v.floor = v.fall ** length;
    v.gain = (strength * dbToGain(LUB_DB + spec.db)) / (1 - v.floor);
    v.noiseGain = strength * dbToGain(LUB_DB + spec.db) * this.noiseScale;
    v.noise = noise;
    v.ic1 = 0;
    v.ic2 = 0;
    v.ic3 = 0;
    v.ic4 = 0;
  }

  /** One block of beats and flow into `mix`. */
  private renderBlock(frame: number, length: number): void {
    const mix = this.mix;
    mix.fill(0, 0, length);
    this.startBeats(frame, length);
    for (const v of this.voices) {
      if (v.active) {
        this.renderVoice(v, frame, length);
      }
    }
    this.renderFlow(frame, length);
  }

  private renderVoice(v: Voice, frame: number, length: number): void {
    const mix = this.mix;
    const first = Math.max(0, v.start - frame);
    const last = Math.min(length, v.start + v.length - frame);
    let age = frame + first - v.start;
    const band = this.band;
    const a1 = band[0];
    const a2 = band[1];
    const a3 = band[2];
    const k = band[3];
    const h2 = 2 * this.harmonic2;
    const h3 = this.harmonic3;
    let { re, im, step, cw, sw, decay, ic1, ic2, ic3, ic4 } = v;
    for (let i = first; i < last; i++, age++) {
      // The fundamental, and its 2nd and 3rd harmonics from the same phase.
      const s = im;
      const tone = s + h2 * s * re + h3 * (3 * s - 4 * s * s * s);
      const attack =
        age < this.attackSamples ? 0.5 - 0.5 * Math.cos((Math.PI * age) / this.attackSamples) : 1;
      let y = v.gain * attack * Math.max(0, decay - v.floor) * tone;
      if (age < this.ringSamples) {
        // A Hann window of hashed white noise, then the band-pass, ringing on briefly.
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * age) / this.noiseSamples);
        const x =
          age < this.noiseSamples
            ? (hashStep(v.noise, age) * WHITE_SCALE - 1) * window * v.noiseGain
            : 0;
        // Twice through it, so its skirts fall steeply and the thump stays low and soft.
        let v3 = x - ic2;
        let v1 = a1 * ic1 + a2 * v3;
        let v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        v3 = k * v1 - ic4;
        v1 = a1 * ic3 + a2 * v3;
        v2 = ic4 + a2 * ic3 + a3 * v3;
        ic3 = 2 * v1 - ic3;
        ic4 = 2 * v2 - ic4;
        y += k * v1;
      }
      mix[i] += y;
      const r = re * cw - im * sw;
      im = re * sw + im * cw;
      re = r;
      if (age < this.sweepSamples) {
        step *= v.sweepFall;
        cw = Math.cos(step);
        sw = Math.sin(step);
      }
      decay *= v.fall;
    }
    v.re = re;
    v.im = im;
    v.step = step;
    v.cw = cw;
    v.sw = sw;
    v.decay = decay;
    v.ic1 = ic1;
    v.ic2 = ic2;
    v.ic3 = ic3;
    v.ic4 = ic4;
    if (frame + length >= v.start + v.length) {
      v.active = false;
    }
  }

  /**
   * The flow, its envelope and Flow's glide, all stepped on every eighth
   * absolute sample and joined up with straight lines between, into `mix`.
   */
  private renderFlow(frame: number, length: number): void {
    const mix = this.mix;
    const high = this.flowHigh;
    const h1 = high[0];
    const h2 = high[1];
    const h3 = high[2];
    const hk = high[3];
    const low = this.flowLow;
    const l1 = low[0];
    const l2 = low[1];
    const l3 = low[2];
    const pole = this.brownPole;
    const glide = this.bedGlide;
    const target = this.bedTarget;
    const gain = this.flowGain;
    const swellSamples = this.swellSamples;
    let { bed, brown, high1, high2, low1, low2, swell, ease, flowFrom, flowTo } = this;
    // Up to the first low-rate step, the line already under way; then a step
    // and its line at a time.
    let i = 0;
    let step = frame & FLOW_MASK;
    while (i < length) {
      if (step === 0) {
        const f = frame + i;
        if (f >= this.pendingLub) {
          // The flow swells from where it is, then eases with this beat's period.
          this.lubStart = this.pendingLub;
          this.swellFrom = swell;
          this.easeFall = this.pendingFall;
          this.pendingLub = Number.NaN;
        }
        const since = f - this.lubStart;
        if (since < swellSamples) {
          const from = this.swellFrom;
          swell = from + (1 - from) * (0.5 - 0.5 * Math.cos((Math.PI * since) / swellSamples));
          ease = 1;
        } else {
          ease *= this.easeFall;
          swell = ease;
        }
        const white = hashStep(this.flowPrefix, f) * WHITE_SCALE - 1;
        brown = white + pole * (brown - white);
        // High-pass, then low-pass: the state-variable filter written out.
        let v3 = brown - high2;
        let v1 = h1 * high1 + h2 * v3;
        let v2 = high2 + h2 * high1 + h3 * v3;
        high1 = 2 * v1 - high1;
        high2 = 2 * v2 - high2;
        const highOut = brown - hk * v1 - v2;
        v3 = highOut - low2;
        v1 = l1 * low1 + l2 * v3;
        v2 = low2 + l2 * low1 + l3 * v3;
        low1 = 2 * v1 - low1;
        low2 = 2 * v2 - low2;
        bed = target + glide * (bed - target);
        flowFrom = flowTo;
        flowTo = v2 * gain * bed * (FLOW_FLOOR + (1 - FLOW_FLOOR) * swell);
      }
      const end = Math.min(length, i + FLOW_DECIMATION - step);
      const slope = (flowTo - flowFrom) / FLOW_DECIMATION;
      let value = flowFrom + slope * step;
      for (; i < end; i++) {
        mix[i] += value;
        value += slope;
      }
      step = 0;
    }
    this.bed = bed;
    this.brown = brown;
    this.high1 = high1;
    this.high2 = high2;
    this.low1 = low1;
    this.low2 = low2;
    this.flowFrom = flowFrom;
    this.flowTo = flowTo;
    this.swell = swell;
    this.ease = ease;
  }
}

/**
 * The flow envelope's mean over a beat at the default rate, against its peak:
 * so `FLOW_DB` sets its long-term level.
 */
function flowMean(): number {
  const period = beatPeriod(64);
  const steps = 1000;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * period;
    const g =
      t < SWELL
        ? 0.5 - 0.5 * Math.cos((Math.PI * t) / SWELL)
        : Math.exp(-(t - SWELL) / (EASE * period));
    const e = FLOW_FLOOR + (1 - FLOW_FLOOR) * g;
    sum += e * e;
  }
  return Math.sqrt(sum / steps);
}

interface HeartbeatOptions {
  seed: number;
  /** The rate to start at, in bpm. */
  rate: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readHeartbeatOptions(raw: unknown): HeartbeatOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    rate: numberOr(get("rate"), 64),
    offset: numberOr(get("offset"), 0),
  };
}
