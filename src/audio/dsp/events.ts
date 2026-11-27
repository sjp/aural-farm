/**
 * Time-addressable random events (rain drops, crackles, chirps). Time is cut into
 * 1 s blocks of absolute time, and each block's events come from hashes of the
 * block's index alone. So the events at any moment depend only on the seed, the
 * stream, the rate and the time, never on when rendering began, and a chunked
 * render joins seamlessly.
 *
 * A rate change applies from the next block: callers read the rate once per block
 * and pass it here, which latches it.
 *
 *   const block = createEventBlock(256);
 *   eventsInBlock(seed, STREAM, b, rate, block);
 *   for (let i = 0; i < block.count; i++) {
 *     const t = b + block.offsets[i];          // absolute seconds
 *     const size = hashStep(eventHash(seed, STREAM, b, i), SIZE) * UINT32_SCALE;
 *   }
 */
import { HASH_START, hashStep, UINT32_SCALE } from "../random";

/** The length of one block, in seconds. Blocks start at whole seconds of absolute time. */
export const BLOCK_SECONDS = 1;

/** Salts that keep the count, position and per-event hashes apart. */
const COUNT_SALT = 0x6c0a71;
const POSITION_SALT = 0x6c0a72;
const EVENT_SALT = 0x6c0a73;

/**
 * Poisson counts come from slices of the block whose expected count is at most
 * this, so the inverse CDF never starts from an underflowing e^−λ.
 */
const MAX_SLICE_MEAN = 16;
/** A guard on the inverse CDF loop; a slice almost never reaches it. */
const MAX_SLICE_COUNT = 200;

/** A preallocated list of event offsets within a block, in seconds, sorted. */
export interface EventBlock {
  readonly offsets: Float64Array;
  /** How many of `offsets` are filled. */
  count: number;
}

/** An event list holding at most `capacity` events. Events beyond it are dropped. */
export function createEventBlock(capacity: number): EventBlock {
  return { offsets: new Float64Array(capacity), count: 0 };
}

/** A Poisson-distributed count with mean `mean` (≤ `MAX_SLICE_MEAN`), by inverse CDF of `u`. */
function poisson(mean: number, u: number): number {
  let p = Math.exp(-mean);
  let cdf = p;
  let k = 0;
  while (u > cdf && k < MAX_SLICE_COUNT) {
    k++;
    p *= mean / k;
    cdf += p;
  }
  return k;
}

/**
 * Fills `out` with the events of block `blockIndex` (absolute seconds
 * `blockIndex` to `blockIndex + 1`) for a Poisson process at `ratePerSecond`, and
 * returns their count. Offsets are in seconds from the block's start, sorted.
 */
export function eventsInBlock(
  seed: number,
  stream: number,
  blockIndex: number,
  ratePerSecond: number,
  out: EventBlock,
): number {
  out.count = 0;
  const mean = ratePerSecond * BLOCK_SECONDS;
  if (!(mean > 0)) {
    return 0;
  }
  const capacity = out.offsets.length;
  const slices = Math.ceil(mean / MAX_SLICE_MEAN);
  const sliceMean = mean / slices;
  const sliceLength = BLOCK_SECONDS / slices;
  // Hashes are folded by hand: `hash32`'s rest parameter would allocate.
  const block = hashStep(hashStep(hashStep(HASH_START, seed), stream), blockIndex);
  const counts = hashStep(block, COUNT_SALT);
  const positions = hashStep(block, POSITION_SALT);
  for (let j = 0; j < slices && out.count < capacity; j++) {
    const count = poisson(sliceMean, hashStep(counts, j) * UINT32_SCALE);
    const slice = hashStep(positions, j);
    const first = out.count;
    for (let k = 0; k < count && out.count < capacity; k++) {
      const offset = (j + hashStep(slice, k) * UINT32_SCALE) * sliceLength;
      // Insertion sort within the slice: slices are short and already in order.
      let i = out.count;
      while (i > first && (out.offsets[i - 1] ?? 0) > offset) {
        out.offsets[i] = out.offsets[i - 1] ?? 0;
        i--;
      }
      out.offsets[i] = offset;
      out.count++;
    }
  }
  return out.count;
}

/**
 * A hash for event `eventIndex` of a block, to derive its own random properties
 * (size, pan, pitch) with `hashStep(eventHash(…), property) * UINT32_SCALE`, so they never
 * depend on other events. It equals `hash32(seed, stream, blockIndex, salt,
 * eventIndex)` for an internal salt, and allocates nothing.
 */
export function eventHash(
  seed: number,
  stream: number,
  blockIndex: number,
  eventIndex: number,
): number {
  const block = hashStep(hashStep(hashStep(HASH_START, seed), stream), blockIndex);
  return hashStep(hashStep(block, EVENT_SALT), eventIndex);
}

/** The block that absolute sample `sampleIndex` falls in. */
export function blockOf(sampleIndex: number, sampleRate: number): number {
  return Math.floor(sampleIndex / (sampleRate * BLOCK_SECONDS));
}

/** Where absolute sample `sampleIndex` falls within its block, in seconds. */
export function offsetInBlock(sampleIndex: number, sampleRate: number): number {
  return sampleIndex / sampleRate - blockOf(sampleIndex, sampleRate) * BLOCK_SECONDS;
}
