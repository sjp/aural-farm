/**
 * Time-addressable rhythmic events (ticks, beats, strikes). Event n happens at
 * `n · period + jitter(n)` seconds of absolute time, where `jitter(n)` comes from
 * a hash of n, so the schedule is computed from the time itself and never
 * accumulated: a render that starts anywhere finds the same events.
 *
 * A period change re-anchors the schedule at the next event, so that event keeps
 * its time (or comes sooner, if asked) and the new spacing applies from there
 * on: nothing jumps or repeats.
 * After a change the schedule is no longer a function of absolute time alone,
 * which is fine for live edits; at fixed params it is.
 *
 *   const schedule = new PeriodicSchedule(seed, STREAM, 1, 0.02);
 *   const events = createPeriodicEvents(4);
 *   schedule.eventsIn(t0, t1, events);   // per render quantum, absolute seconds
 *
 * Instead of a hashed jitter, a schedule can take each event's offset from a
 * function of its index, for timing that wanders in a shaped way (a slow
 * drift, a sway) rather than at random from one event to the next.
 */
import { HASH_START, hashStep, UINT32_SCALE } from "../random";

/** Jitter is capped below half a period, so events always stay in order. */
const MAX_JITTER = 0.45;

/** A preallocated list of events: their absolute times (seconds) and indices. */
export interface PeriodicEvents {
  readonly times: Float64Array;
  readonly indices: Float64Array;
  /** How many entries are filled. */
  count: number;
}

/** An event list holding at most `capacity` events. */
export function createPeriodicEvents(capacity: number): PeriodicEvents {
  return { times: new Float64Array(capacity), indices: new Float64Array(capacity), count: 0 };
}

/** Event n's offset from its grid position, as a fraction of the period. */
type PeriodicOffset = (n: number) => number;

export class PeriodicSchedule {
  private readonly prefix: number;
  private readonly jitter: number;
  private readonly offset: PeriodicOffset | undefined;
  private period: number;
  /** Event `anchorIndex` is nominally at `anchorTime`; later ones follow every `period`. */
  private anchorTime = 0;
  private anchorIndex = 0;
  /** Events before this index belong to an earlier period and never happen again. */
  private minIndex = Number.NEGATIVE_INFINITY;

  /**
   * @param period seconds between events (> 0)
   * @param jitter how far each event may stray from the grid, as a fraction of the
   *   period (0 to 0.45), at random; or each event's offset as a function of its
   *   index, a fraction of the period, held within ±0.45
   */
  constructor(seed: number, stream: number, period: number, jitter: number | PeriodicOffset = 0) {
    this.prefix = hashStep(hashStep(HASH_START, seed), stream);
    this.period = period;
    if (typeof jitter === "function") {
      this.offset = jitter;
      this.jitter = 0;
    } else {
      this.jitter = Math.min(MAX_JITTER, Math.max(0, jitter));
    }
  }

  /** Event n's offset from its grid position, in seconds. */
  private jitterOf(n: number): number {
    if (this.offset !== undefined) {
      return Math.min(MAX_JITTER, Math.max(-MAX_JITTER, this.offset(n))) * this.period;
    }
    if (this.jitter === 0) {
      return 0;
    }
    const u = hashStep(this.prefix, n) * UINT32_SCALE;
    return (2 * u - 1) * this.jitter * this.period;
  }

  /** The absolute time of event n, in seconds. */
  timeOf(n: number): number {
    return this.anchorTime + (n - this.anchorIndex) * this.period + this.jitterOf(n);
  }

  /** The index of the first event at or after absolute time `t`. */
  nextIndex(t: number): number {
    let n = this.anchorIndex + Math.floor((t - this.anchorTime) / this.period - MAX_JITTER);
    n = Math.max(n, this.minIndex);
    while (this.timeOf(n) < t) {
      n++;
    }
    return n;
  }

  /**
   * Fills `out` with the events in [t0, t1) (absolute seconds), in order, and
   * returns their count. Events beyond `out`'s capacity are dropped.
   */
  eventsIn(t0: number, t1: number, out: PeriodicEvents): number {
    out.count = 0;
    const capacity = out.times.length;
    for (let n = this.nextIndex(t0); out.count < capacity; n++) {
      const t = this.timeOf(n);
      if (t >= t1) {
        break;
      }
      out.times[out.count] = t;
      out.indices[out.count] = n;
      out.count++;
    }
    return out.count;
  }

  /**
   * Changes the period from the first event at or after `when`: that event keeps
   * its time, but comes no later than `latest` (and never before `when`), and
   * the events after it follow the new period. A `latest` of `when` plus the new
   * period lets a much shorter period take effect soon, rather than after the
   * long wait the old one had left.
   */
  setPeriod(period: number, when: number, latest = Number.POSITIVE_INFINITY): void {
    if (period === this.period) {
      return;
    }
    const next = this.nextIndex(when);
    const time = Math.min(this.timeOf(next), Math.max(when, latest));
    this.period = period;
    this.anchorIndex = next;
    // Solve for the anchor so event `next` lands where it was, with its new jitter.
    this.anchorTime = time - this.jitterOf(next);
    this.minIndex = next;
  }
}
