/**
 * Stream's bubbles and the rush's noise, and the param mappings the rest of
 * the sound uses: pure code with no Web Audio globals, run by
 * `stream.worklet.ts` and checked in Node.
 *
 * Running water's chatter is countless small air bubbles, each ringing briefly
 * at a pitch set by its size and rising as it floats up (the shared
 * `BubbleVoice`). They come in clusters where the water tumbles over a stone.
 *
 * The worklet makes the rush's noise too, already swelling and easing with a
 * slow drift (`StreamGenerator`): every worklet node has a fixed cost, so one
 * node does it all, and the native graph does the filtering.
 *
 * **Bubbles** follow Rain's pattern for random events (block hashing, latched
 * params, look-back, a fixed voice pool), with Fireplace's clusters:
 *
 * - **Clusters.** Parents come from `eventsInBlock` at 8–80 a second by flow,
 *   pushed ±20 % by a slow surge drift read once per block. Each parent has
 *   1–12 children (more at high flow) within 5–60 ms of it (tighter at high
 *   flow), each a bubble: about 40 bubbles a second at flow 0, 600 at 100.
 * - **Places.** Each cluster has a place in the stereo field, ±0.8, and its
 *   bubbles scatter ±0.1 around it, so the chatter comes from spots along the
 *   stream rather than from everywhere at once.
 * - **Block starts.** When the kernel enters block `b` it lists the bubbles
 *   that start in it, sorted: the children that land in `b` of the clusters of
 *   blocks `b − 1` and `b` (a cluster lasts far less than a block). Each
 *   block's rate and flow are latched when the kernel enters it and kept for
 *   the next, so a cluster that crosses into the next block keeps the flow it
 *   started with. Size and level latch per bubble.
 * - **Look-back.** At the first render, and whenever the absolute time jumps,
 *   the kernel renders the last `WARM_UP` seconds silently (longer than any
 *   bubble), so chunked renders join seamlessly.
 */
import { DriftGenerator } from "../../audio/drift-dsp";
import { BUBBLE_LIFE, BubbleVoice, minnaertFrequency } from "../../audio/dsp/bubble";
import { blockOf, createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import { panLeft, panRight } from "../../audio/dsp/pan";
import { VoicePool, type PoolVoice } from "../../audio/dsp/voices";
import { NoiseGenerator } from "../../audio/noise-dsp";
import { hashStep, UINT32_SCALE } from "../../audio/random";

export const STREAM_PROCESSOR = "aural-stream";

const dbToGain = (db: number) => 10 ** (db / 20);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Evenly in log from `a` to `b`. */
const logLerp = (a: number, b: number, t: number) => a * (b / a) ** t;

/** Random streams: the bubbles, the rush's two noises, and the two drifts. */
export const BUBBLE_STREAM = 1;
const PINK_STREAM = 2;
const BROWN_STREAM = 3;
const SWELL_STREAM = 4;
const SURGE_STREAM = 5;

/**
 * The worklet's output channels: the rush's stereo pink and brown noise (both
 * under the swell), then the bubbles' stereo mix.
 */
export const PINK_CHANNEL = 0;
export const BROWN_CHANNEL = 2;
export const BUBBLES_CHANNEL = 4;
export const STREAM_CHANNELS = 6;

/** The rush's swell: a slow drift (rate in Hz, octaves) moving its level by ±2 dB. */
const SWELL = { rate: 0.06, octaves: 2, db: 2 } as const;
/** The surge: a drift moving the cluster rate by ±20 %, read once per block. */
const SURGE = { rate: 0.2, octaves: 1, depth: 0.2 } as const;

/** Keys for each cluster's and bubble's own random properties: `hashStep(hash, key)`. */
const AMPLITUDE = 1;
const PAN = 2;
const RADIUS = 3;
const DECAY = 4;
const RISE = 5;
const COUNT = 6;
const SPAN = 7;
const TIME = 8;
/** A cluster's children hash from these keys on. */
const CHILD_KEY = 100;

/** Clusters pan within ±0.8, and their bubbles within ±0.1 of the cluster. */
const CLUSTER_PAN = 0.8;
const BUBBLE_PAN = 0.1;

/** The default flow (0–1): the density gain and the rush's level are referred to it. */
const DEFAULT_FLOW = 0.45;
/** Cluster parents per second, at flow 0 and 100. */
const PARENT_RATE = [8, 80] as const;
/** A cluster's children: the fewest and most, at flow 0 and 100 (means 5 and 7.5). */
const FEWEST_CHILDREN = [1, 3] as const;
const MOST_CHILDREN = [9, 12] as const;
/** The most children a cluster can have. */
export const MAX_CLUSTER = MOST_CHILDREN[1];
/** A cluster's span, in seconds: its shortest and longest, at flow 0 and 100. */
const SHORTEST_SPAN = [0.02, 0.005] as const;
const LONGEST_SPAN = [0.06, 0.025] as const;

/** Bubble radii, in metres: the smallest and largest, from a brook (size 0) to a river (100). */
const SMALLEST_RADIUS = [0.0007, 0.002] as const;
const LARGEST_RADIUS = [0.003, 0.01] as const;
/** Bubbles ring between these, in Hz, however large or small and however they glide. */
export const MIN_BUBBLE_FREQUENCY = 250;
export const MAX_BUBBLE_FREQUENCY = 4500;
/**
 * A bubble's decay time constant: 2 ms at 4.5 kHz to 18 ms at 330 Hz, evenly
 * in log between, ±20 %.
 */
const DECAY_HIGH = { frequency: 4500, decay: 0.002 } as const;
const DECAY_LOW = { frequency: 330, decay: 0.018 } as const;
const DECAY_JITTER = 0.2;
/** How much a bubble rises over its audible decay (three time constants): 10–60 %. */
const RISE_RANGE = [0.1, 0.6] as const;
const RISE_TIME_CONSTANTS = 3;
/** The smallest bubbles are lowered by this, in dB: they are many, and would sound fizzy. */
const SMALL_BUBBLE_DB = -6;

/**
 * The loudest bubble's peak, in dBFS, before the level the sound gives the
 * bubbles. The chatter is sparse and peaky, so this is set by its peaks: two
 * loud bubbles meeting in a cluster stay under −3 dBFS over minutes, and the
 * defaults sit about 1.5 dB under −23 LUFS.
 */
export const BUBBLE_PEAK_DB = -7;
/** Bubbles under this amplitude (−40 dB against the loudest at full level) are skipped: lost in the chatter. */
const SILENT_AMPLITUDE = dbToGain(-40);
/**
 * A bubble ends at −60 dB against its own peak, or once it has fallen to 60 dB
 * under the loudest bubble's peak (about −74 dBFS), whichever comes first.
 */
const BUBBLE_FLOOR = dbToGain(-60);

/** Voices. */
const BUBBLE_VOICES = 64;
/** Seconds rendered silently before a render that starts afresh: longer than any bubble. */
export const WARM_UP = 0.2;
/** The most bubble starts a block can hold, and parents a block can have: far above flow 100's. */
const START_CAPACITY = 4096;
const PARENT_CAPACITY = 512;
/** The blocks whose rate and flow the kernel remembers (a power of two). */
const HISTORY = 4;
/** The scratch buffer the warm-up renders into, in samples. */
const SCRATCH = 128;

/** A cluster's or bubble's own random property `key`, in [0, 1). */
const unit = (hash: number, key: number) => hashStep(hash, key) * UINT32_SCALE;

/** Cluster parents per second at `flow` (0–100): 8 to 80, evenly in log. */
export function parentRate(flow: number): number {
  return logLerp(PARENT_RATE[0], PARENT_RATE[1], clamp01(flow / 100));
}

/** The fewest and most bubbles a cluster has at `flow` (0–100). */
function clusterSize(flow: number): readonly [number, number] {
  const f = clamp01(flow / 100);
  return [
    Math.round(lerp(FEWEST_CHILDREN[0], FEWEST_CHILDREN[1], f)),
    Math.round(lerp(MOST_CHILDREN[0], MOST_CHILDREN[1], f)),
  ];
}

/** Bubbles per second at `flow` (0–100), on average: about 40 to 600. */
export function bubbleRate(flow: number): number {
  const [fewest, most] = clusterSize(flow);
  return (parentRate(flow) * (fewest + most)) / 2;
}

/** The bubble rate at the default flow, where `densityGain` is 1. */
const DEFAULT_RATE = bubbleRate(DEFAULT_FLOW * 100);

/**
 * Each bubble's gain at `flow` (0–100): 1 up to the default flow, then the
 * cube root of the default rate over the rate, so the bubbles' power grows
 * with the cube root of their number. Fast water chatters more densely
 * rather than piling up loud peaks.
 */
export function densityGain(flow: number): number {
  return Math.min(1, (DEFAULT_RATE / bubbleRate(flow)) ** (1 / 3));
}

/** The hash cluster child `child` of the cluster `hash` derives from. */
export const childHash = (hash: number, child: number) => hashStep(hash, CHILD_KEY + child);

/**
 * Fills `out` with the children of the cluster whose hash is `hash` at `flow`
 * (0–100), in seconds after its parent (unsorted), and returns how many: 1–9
 * at flow 0 to 3–12 at 100, within 20–60 ms of the parent at flow 0 to 5–25 ms
 * at 100.
 */
export function clusterChildren(hash: number, flow: number, out: Float64Array): number {
  const f = clamp01(flow / 100);
  const [fewest, most] = clusterSize(flow);
  const count = Math.min(fewest + Math.floor(unit(hash, COUNT) * (most - fewest + 1)), out.length);
  const span = lerp(
    lerp(SHORTEST_SPAN[0], SHORTEST_SPAN[1], f),
    lerp(LONGEST_SPAN[0], LONGEST_SPAN[1], f),
    unit(hash, SPAN),
  );
  for (let c = 0; c < count; c++) {
    out[c] = span * unit(childHash(hash, c), TIME);
  }
  return count;
}

/** The smallest and largest bubble radius at `size` (0–100), in metres, evenly in log between. */
export function radiusRange(size: number): readonly [number, number] {
  const s = clamp01(size / 100);
  return [
    logLerp(SMALLEST_RADIUS[0], SMALLEST_RADIUS[1], s),
    logLerp(LARGEST_RADIUS[0], LARGEST_RADIUS[1], s),
  ];
}

/** A bubble's resonance for radius `radius` (m), within the bubbles' range. */
function bubbleFrequency(radius: number): number {
  return Math.min(MAX_BUBBLE_FREQUENCY, Math.max(MIN_BUBBLE_FREQUENCY, minnaertFrequency(radius)));
}

/** How small a bubble ringing at `frequency` is: 0 at 330 Hz, 1 at 4.5 kHz, evenly in log. */
function smallness(frequency: number): number {
  return clamp01(
    Math.log(frequency / DECAY_LOW.frequency) /
      Math.log(DECAY_HIGH.frequency / DECAY_LOW.frequency),
  );
}

/** A bubble's decay time constant at `frequency`, before its jitter, in seconds. */
export function bubbleDecay(frequency: number): number {
  return logLerp(DECAY_LOW.decay, DECAY_HIGH.decay, smallness(frequency));
}

/** The rush's pink band's centre at `size` (0–100), in Hz: 1.2 kHz for a brook to 500 Hz. */
export function rushCentre(size: number): number {
  return logLerp(1200, 500, clamp01(size / 100));
}

/** The low-pass over everything at `distance` (0–100), in Hz: 18 kHz close, 2.5 kHz far. */
export function outputCutoff(distance: number): number {
  return logLerp(18000, 2500, clamp01(distance / 100));
}

/** The outdoor reverb send at `distance` (0–100), in dB: −34 close, −20 far. */
export function sendDb(distance: number): number {
  return -34 + 14 * clamp01(distance / 100);
}

/**
 * The rush's level against the bubbles', in dB, at `size` and `distance`
 * (0–100): −24 for a brook to +2 for a river on the bank, rising to +10 far
 * away, where the babble fades into the rush. It moves with the square of
 * the distance, so the babble stays close a little way up the bank.
 */
export function rushBalanceDb(size: number, distance: number): number {
  const close = lerp(-24, 2, clamp01(size / 100));
  return lerp(close, 10, clamp01(distance / 100) ** 2);
}

/** The rush's brown noise against its pink, in dB: 0 for a brook to +8 for a river. */
function brownDb(size: number): number {
  return 8 * clamp01(size / 100);
}

/**
 * How much louder a river's bubbles are than those at the default size, at
 * the same flow, in dB: larger bubbles ring longer. The bubbles' level takes
 * it off above the default size, so a larger stream moves the balance and
 * character rather than the loudness; a brook's smaller bubbles are a little
 * quieter.
 */
const RIVER_BUBBLES_DB = 5.6;
/** The default size (0–1), where the references below hold. */
const DEFAULT_SIZE = 0.3;
/** The rush at gain 1 against the bubbles at gain 1, at the default flow and size, in dB. */
const RUSH_REFERENCE_DB = -4;
/** The brown noise's low end at gain 1 against the pink noise's band at gain 1, in dB. */
const BROWN_REFERENCE_DB = -6;
/** How much the rush rises across flow, in dB. */
const RUSH_FLOW_DB = 6;
/** How much quieter everything is far away, in dB, with the square of the distance. */
const DISTANCE_DB = -4;

/** The bubbles' gain and the rush's pink and brown gains at some params. */
interface StreamLevels {
  bubbles: number;
  pink: number;
  brown: number;
}

/**
 * The bubbles' and the rush's gains at `flow`, `size` and `distance` (0–100).
 * The balance between them follows `rushBalanceDb`, and both are lowered
 * together so the two at their reference levels sum to the same power at any
 * size and distance, then `DISTANCE_DB` further away. Flow raises the bubbles
 * through their number and the rush by `RUSH_FLOW_DB`.
 */
export function streamLevels(flow: number, size: number, distance: number): StreamLevels {
  const balance = rushBalanceDb(size, distance);
  const sum =
    -10 * Math.log10(1 + 10 ** (balance / 10)) + DISTANCE_DB * clamp01(distance / 100) ** 2;
  const larger = Math.max(0, clamp01(size / 100) - DEFAULT_SIZE) / (1 - DEFAULT_SIZE);
  const bubblesDb = sum - RIVER_BUBBLES_DB * larger;
  const rushDb =
    sum + balance + RUSH_REFERENCE_DB + RUSH_FLOW_DB * (clamp01(flow / 100) - DEFAULT_FLOW);
  // The pink and brown share the rush's level: the brown lies `brownDb` above the pink.
  const brown = brownDb(size);
  const pinkDb = rushDb - 10 * Math.log10(1 + 10 ** (brown / 10));
  return {
    bubbles: dbToGain(bubblesDb),
    pink: dbToGain(pinkDb),
    brown: dbToGain(pinkDb + brown + BROWN_REFERENCE_DB),
  };
}

interface StreamOptions {
  seed: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readStreamOptions(raw: unknown): StreamOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    seed: Math.trunc(numberOr(get("seed"), 0)),
    offset: numberOr(get("offset"), 0),
  };
}

/**
 * A bubble: the shared bubble voice, panned, ending once it falls to an
 * absolute floor if that comes before its own end. The floor's sample is
 * worked out as it starts, so it ends on the same sample however it is
 * rendered.
 */
class StreamVoice implements PoolVoice {
  readonly bubble: BubbleVoice;
  private readonly sampleRate: number;
  private left = 0;
  private right = 0;
  /** Samples left until it reaches the floor. */
  private remaining = 0;

  constructor(sampleRate: number) {
    this.bubble = new BubbleVoice(sampleRate);
    this.sampleRate = sampleRate;
  }

  get level(): number {
    return this.bubble.level;
  }

  /** Starts a bubble peaking at `peak`; it ends by −60 dB, or at `floor` if that is sooner. */
  start(
    peak: number,
    frequency: number,
    rise: number,
    decay: number,
    pan: number,
    floor: number,
  ): void {
    const sweep = rise / (RISE_TIME_CONSTANTS * decay);
    this.bubble.start(peak, frequency, sweep, decay, MAX_BUBBLE_FREQUENCY);
    this.left = panLeft(pan);
    this.right = panRight(pan);
    this.remaining = peak > floor ? Math.ceil(decay * Math.log(peak / floor) * this.sampleRate) : 0;
  }

  /** Adds samples `from` to `to` into the outputs. Returns false once the bubble has ended. */
  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    const bubble = this.bubble;
    const gainLeft = this.left;
    const gainRight = this.right;
    const end = Math.min(to, from + this.remaining);
    for (let i = from; i < end && bubble.active; i++) {
      const y = bubble.next();
      left[i] += y * gainLeft;
      right[i] += y * gainRight;
    }
    this.remaining -= end - from;
    if (this.remaining <= 0) {
      bubble.stop();
    }
    return bubble.active;
  }
}

/**
 * The stream's bubbles, stereo, rendered from any absolute sample, the same
 * whether rendered in one go or in chunks.
 */
export class StreamKernel {
  private readonly seed: number;
  private readonly sampleRate: number;
  private readonly voices: VoicePool<StreamVoice>;
  private readonly surge: DriftGenerator;
  /** The params `set` gave. */
  private flow = Number.NaN;
  private size = 30;
  private level = 1;
  private density = 1;
  /** Each remembered block's cluster rate and flow, at index `block & (HISTORY − 1)`. */
  private readonly historyBlocks = new Float64Array(HISTORY).fill(Number.NaN);
  private readonly historyRates = new Float64Array(HISTORY);
  private readonly historyFlows = new Float64Array(HISTORY);
  /** The loaded block's bubble starts, sorted: seconds into the block, hash and pan. */
  private readonly offsets = new Float64Array(START_CAPACITY);
  private readonly hashes = new Uint32Array(START_CAPACITY);
  private readonly pans = new Float64Array(START_CAPACITY);
  private count = 0;
  private readonly parents = createEventBlock(PARENT_CAPACITY);
  private readonly children = new Float64Array(MAX_CLUSTER);
  /** The shape `bubbleParams` fills for each bubble as it starts. */
  private readonly scratchBubble: BubbleShape = { gain: 1, rise: 0, decay: 0 };
  private readonly peak: number;
  private readonly warmUpSamples: number;
  private readonly scratchLeft = new Float32Array(SCRATCH);
  private readonly scratchRight = new Float32Array(SCRATCH);
  /** The block whose starts are loaded, and the next of them to start. */
  private block = Number.NaN;
  private next = 0;
  /** The absolute sample the next render should start at, if it carries straight on. */
  private expected = Number.NaN;

  constructor(seed: number, sampleRate: number) {
    this.seed = seed;
    this.sampleRate = sampleRate;
    this.voices = new VoicePool(BUBBLE_VOICES, () => new StreamVoice(sampleRate));
    this.surge = new DriftGenerator(seed, SURGE_STREAM, SURGE.rate, SURGE.octaves, sampleRate);
    this.peak = dbToGain(BUBBLE_PEAK_DB);
    this.warmUpSamples = Math.ceil(WARM_UP * sampleRate);
    this.set(45, 30, 1);
  }

  /**
   * Sets the params for the next render: `flow` (0–100), latched per block
   * for the clusters' rate, number and spread and per bubble for its density
   * gain; `size` (0–100) and `level` (the bubbles' gain), latched per bubble.
   */
  set(flow: number, size: number, level: number): void {
    if (flow !== this.flow) {
      this.density = densityGain(flow);
    }
    this.flow = flow;
    this.size = size;
    this.level = level;
  }

  /** Cluster parents per second in block `block` at `flow`, pushed by the surge. */
  clusterRate(block: number, flow: number): number {
    return parentRate(flow) * (1 + SURGE.depth * this.surge.valueAtTime(block));
  }

  /** Fills `left` and `right` (one length) from absolute sample `start`. */
  render(left: Float32Array, right: Float32Array, start: number): void {
    if (start !== this.expected) {
      this.warmUp(start);
    }
    this.process(left, right, left.length, start);
    this.expected = start + left.length;
  }

  /** Clears every voice, forgets the rates, then renders the `WARM_UP` before `start` silently. */
  private warmUp(start: number): void {
    const voices = this.voices;
    while (voices.active > 0) {
      voices.live[0]?.bubble.stop();
      voices.release(0);
    }
    this.historyBlocks.fill(Number.NaN);
    let from = start - this.warmUpSamples;
    this.load(blockOf(from, this.sampleRate));
    while (this.next < this.count && this.startSample(this.next) < from) {
      this.next++;
    }
    while (from < start) {
      const length = Math.min(SCRATCH, start - from);
      this.process(this.scratchLeft, this.scratchRight, length, from);
      from += length;
    }
  }

  /** Loads block `block`'s bubble starts, latching the current rate and flow for it. */
  private load(block: number): void {
    const slot = block & (HISTORY - 1);
    this.historyBlocks[slot] = block;
    this.historyRates[slot] = this.clusterRate(block, this.flow);
    this.historyFlows[slot] = this.flow;
    this.block = block;
    this.count = 0;
    this.next = 0;
    const seed = this.seed;
    const parents = this.parents;
    // Clusters of this block and the one before (a cluster lasts far less than a block).
    for (let b = block - 1; b <= block; b++) {
      const s = b & (HISTORY - 1);
      const known = this.historyBlocks[s] === b;
      const flow = known ? (this.historyFlows[s] ?? 0) : this.flow;
      const rate = known ? (this.historyRates[s] ?? 0) : this.clusterRate(b, flow);
      const count = eventsInBlock(seed, BUBBLE_STREAM, b, rate, parents);
      for (let i = 0; i < count; i++) {
        const time = b + (parents.offsets[i] ?? 0);
        this.addCluster(eventHash(seed, BUBBLE_STREAM, b, i), time, flow);
      }
    }
  }

  /** Adds the children of cluster `hash`, whose parent is at absolute `time` (s), that land in the loaded block. */
  private addCluster(hash: number, time: number, flow: number): void {
    const count = clusterChildren(hash, flow, this.children);
    const pan = (unit(hash, PAN) * 2 - 1) * CLUSTER_PAN;
    for (let c = 0; c < count; c++) {
      const offset = time + (this.children[c] ?? 0) - this.block;
      if (offset >= 0 && offset < 1) {
        this.addStart(offset, childHash(hash, c), pan);
      }
    }
  }

  /** Inserts a start into the loaded block's list, keeping it sorted. */
  private addStart(offset: number, hash: number, pan: number): void {
    if (this.count >= START_CAPACITY) {
      return;
    }
    let i = this.count;
    while (i > 0 && (this.offsets[i - 1] ?? 0) > offset) {
      this.offsets[i] = this.offsets[i - 1] ?? 0;
      this.hashes[i] = this.hashes[i - 1] ?? 0;
      this.pans[i] = this.pans[i - 1] ?? 0;
      i--;
    }
    this.offsets[i] = offset;
    this.hashes[i] = hash;
    this.pans[i] = pan;
    this.count++;
  }

  /** The absolute sample start `i` of the loaded block falls on. */
  private startSample(i: number): number {
    return this.block * this.sampleRate + Math.floor((this.offsets[i] ?? 0) * this.sampleRate);
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
      while (this.next < this.count && this.startSample(this.next) <= now) {
        this.startBubble(this.hashes[this.next] ?? 0, this.pans[this.next] ?? 0);
        this.next++;
      }
      // Render up to the next start, the block's end or the buffer's end.
      let end = Math.min(length, (block + 1) * sr - start);
      if (this.next < this.count) {
        end = Math.min(end, this.startSample(this.next) - start);
      }
      const voices = this.voices;
      // Backwards, so releasing a voice (which swaps in the last) is safe.
      for (let i = voices.active - 1; i >= 0; i--) {
        if (!voices.live[i]?.render(left, right, pos, end)) {
          voices.release(i);
        }
      }
      pos = end;
    }
  }

  /** Starts the bubble `hash`, in a cluster at `clusterPan`, at the current size and level. */
  private startBubble(hash: number, clusterPan: number): void {
    const u = unit(hash, AMPLITUDE);
    const frequency = bubbleParams(hash, this.size, this.scratchBubble);
    // A power law: most bubbles are faint, a few are close.
    const amplitude = u * u * this.scratchBubble.gain * this.density * this.level;
    if (amplitude < SILENT_AMPLITUDE) {
      return;
    }
    const pan = clusterPan + (unit(hash, PAN) * 2 - 1) * BUBBLE_PAN;
    this.voices
      .allocate()
      .start(
        amplitude * this.peak,
        frequency,
        this.scratchBubble.rise,
        this.scratchBubble.decay,
        pan,
        this.peak * BUBBLE_FLOOR,
      );
  }
}

/** A bubble's shape, apart from its pitch: see `bubbleParams`. */
export interface BubbleShape {
  /** The gain for its size: down to `SMALL_BUBBLE_DB` for the smallest. */
  gain: number;
  /** How much it rises over three time constants (0.1–0.6). */
  rise: number;
  /** Its decay time constant, in seconds. */
  decay: number;
}

/**
 * The bubble `hash`'s shape at `size` (0–100), into `out`, and its starting
 * frequency in Hz: a log-uniform radius in `radiusRange(size)`; a decay from
 * its pitch, ±20 %; a rise of 10–60 %, more for small bubbles; and a gain
 * that lowers the smallest by up to 6 dB.
 */
export function bubbleParams(hash: number, size: number, out: BubbleShape): number {
  const [smallest, largest] = radiusRange(size);
  const radius = smallest * (largest / smallest) ** unit(hash, RADIUS);
  const frequency = bubbleFrequency(radius);
  const small = smallness(frequency);
  out.gain = dbToGain(SMALL_BUBBLE_DB * small);
  out.rise = lerp(RISE_RANGE[0], RISE_RANGE[1], 0.5 * small + 0.5 * unit(hash, RISE));
  out.decay = bubbleDecay(frequency) * (1 + DECAY_JITTER * (unit(hash, DECAY) * 2 - 1));
  return frequency;
}

/** The longest a bubble can ring, in seconds: under `WARM_UP`. */
export const LONGEST_BUBBLE = DECAY_LOW.decay * (1 + DECAY_JITTER) * BUBBLE_LIFE;

/**
 * Everything the stream worklet makes, into `STREAM_CHANNELS` channels: the
 * rush's stereo pink and brown noise under the swell, and the bubbles
 * (`StreamKernel`), all from absolute samples, so time-addressable.
 */
export class StreamGenerator {
  private readonly sampleRate: number;
  private readonly pink: NoiseGenerator;
  private readonly brown: NoiseGenerator;
  private readonly swell: DriftGenerator;
  private readonly bubbles: StreamKernel;

  constructor(seed: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.pink = new NoiseGenerator("pink", seed, PINK_STREAM, 2, sampleRate);
    this.brown = new NoiseGenerator("brown", seed, BROWN_STREAM, 2, sampleRate);
    this.swell = new DriftGenerator(seed, SWELL_STREAM, SWELL.rate, SWELL.octaves, sampleRate);
    this.bubbles = new StreamKernel(seed, sampleRate);
  }

  /** Sets the bubbles' params: see `StreamKernel.set`. */
  set(flow: number, size: number, level: number): void {
    this.bubbles.set(flow, size, level);
  }

  /** The swell's gain at absolute sample `n`. */
  private swellAt(n: number): number {
    return dbToGain(SWELL.db * this.swell.valueAtTime(n / this.sampleRate));
  }

  /** Fills `channels` (`STREAM_CHANNELS` of one length) from absolute sample `start`. */
  render(channels: readonly Float32Array[], start: number): void {
    if (channels.length < STREAM_CHANNELS) {
      return;
    }
    this.pink.render(0, channels[PINK_CHANNEL], start);
    this.pink.render(1, channels[PINK_CHANNEL + 1], start);
    this.brown.render(0, channels[BROWN_CHANNEL], start);
    this.brown.render(1, channels[BROWN_CHANNEL + 1], start);
    // The swell, linear across the quantum between its values at either end.
    const length = channels[PINK_CHANNEL].length;
    const from = this.swellAt(start);
    const slope = (this.swellAt(start + length) - from) / length;
    for (let c = PINK_CHANNEL; c < BROWN_CHANNEL + 2; c++) {
      const channel = channels[c];
      for (let i = 0; i < length; i++) {
        channel[i] *= from + slope * i;
      }
    }
    this.bubbles.render(channels[BUBBLES_CHANNEL], channels[BUBBLES_CHANNEL + 1], start);
  }
}
