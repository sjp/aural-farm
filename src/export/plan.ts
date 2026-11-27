/**
 * How an export is cut into renders. An `OfflineAudioContext` allocates its
 * whole output up-front, so a long file renders in chunks of 30 s, each in a
 * fresh context, which keeps memory bounded and caps a cancel's cost at one
 * chunk. Sounds are time-addressable, so chunks rendered separately line up:
 *
 *   - each chunk starts `PREROLL` early and throws that part away, so filters,
 *     reverbs and the limiter have settled by the part it keeps;
 *   - each chunk after the first also starts `OVERLAP` before the one before
 *     ends, and the two are crossfaded there to hide any residual difference.
 *
 * Chunk k keeps file time from 30k − overlap (0 for the first) and is built with
 * `startAt` 5 s before that. The file's first sample stands for absolute time
 * `PREROLL`, so the first chunk's preroll starts at absolute time 0, as a live
 * context does, and no sound is ever asked for a negative time.
 *
 * A seamless loop of length L renders L + X seconds, where X is its crossfade:
 * the X seconds after the loop point are mixed into the first X (see `join.ts`).
 * Those X seconds are a chunk of their own, the loop's tail, joined last.
 */

/** The sample rate exports render and write at. */
const EXPORT_RATE = 48000;
const CHUNK_SECONDS = 30;
const PREROLL_SECONDS = 5;
const OVERLAP_SECONDS = 0.05;
/** A last chunk shorter than this joins the one before instead. */
const MIN_CHUNK_SECONDS = 1;
const MAX_LOOP_CROSSFADE_SECONDS = 5;
/** Layers' loop periods agree when they are whole multiples of each other within this. */
const PERIOD_TOLERANCE = 0.01;

interface Chunk {
  /** The first frame of the file's timeline it renders, counting its leading overlap. */
  from: number;
  /** How many frames it keeps once its preroll is dropped, counting its leading overlap. */
  frames: number;
  /** Frames at its start that overlap the chunk before (0 for the first). */
  overlap: number;
  /** Frames of preroll rendered before `from` and thrown away. */
  preroll: number;
  /** The absolute time its context's first sample stands for, in seconds. */
  startAt: number;
}

interface ExportPlan {
  sampleRate: number;
  /** The file's length, in frames. */
  frames: number;
  /** A loop's crossfade, in frames; 0 for a clip. */
  crossfade: number;
  /** The chunks in the order they join. A loop's last chunk is its tail. */
  chunks: Chunk[];
  /** The frames joined in all: the file, plus a loop's tail. */
  joined: number;
  /** Overlap frames between neighbouring chunks. */
  overlap: number;
}

/** A loop's crossfade length for a loop of `seconds`: min(5 s, L / 6). */
export function loopCrossfadeSeconds(seconds: number): number {
  return Math.min(MAX_LOOP_CROSSFADE_SECONDS, seconds / 6);
}

/** Cuts the frames from `start` to `end` into pieces of `size`, folding a short last piece into the one before. */
function segments(start: number, end: number, size: number, min: number): [number, number][] {
  const out: [number, number][] = [];
  for (let from = start; from < end; from += size) {
    out.push([from, Math.min(end, from + size)]);
  }
  const last = out.at(-1);
  const before = out.at(-2);
  if (last && before && last[1] - last[0] < min) {
    out.pop();
    before[1] = last[1];
  }
  return out;
}

/**
 * The chunks for a clip of `seconds`, or a seamless loop of `seconds` when
 * `loop` is set.
 */
export function planExport(seconds: number, loop: boolean, sampleRate = EXPORT_RATE): ExportPlan {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const crossfade = loop ? Math.round(loopCrossfadeSeconds(frames / sampleRate) * sampleRate) : 0;
  const size = Math.round(CHUNK_SECONDS * sampleRate);
  const min = Math.round(MIN_CHUNK_SECONDS * sampleRate);
  const overlap = Math.round(OVERLAP_SECONDS * sampleRate);
  const preroll = Math.round(PREROLL_SECONDS * sampleRate);
  const pieces = segments(0, frames, size, min);
  if (crossfade > 0) {
    pieces.push([frames, frames + crossfade]);
  }
  const chunks = pieces.map(([start, end], index): Chunk => {
    const lead = index === 0 ? 0 : overlap;
    const from = start - lead;
    return {
      from,
      frames: end - from,
      overlap: lead,
      preroll,
      // File time `from − preroll`, plus the file's start at absolute time `PREROLL`.
      startAt: (from - preroll) / sampleRate + PREROLL_SECONDS,
    };
  });
  return { sampleRate, frames, crossfade, chunks, joined: frames + crossfade, overlap };
}

/**
 * The period the layers' rhythms share: the longest, when every other one
 * divides it a whole number of times within 1 %, else undefined (they
 * disagree, or there are none).
 */
export function commonPeriod(periods: readonly number[]): number | undefined {
  const valid = periods.filter((p) => Number.isFinite(p) && p > 0);
  if (valid.length === 0) {
    return undefined;
  }
  const longest = Math.max(...valid);
  const agree = valid.every((p) => {
    const ratio = longest / p;
    const whole = Math.round(ratio);
    return Math.abs(ratio - whole) <= PERIOD_TOLERANCE * whole;
  });
  return agree ? longest : undefined;
}

/**
 * A loop length near `seconds` that holds a whole number of the layers'
 * shared rhythm period (at least one), so a rhythm runs on across the loop
 * point. Unchanged when the layers have no shared period.
 */
export function snapLoopSeconds(seconds: number, periods: readonly number[]): number {
  const period = commonPeriod(periods);
  return period === undefined ? seconds : Math.max(1, Math.round(seconds / period)) * period;
}
