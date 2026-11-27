/**
 * A fixed-size pool of voices for event kernels. All voices are made up front, so
 * nothing is allocated while rendering, and only active voices are visited, so
 * idle ones cost nothing. When the pool is full, a new event steals the quietest.
 *
 *   for (let i = pool.active - 1; i >= 0; i--) {   // backwards, so release is safe
 *     const voice = pool.live[i];
 *     …
 *     if (done) pool.release(i);
 *   }
 */

export interface PoolVoice {
  /** How loud the voice is now, to choose which to steal. */
  readonly level: number;
}

export class VoicePool<V extends PoolVoice> {
  /** Every voice: the first `active` are sounding, in no particular order. */
  readonly live: V[];
  /** How many voices are sounding. */
  active = 0;

  constructor(size: number, make: (index: number) => V) {
    this.live = Array.from({ length: size }, (_, i) => make(i));
  }

  get size(): number {
    return this.live.length;
  }

  /**
   * A voice for a new event: an idle one, made active, or, when every voice is
   * sounding, the quietest (which stays active for the caller to restart).
   */
  allocate(): V {
    if (this.live.length === 0) {
      throw new RangeError("The voice pool is empty");
    }
    if (this.active < this.live.length) {
      return this.live[this.active++];
    }
    let quietest = 0;
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.active; i++) {
      const level = Math.abs(this.live[i].level);
      if (level < lowest) {
        lowest = level;
        quietest = i;
      }
    }
    return this.live[quietest];
  }

  /** Returns the active voice at `index` (below `active`) to the idle voices. */
  release(index: number): void {
    const last = this.active - 1;
    if (index < 0 || index > last) {
      return;
    }
    const voice = this.live[index];
    this.live[index] = this.live[last];
    this.live[last] = voice;
    this.active--;
  }
}
