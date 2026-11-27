/**
 * Joining an export's chunks into one continuous signal, and turning that
 * signal into a seamless loop. Pure sample loops, so they test in Node.
 *
 * Two kinds of crossfade, for two kinds of signal:
 *
 *   - Neighbouring chunks are two renders of the same signal, so they join with
 *     an equal-gain (raised-cosine) crossfade, whose gains sum to 1: identical
 *     renders join exactly, with no bump. An equal-power one would lift the
 *     level by up to 3 dB across the overlap.
 *   - A loop's head and tail are different stretches of the sound, unrelated to
 *     each other, so they join with an equal-power crossfade, whose gains' squares
 *     sum to 1: the level holds steady through it.
 */

/** Equal-gain weights at `t` (0–1) through a crossfade: [outgoing, incoming]. */
export function equalGain(t: number): [number, number] {
  const incoming = Math.sin((Math.PI / 2) * t) ** 2;
  return [1 - incoming, incoming];
}

/** Equal-power weights at `t` (0–1) through a crossfade: [outgoing, incoming]. */
export function equalPower(t: number): [number, number] {
  const angle = (Math.PI / 2) * t;
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * Joins chunks, each of whose first `overlap` frames (after the first chunk)
 * cover the same time as the last `overlap` frames of the chunk before. Each
 * push returns the frames that are final, and holds back its last `overlap`
 * frames to crossfade with the next chunk; `finish` returns those.
 */
export class ChunkJoiner {
  private readonly overlap: number;
  private held: Float32Array[] | undefined;

  constructor(overlap: number) {
    this.overlap = overlap;
  }

  push(chunk: readonly Float32Array[]): Float32Array[] {
    const length = chunk[0]?.length ?? 0;
    const lead = this.held ? this.overlap : 0;
    const hold = Math.min(this.overlap, length - lead);
    if (lead > length || hold < 0) {
      throw new RangeError("A chunk is shorter than its overlap");
    }
    const out = chunk.map((samples, c) => {
      const block = samples.slice(0, length - hold);
      const previous = this.held?.[c];
      for (let i = 0; i < lead; i++) {
        const [fadeOut, fadeIn] = equalGain((i + 0.5) / lead);
        block[i] = (previous?.[i] ?? 0) * fadeOut + (samples[i] ?? 0) * fadeIn;
      }
      return block;
    });
    this.held = chunk.map((samples) => samples.slice(length - hold));
    return out;
  }

  /** The frames still held back, once there are no more chunks. */
  finish(): Float32Array[] {
    const held = this.held ?? [];
    this.held = undefined;
    return held;
  }
}

/**
 * Makes a seamless loop of length L from a signal L + X long: mixes the X
 * frames after the loop point (`tail`) into the first X with an equal-power
 * crossfade, from all tail at frame 0 to all head at frame X. The file then
 * starts exactly where its end leaves off: frame 0 is the frame that followed
 * frame L − 1 in the signal.
 *
 * `apply` takes the signal's frames in order, in blocks, starting at
 * `position`, and changes the ones before X in place.
 */
export class LoopHead {
  private readonly tail: readonly Float32Array[];
  private readonly crossfade: number;

  constructor(tail: readonly Float32Array[]) {
    this.tail = tail;
    this.crossfade = tail[0]?.length ?? 0;
  }

  apply(block: Float32Array[], position: number): void {
    const end = Math.min(this.crossfade - position, block[0]?.length ?? 0);
    block.forEach((samples, c) => {
      const tail = this.tail[c];
      for (let i = 0; i < end; i++) {
        const n = position + i;
        const [fadeOut, fadeIn] = equalPower(n / this.crossfade);
        samples[i] = (tail[n] ?? 0) * fadeOut + (samples[i] ?? 0) * fadeIn;
      }
    });
  }
}
