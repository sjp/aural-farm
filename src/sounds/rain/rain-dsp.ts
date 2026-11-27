/**
 * Rain's drops and plinks, and the param mappings the rest of the sound uses:
 * pure code with no Web Audio globals, run by `rain.worklet.ts` and checked in
 * Node.
 *
 * The worklet also makes the wash's noise and drifts (`RainGenerator`), with
 * the shared noise and drift kernels: every worklet node has a fixed cost, so
 * one node with six channels costs less than three.
 *
 * This is the model for sounds made of random events. The pattern:
 *
 * - **Block hashing.** Absolute time is cut into 1 s blocks, and each block's
 *   drops come from `eventsInBlock(seed, stream, block, rate)`: hashes of the
 *   block's index, never a running RNG. Each drop's own properties (size, pan,
 *   colour, whether it plinks) hash from `eventHash(…, block, drop)` and a key,
 *   so they never depend on any other drop.
 * - **Latched params.** The rate is read once per block, when the kernel enters
 *   it; the plink chance and level once per drop, when it starts. A param
 *   change never alters a drop already sounding.
 * - **Look-back.** At the first render, and whenever the absolute time jumps
 *   (a new render chunk), the kernel first renders the last `WARM_UP` seconds
 *   silently, starting each drop in them from its own start, block `b − 1`
 *   included. Every drop is shorter than that, so the drops still ringing at
 *   the first audible sample are the ones a render from long before would
 *   have, in the same state, and the drops' low-pass has settled: chunked
 *   renders join seamlessly. (Only when every voice is busy, in the heaviest
 *   rain, can a stolen voice differ.)
 * - **Counter-hashed noise.** A tick's noise is a hash of the drop and the
 *   sample since its start, so it too depends on nothing but the drop.
 * - **A fixed voice pool.** Voices are made up front (`VoicePool`); a new drop
 *   takes an idle one or steals the quietest; idle voices cost nothing, and
 *   `render` allocates nothing.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { BubbleVoice, minnaertFrequency } from "../../audio/dsp/bubble";
import { expDecayCoef } from "../../audio/dsp/envelopes";
import { blockOf, createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { Svf } from "../../audio/dsp/svf";
import { VoicePool, type PoolVoice } from "../../audio/dsp/voices";
import { NoiseGenerator } from "../../audio/noise-dsp";
import { hashStep, UINT32_SCALE } from "../../audio/random";
import type { RainSurface } from "./rain.meta";

export const RAIN_PROCESSOR = "aural-rain";

const dbToGain = (db: number) => 10 ** (db / 20);

/** Random streams: the wash's noise, its drifts (one each, from `DRIFT_STREAM`) and the drops. */
const NOISE_STREAM = 1;
const DRIFT_STREAM = 3;
const DROP_STREAM = 10;

/**
 * The worklet's output channels: the wash's stereo noise, the drops' stereo
 * mix, then the drifts.
 */
export const NOISE_CHANNEL = 0;
export const DROPS_CHANNEL = 2;
export const DRIFT_CHANNEL = 4;

/**
 * The wash's drifts, in channel order from `DRIFT_CHANNEL`: a main one (rate in
 * Hz, octaves) that moves its level and cutoff, and a slower one that adds to
 * the level. A surface's `driftScale` speeds them up.
 */
const DRIFTS = [
  { rate: 0.04, octaves: 2 },
  { rate: 0.011, octaves: 1 },
] as const;

export const RAIN_CHANNELS = DRIFT_CHANNEL + DRIFTS.length;

/** Keys for each drop's own random properties: `hashStep(eventHash(…), key)`. */
const AMPLITUDE = 1;
const PAN = 2;
const CENTRE = 3;
const DECAY = 4;
const NOISE = 5;
const PLINK = 6;
const RADIUS = 7;
const RISE = 8;

/** What a surface does to the drops and the wash. */
interface SurfaceProfile {
  /** The tick's band-pass: its centre (Hz) and Q. */
  tickCentre: number;
  tickQ: number;
  /** The tick's decay time constant, from–to, in seconds. */
  tickDecay: readonly [number, number];
  /**
   * The tick's level, in dB: brings a full-size drop to `DROP_PEAK_DB` whatever
   * the band's width and the decay's length, then lowers soft surfaces.
   */
  tickDb: number;
  /** The chance a drop plinks at `bubbles` 100. */
  plinkFactor: number;
  /** Drops per second, relative to open ground. */
  rateScale: number;
  /** The wash's level, in dB relative to open ground's. */
  washDb: number;
  /** The highest the wash's low-pass may go, in Hz. */
  washMaxCutoff: number;
  /** Heavy rain's low weight, in dB relative to open ground's. */
  weightDb: number;
  /** A high shelf at `SHELF_FREQUENCY` over everything, in dB (0: none). */
  shelfDb: number;
  /** How fast the wash's drifts move, relative to open ground's. */
  driftScale: number;
}

const OPEN_GROUND: SurfaceProfile = {
  tickCentre: 2500,
  tickQ: 0.8,
  tickDecay: [0.002, 0.004],
  tickDb: 7,
  plinkFactor: 1,
  rateScale: 1,
  washDb: 0,
  washMaxCutoff: Number.POSITIVE_INFINITY,
  weightDb: 0,
  shelfDb: 0,
  driftScale: 1,
};

export const SURFACES: Readonly<Record<RainSurface, SurfaceProfile>> = {
  // Puddles: the reference, with the most plinks.
  ground: OPEN_GROUND,
  // Small, soft ticks, more of them, and a wash that moves more.
  leaves: {
    ...OPEN_GROUND,
    tickCentre: 3200,
    tickQ: 1.2,
    tickDecay: [0.0015, 0.003],
    tickDb: 5,
    plinkFactor: 0.15,
    rateScale: 1.5,
    driftScale: 2,
  },
  // A low, warm tick body and more weight below.
  roof: {
    ...OPEN_GROUND,
    tickCentre: 900,
    tickQ: 2.5,
    tickDecay: [0.004, 0.006],
    tickDb: 14,
    plinkFactor: 0.3,
    weightDb: 4,
  },
  // Glassy taps over a quieter, duller wash.
  window: {
    ...OPEN_GROUND,
    tickCentre: 4000,
    tickQ: 3,
    tickDecay: [0.0015, 0.0025],
    tickDb: 8,
    plinkFactor: 0.05,
    washDb: -6,
    washMaxCutoff: 3000,
  },
  // A muffled drum: low ticks, no plinks, everything high turned down.
  tent: {
    ...OPEN_GROUND,
    tickCentre: 450,
    tickQ: 1.5,
    tickDecay: [0.005, 0.008],
    tickDb: 13,
    plinkFactor: 0,
    shelfDb: -9,
  },
};

/** The tent's high shelf's corner, in Hz. */
export const SHELF_FREQUENCY = 2500;

/** A full-size drop (the loudest in about 10 000) peaks here before the low-pass, in dBFS. */
export const DROP_PEAK_DB = -9;
/** A plink's peak, relative to its drop's tick, in dB. */
const PLINK_DB = -5;
/** How far a tick's centre strays from its surface's: ±25 %. */
const CENTRE_SPREAD = 0.25;
/** Drops pan within ±0.7; the loudest 5 % within ±0.4, so the nearest stay near the middle. */
const PAN_WIDTH = 0.7;
const LOUD_PAN_WIDTH = 0.4;
const LOUD_SHARE = 0.05;
/**
 * Drops smaller than this (−36 dB against a full-size one, peaking under
 * −45 dBFS) are skipped: lost under the wash, and a quarter of all drops.
 */
const SILENT_AMPLITUDE = dbToGain(-36);
/**
 * Only drops at least this size (−20 dB against a full-size one, about the
 * larger half) can trap a bubble: the smaller ones' plinks would be lost too.
 */
const PLINK_AMPLITUDE = dbToGain(-20);
/**
 * A tick ends once it has fallen 40 dB from its peak, or to 57 dB below a
 * full-size drop's peak (about −66 dBFS), whichever comes first: far under the
 * wash, and it keeps quiet ticks short.
 */
const TICK_END = dbToGain(-40);
const TICK_FLOOR = dbToGain(-57);

/** Bubble radii, from–to, in metres: 0.8–3 mm, about 4.1–1.1 kHz. */
const MIN_RADIUS = 0.0008;
const MAX_RADIUS = 0.003;
/** A plink never goes above this, in Hz, however it glides. */
export const MAX_PLINK_FREQUENCY = 4500;
/** How much a plink rises over its audible decay (three time constants): 15–40 %. */
const MIN_RISE = 0.15;
const MAX_RISE = 0.4;
const RISE_TIME_CONSTANTS = 3;

/** Voices: ticks and plinks. */
const TICK_VOICES = 32;
const PLINK_VOICES = 12;
/** Seconds rendered silently before a render that starts afresh: longer than any drop. */
export const WARM_UP = 0.1;
/** The most drops a block can hold: far above the busiest surface's rate. */
const EVENT_CAPACITY = 4096;
/** The scratch buffer the warm-up renders into, in samples. */
const SCRATCH = 128;
/** Ticks' noise has the same spectral density at any sample rate: its RMS is set at this one. */
const REFERENCE_RATE = 48000;

/** A drop's own random property `key`, in [0, 1). */
const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Drops per second on open ground at `intensity` and `distance` (0–100). */
export function dropRate(intensity: number, distance: number): number {
  // 15 at intensity 0, 120 at 50, 900 at 100, evenly in log between; halved at full distance.
  const i = clamp01(intensity / 100);
  const rate = i < 0.5 ? 15 * 8 ** (i / 0.5) : 120 * 7.5 ** ((i - 0.5) / 0.5);
  return rate * 0.5 ** clamp01(distance / 100);
}

/**
 * The wash's level at `intensity` (0–100), in dB before the output trim: −28
 * to −20. Heavy rain is louder mostly through its drops, so a downpour stays
 * within 8 dB of the default level.
 */
export function washDb(intensity: number): number {
  return -28 + 8 * clamp01(intensity / 100);
}

/** Above this many drops per second, drops start to merge into the wash. */
const DENSE_RATE = 120;

/**
 * Each drop's gain at `rate` drops per second: 1 up to `DENSE_RATE`, then
 * falling with the fourth root of the rate, so the drops' power grows with its
 * square root. In a downpour single drops blend into the hiss rather than
 * piling up into a roar.
 */
export function densityGain(rate: number): number {
  return rate > DENSE_RATE ? (DENSE_RATE / rate) ** 0.25 : 1;
}

/** Heavy rain's low weight's gain, relative to the wash: none up to 50, −14 dB at 100. */
export function weightLevel(intensity: number): number {
  return clamp01((intensity - 50) / 50) * dbToGain(-14);
}

/**
 * The wash's low-pass cutoff, in Hz: close, 4 kHz at light rain to 7 kHz at
 * heavy; far, 1.4–2.2 kHz; evenly in octaves between; capped by the surface.
 */
export function washCutoff(intensity: number, distance: number, surface: SurfaceProfile): number {
  const i = clamp01(intensity / 100);
  const d = clamp01(distance / 100);
  const close = 4000 * (7000 / 4000) ** i;
  const far = 1400 * (2200 / 1400) ** i;
  return Math.min(close ** (1 - d) * far ** d, surface.washMaxCutoff);
}

/** The low-pass over the drops at `distance` (0–100), in Hz: 18 kHz close, 2 kHz far. */
export function outputCutoff(distance: number): number {
  return 2000 * 9 ** (1 - clamp01(distance / 100));
}

/** The drops' level relative to the wash at `distance` (0–100), in dB: 0 close, −12 far. */
export function dropsDb(distance: number): number {
  return -12 * clamp01(distance / 100);
}

/** The outdoor reverb send at `distance` (0–100), in dB: −30 close, −16 far. */
export function sendDb(distance: number): number {
  return -30 + 14 * clamp01(distance / 100);
}

/**
 * A plink's decay time constant at `frequency`: 8 ms at 1.1 kHz to 2 ms at
 * 4 kHz, evenly in log between, as smaller bubbles die faster.
 */
export function plinkDecay(frequency: number): number {
  const x = clamp01(Math.log(frequency / 1100) / Math.log(4000 / 1100));
  return 0.008 * 0.25 ** x;
}

interface RainOptions {
  seed: number;
  surface: RainSurface;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const isSurface = (value: unknown): value is RainSurface =>
  typeof value === "string" && Object.hasOwn(SURFACES, value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readRainOptions(raw: unknown): RainOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const surface = get("surface");
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    surface: isSurface(surface) ? surface : "ground",
    offset: numberOr(get("offset"), 0),
  };
}

/** A drop's tick: counter-hashed white noise, decaying exponentially, through a band-pass. */
class TickVoice implements PoolVoice {
  level = 0;
  private readonly svf: Svf;
  private noise = 0;
  private position = 0;
  private envelope = 0;
  private coef = 0;
  private end = 0;
  private left = 0;
  private right = 0;
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.svf = new Svf(sampleRate);
  }

  /** Starts a tick peaking at `peak`; it ends below `floor` or 40 dB under its peak. */
  start(
    noise: number,
    peak: number,
    floor: number,
    pan: number,
    centre: number,
    q: number,
    decay: number,
  ): void {
    this.svf.reset();
    this.svf.set(centre, q);
    this.noise = noise;
    this.position = 0;
    this.envelope = peak;
    this.coef = expDecayCoef(decay, this.sampleRate);
    this.end = Math.max(peak * TICK_END, floor);
    this.left = panLeft(pan);
    this.right = panRight(pan);
    this.level = peak;
  }

  /** Adds samples `from` to `to` into the outputs. Returns false once the tick has ended. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const svf = this.svf;
    const noise = this.noise;
    const coef = this.coef;
    const gainLeft = this.left;
    const gainRight = this.right;
    const end = this.end;
    let envelope = this.envelope;
    let n = this.position;
    for (let i = from; i < to && envelope > end; i++) {
      svf.tick((hashStep(noise, n) * UINT32_SCALE * 2 - 1) * envelope);
      n++;
      envelope *= coef;
      const y = svf.band;
      left[i] += y * gainLeft;
      right[i] += y * gainRight;
    }
    this.envelope = envelope;
    this.position = n;
    this.level = envelope;
    return envelope > end;
  }
}

/** Low-passes the first `length` samples of `buffer` in place through `svf`. */
function filter(svf: Svf, buffer: Float32Array, length: number): void {
  for (let i = 0; i < length; i++) {
    svf.tick(buffer[i]);
    buffer[i] = svf.low;
  }
}

/** A drop's plink: the shared bubble voice, panned with its drop. */
class PlinkVoice implements PoolVoice {
  readonly bubble: BubbleVoice;
  private left = 0;
  private right = 0;

  constructor(sampleRate: number) {
    this.bubble = new BubbleVoice(sampleRate);
  }

  get level(): number {
    return this.bubble.level;
  }

  start(peak: number, frequency: number, rise: number, decay: number, pan: number): void {
    const sweep = rise / (RISE_TIME_CONSTANTS * decay);
    this.bubble.start(peak, frequency, sweep, decay, MAX_PLINK_FREQUENCY);
    this.left = panLeft(pan);
    this.right = panRight(pan);
  }

  /** Adds samples `from` to `to` into the outputs. Returns false once the plink has ended. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const bubble = this.bubble;
    for (let i = from; i < to && bubble.active; i++) {
      const y = bubble.next();
      left[i] += y * this.left;
      right[i] += y * this.right;
    }
    return bubble.active;
  }
}

/**
 * The drops and plinks for one surface: stereo, rendered from any absolute
 * sample, the same whether rendered in one go or in chunks.
 */
export class RainKernel {
  private readonly seed: number;
  private readonly sampleRate: number;
  private readonly profile: SurfaceProfile;
  private readonly ticks: VoicePool<TickVoice>;
  private readonly plinks: VoicePool<PlinkVoice>;
  private readonly events = createEventBlock(EVENT_CAPACITY);
  /** The tick's peak for a full-size drop, with the noise's sample-rate scaling. */
  private readonly tickPeak: number;
  private readonly plinkPeak: number;
  /** The loaded block's `densityGain`. */
  private density = 1;
  /** The params `set` gave: see there. */
  private rate = 0;
  private bubbles = 0;
  private level = 1;
  private cutoff = Number.NaN;
  private readonly lowpassLeft: Svf;
  private readonly lowpassRight: Svf;
  private readonly warmUpSamples: number;
  private readonly scratchLeft = new Float32Array(SCRATCH);
  private readonly scratchRight = new Float32Array(SCRATCH);
  /** The block whose drops are in `events`, and the next of them to start. */
  private block = Number.NaN;
  private next = 0;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, surface: RainSurface, sampleRate: number) {
    this.seed = seed;
    this.sampleRate = sampleRate;
    this.profile = SURFACES[surface];
    this.ticks = new VoicePool(TICK_VOICES, () => new TickVoice(sampleRate));
    this.plinks = new VoicePool(PLINK_VOICES, () => new PlinkVoice(sampleRate));
    // Uniform noise in [−1, 1); scaled with the rate so its density per Hz stays put.
    const tickPeak = dbToGain(DROP_PEAK_DB + this.profile.tickDb);
    this.tickPeak = tickPeak * Math.sqrt(sampleRate / REFERENCE_RATE);
    this.plinkPeak = dbToGain(DROP_PEAK_DB + PLINK_DB);
    this.warmUpSamples = Math.ceil(WARM_UP * sampleRate);
    this.lowpassLeft = new Svf(sampleRate);
    this.lowpassRight = new Svf(sampleRate);
    this.set(0, 0, 1, outputCutoff(0));
  }

  /**
   * Sets the params for the next render: `rate`, drops per second on open
   * ground (latched per block); `bubbles`, the plink chance at full plink factor
   * (0–1), and `level`, the drops' gain, both latched per drop; and `cutoff`, the
   * low-pass over all the drops, in Hz.
   */
  set(rate: number, bubbles: number, level: number, cutoff: number): void {
    this.rate = rate;
    this.bubbles = bubbles;
    this.level = level;
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      this.lowpassLeft.set(cutoff, Math.SQRT1_2);
      this.lowpassRight.set(cutoff, Math.SQRT1_2);
    }
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    if (start !== this.expected) {
      this.warmUp(start);
    }
    this.process(left, right, left.length, start);
    this.expected = start + left.length;
  }

  /** Clears every voice, then renders the `WARM_UP` before `start` silently. */
  private warmUp(start: number): void {
    while (this.ticks.active > 0) {
      this.ticks.release(0);
    }
    while (this.plinks.active > 0) {
      this.plinks.live[0]?.bubble.stop();
      this.plinks.release(0);
    }
    let from = start - this.warmUpSamples;
    this.load(blockOf(from, this.sampleRate));
    while (this.next < this.events.count && this.eventSample(this.next) < from) {
      this.next++;
    }
    while (from < start) {
      const length = Math.min(SCRATCH, start - from);
      this.process(this.scratchLeft, this.scratchRight, length, from);
      from += length;
    }
  }

  /** Loads block `block`'s drops at the current rate, which the block keeps. */
  private load(block: number): void {
    const surfaceRate = this.rate * this.profile.rateScale;
    eventsInBlock(this.seed, DROP_STREAM, block, surfaceRate, this.events);
    this.density = densityGain(surfaceRate);
    this.block = block;
    this.next = 0;
  }

  /** The absolute sample drop `i` of the loaded block starts at. */
  private eventSample(i: number): number {
    return (
      this.block * this.sampleRate + Math.floor((this.events.offsets[i] ?? 0) * this.sampleRate)
    );
  }

  /** Renders `length` samples from absolute sample `start`, overwriting the outputs. */
  private process(left: Float32Array, right: Float32Array, length: number, start: number): void {
    left.fill(0, 0, length);
    right.fill(0, 0, length);
    const sr = this.sampleRate;
    let pos = 0;
    while (pos < length) {
      const now = start + pos;
      const block = blockOf(now, sr);
      if (block !== this.block) {
        this.load(block);
      }
      while (this.next < this.events.count && this.eventSample(this.next) <= now) {
        this.startDrop(this.next);
        this.next++;
      }
      // Render up to the next drop, the block's end or the buffer's end.
      let end = Math.min(length, (block + 1) * sr - start);
      if (this.next < this.events.count) {
        end = Math.min(end, this.eventSample(this.next) - start);
      }
      this.renderVoices(left, right, pos, end);
      pos = end;
    }
    filter(this.lowpassLeft, left, length);
    filter(this.lowpassRight, right, length);
  }

  private renderVoices(left: Float32Array, right: Float32Array, from: number, to: number): void {
    // Backwards, so releasing a voice (which swaps in the last) is safe.
    const ticks = this.ticks;
    for (let i = ticks.active - 1; i >= 0; i--) {
      if (!ticks.live[i]?.render(left, right, from, to)) {
        ticks.release(i);
      }
    }
    const plinks = this.plinks;
    for (let i = plinks.active - 1; i >= 0; i--) {
      if (!plinks.live[i]?.render(left, right, from, to)) {
        plinks.release(i);
      }
    }
  }

  /** Starts drop `i` of the loaded block: its tick, and maybe a plink. */
  private startDrop(i: number): void {
    const hash = eventHash(this.seed, DROP_STREAM, this.block, i);
    const size = unit(hash, AMPLITUDE);
    // A power law: most drops are faint, a few are close.
    const amplitude = size * size * size;
    if (amplitude < SILENT_AMPLITUDE) {
      return;
    }
    const gain = amplitude * this.density * this.level;
    const width = size > 1 - LOUD_SHARE ? LOUD_PAN_WIDTH : PAN_WIDTH;
    const pan = (unit(hash, PAN) * 2 - 1) * width;
    const p = this.profile;
    const centre = p.tickCentre * (1 + CENTRE_SPREAD * (unit(hash, CENTRE) * 2 - 1));
    const decay = p.tickDecay[0] + (p.tickDecay[1] - p.tickDecay[0]) * unit(hash, DECAY);
    this.ticks
      .allocate()
      .start(
        hashStep(hash, NOISE),
        gain * this.tickPeak,
        this.tickPeak * TICK_FLOOR,
        pan,
        centre,
        p.tickQ,
        decay,
      );
    if (amplitude >= PLINK_AMPLITUDE && unit(hash, PLINK) < this.bubbles * p.plinkFactor) {
      const radius = MIN_RADIUS * (MAX_RADIUS / MIN_RADIUS) ** unit(hash, RADIUS);
      const frequency = Math.min(minnaertFrequency(radius), MAX_PLINK_FREQUENCY);
      const rise = MIN_RISE + (MAX_RISE - MIN_RISE) * unit(hash, RISE);
      this.plinks
        .allocate()
        .start(gain * this.plinkPeak, frequency, rise, plinkDecay(frequency), pan);
    }
  }
}

/**
 * Everything the rain worklet makes, into `RAIN_CHANNELS` channels: the wash's
 * stereo pink noise, the drops (`RainKernel`) and the wash's drifts, all from
 * absolute samples, so time-addressable.
 */
export class RainGenerator {
  private readonly noise: NoiseGenerator;
  private readonly drifts: DriftGenerator[];
  private readonly drops: RainKernel;

  constructor(seed: number, surface: RainSurface, sampleRate: number) {
    this.noise = new NoiseGenerator("pink", seed, NOISE_STREAM, 2, sampleRate);
    const speed = SURFACES[surface].driftScale;
    this.drifts = DRIFTS.map(
      (d, i) => new DriftGenerator(seed, DRIFT_STREAM + i, d.rate * speed, d.octaves, sampleRate),
    );
    this.drops = new RainKernel(seed, surface, sampleRate);
  }

  /** Sets the drops' params: see `RainKernel.set`. */
  set(rate: number, bubbles: number, level: number, cutoff: number): void {
    this.drops.set(rate, bubbles, level, cutoff);
  }

  /** Fills `channels` (`RAIN_CHANNELS` of one length) from absolute sample `start`. */
  render(channels: readonly Float32Array[], start: number): void {
    if (channels.length < RAIN_CHANNELS) {
      return;
    }
    this.noise.render(0, channels[NOISE_CHANNEL], start);
    this.noise.render(1, channels[NOISE_CHANNEL + 1], start);
    this.drops.render(channels[DROPS_CHANNEL], channels[DROPS_CHANNEL + 1], start);
    for (let i = 0; i < this.drifts.length; i++) {
      this.drifts[i].render(channels[DRIFT_CHANNEL + i], start);
    }
  }
}
