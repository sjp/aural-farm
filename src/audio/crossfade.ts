/**
 * Equal-power crossfades between whole sub-graphs, for params that change a
 * sound's character (a select, or the seed): the new graph is built beside the
 * old one, faded in on a sine curve while the old one fades out on a cosine, and
 * the old one is disposed once its fade has ended.
 *
 *   const fader = createCrossfader(ctx, scope, out, 2);
 *   await fader.swap((into) => buildVariation(ctx, into, params));  // first: full level at once
 *   …
 *   fader.swap((into) => buildVariation(ctx, into, next)).catch(init.onError);
 *
 * The end of a fade is found on the audio clock (a silent source's `ended`
 * event), never a timer, so it works in a background tab and offline.
 */
import type { AudioScope, Disposable } from "./scope";

/** Points in a fade curve. */
const CURVE_POINTS = 64;

interface Crossfader {
  /**
   * Builds a new graph into a fresh input and crossfades to it. The first graph
   * starts at full level. A swap made while another is still building wins: the
   * older build is disposed when it arrives. Calling it again mid-fade fades the
   * current graph out from wherever it had got to.
   */
  swap: (build: (out: AudioNode) => Disposable | Promise<Disposable>) => Promise<void>;
  /** Disposes every graph at once. */
  dispose: () => void;
}

/** One graph and its fader gain. */
interface Slot {
  gain: GainNode;
  graph: Disposable;
  /** The fade it is in: in on a sine from `start`, out on a cosine from `from`, or steady. */
  fade: "steady" | "in" | "out";
  start: number;
  from: number;
  /** The silent source whose `ended` event marks the end of a fade-out. */
  timer: ConstantSourceNode | undefined;
  released: boolean;
}

/** A quarter-cycle of sine (fade in) or cosine (fade out), scaled by `scale`. */
function curve(direction: "in" | "out", scale: number): Float32Array {
  const values = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (i / (CURVE_POINTS - 1)) * (Math.PI / 2);
    values[i] = scale * (direction === "in" ? Math.sin(x) : Math.cos(x));
  }
  return values;
}

/**
 * A crossfader feeding `out`, fading over `seconds`. It is registered with
 * `scope`, so disposing the scope disposes every graph it holds.
 */
export function createCrossfader(
  ctx: BaseAudioContext,
  scope: AudioScope,
  out: AudioNode,
  seconds: number,
): Crossfader {
  let current: Slot | undefined;
  const leaving = new Set<Slot>();
  let latest = 0;
  let disposed = false;

  const levelAt = (slot: Slot, t: number): number => {
    const x = Math.min(1, Math.max(0, (t - slot.start) / seconds)) * (Math.PI / 2);
    switch (slot.fade) {
      case "steady":
        return slot.from;
      case "in":
        return Math.sin(x);
      case "out":
        return slot.from * Math.cos(x);
      default:
        return 0;
    }
  };

  const release = (slot: Slot) => {
    if (slot.released) {
      return;
    }
    slot.released = true;
    leaving.delete(slot);
    if (slot.timer) {
      try {
        slot.timer.stop();
      } catch {
        // Already stopped.
      }
      slot.timer.disconnect();
    }
    try {
      slot.graph.dispose();
    } finally {
      slot.gain.disconnect();
    }
  };

  const fadeOut = (slot: Slot, now: number) => {
    const from = levelAt(slot, now);
    // From 0, not `now`: Firefox keeps a fade-in curve that began before the
    // cancel time, then refuses a new curve over it.
    slot.gain.gain.cancelScheduledValues(0);
    slot.gain.gain.setValueCurveAtTime(curve("out", from), now, seconds);
    slot.fade = "out";
    slot.from = from;
    slot.start = now;
    // A silent source that ends with the fade, to dispose the graph on the audio
    // clock. It is connected so the browser keeps processing it.
    const timer = new ConstantSourceNode(ctx, { offset: 0 });
    timer.connect(slot.gain);
    timer.addEventListener("ended", () => {
      release(slot);
    });
    timer.start(now);
    timer.stop(now + seconds);
    slot.timer = timer;
    leaving.add(slot);
  };

  const swap: Crossfader["swap"] = async (build) => {
    if (disposed) {
      return;
    }
    const token = ++latest;
    // A function, so the checks after the await read the state afresh.
    const stale = () => disposed || token !== latest;
    const gain = new GainNode(ctx, { gain: 0 });
    gain.connect(out);
    let graph: Disposable;
    try {
      const built = build(gain);
      graph = built instanceof Promise ? await built : built;
    } catch (error) {
      gain.disconnect();
      throw error;
    }
    const slot: Slot = {
      gain,
      graph,
      fade: "steady",
      start: 0,
      from: 1,
      timer: undefined,
      released: false,
    };
    if (stale()) {
      // Overtaken by a newer swap, or the sound went away while this was building.
      release(slot);
      return;
    }
    const now = ctx.currentTime;
    if (current) {
      fadeOut(current, now);
      gain.gain.setValueCurveAtTime(curve("in", 1), now, seconds);
      slot.fade = "in";
      slot.start = now;
    } else {
      gain.gain.setValueAtTime(1, now);
    }
    current = slot;
  };

  const crossfader: Crossfader = {
    swap,
    dispose() {
      disposed = true;
      const slots = [...leaving, ...(current ? [current] : [])];
      current = undefined;
      let first: { error: unknown } | undefined;
      for (const slot of slots) {
        try {
          release(slot);
        } catch (error) {
          first ??= { error };
        }
      }
      if (first) {
        throw first.error;
      }
    },
  };
  return scope.own(crossfader);
}
