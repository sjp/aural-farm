/**
 * Ticking Clock: a clock on a shelf or in the hall of a quiet house, heard
 * from the next armchair. Two layers:
 *
 *   clock: the tick-tock, each beat a tiny impact ringing the clock's case,
 *          tick and tock a little different, and never quite in beat; and,
 *          if on, a soft chime on each hour (one worklet, `clock-dsp.ts`)
 *   room:  a faint room tone from the same worklet, so the gaps between
 *          beats aren't digital silence, and the shared room reverb, from Room
 *
 * Each beat falls on `periodic.ts`'s grid of absolute time, so at steady
 * params a loop of whole tick-tocks joins seamlessly. A change of clock
 * crossfades the clock over 1.5 s, each keeping its own beat, so both are
 * briefly heard; a seed change crossfades its worklet over 2 s. Tone latches
 * as each beat starts; Room glides.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { CLOCK_CHANNELS, CLOCK_PROCESSOR, tickTockPeriod } from "./clock-dsp";
import { clockMeta, type ClockType } from "./clock.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import clockWorkletUrl from "./clock.worklet.ts?worker&url";

type ClockParams = ParamValues<typeof clockMeta.params>;

/** The room reverb's send at Room `room` (0–100), in dB. */
export function roomSendDb(room: number): number {
  return -40 + 0.3 * Math.min(100, Math.max(0, room));
}
/** Room's glide time constant, in seconds. */
const ROOM_GLIDE = 0.3;
/** Crossfades, in seconds: a change of clock, and of seed. */
const CLOCK_FADE = 1.5;
const SEED_FADE = 2;

/** The worklet's params. */
const workletParams = (p: ClockParams) => ({ tone: p.tone, chime: p.chime ? 1 : 0 });

interface Graph extends Disposable {
  update: (params: ClockParams, when: number) => void;
}

/** Every live graph's shared needs: the params now, absolute time, and error reporting. */
interface Context {
  ctx: BaseAudioContext;
  params: () => ClockParams;
  absoluteNow: () => number;
  onError: ((error: unknown) => void) | undefined;
}

/**
 * Builds clock `type` for `seed` into `into`, at the params `c.params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  c: Context,
  into: AudioNode,
  type: ClockType,
  seed: number,
  live: Set<Graph>,
): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const initial = c.params();
    const source = await startProcessor(c.ctx, scope, clockWorkletUrl, CLOCK_PROCESSOR, {
      channels: CLOCK_CHANNELS,
      startAt: c.absoluteNow(),
      processorOptions: { type, seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);

    const variation: Graph = {
      update(next, when) {
        // Both latch in the kernel: Tone per beat, the chime with its own glide.
        for (const [name, value] of Object.entries(workletParams(next))) {
          source.parameters.get(name)?.setValueAtTime(value, when);
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    // A change made while the worklet loaded.
    const p = c.params();
    if (p !== initial) {
      variation.update(p, c.ctx.currentTime);
    }
    live.add(variation);
    scope.defer(() => {
      live.delete(variation);
    });
    return variation;
  }, c.onError);
}

/** Builds clock `type` into `into`, crossfading on a seed change, and adds it to `live`. */
function buildClock(
  c: Context,
  into: AudioNode,
  type: ClockType,
  live: Set<Graph>,
): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const variations = new Set<Graph>();
    const fader = createCrossfader(c.ctx, scope, into, SEED_FADE);
    let seed = c.params().seed;
    const variation = (variationSeed: number) => (out: AudioNode) =>
      buildVariation(c, out, type, variationSeed, variations);
    await fader.swap(variation(seed));

    const clock: Graph = {
      update(next, when) {
        for (const v of variations) {
          v.update(next, when);
        }
        if (next.seed !== seed) {
          seed = next.seed;
          fader.swap(variation(seed)).catch((error: unknown) => {
            c.onError?.(error);
          });
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    live.add(clock);
    scope.defer(() => {
      live.delete(clock);
    });
    return clock;
  }, c.onError);
}

export const clock = defineSound(clockMeta, {
  // A tick and its tock: the two beats differ, so the rhythm repeats every two.
  loopPeriod: (params) => tickTockPeriod(params.clock),
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      let params = init.params;
      const c: Context = {
        ctx,
        params: () => params,
        absoluteNow: () => ctx.currentTime + offset,
        onError: init.onError,
      };
      const live = new Set<Graph>();

      const mix = scope.add(new GainNode(ctx));
      mix.connect(out);
      const send = createSend(ctx, scope, mix, out, "room", roomSendDb(params.room));

      const fader = createCrossfader(ctx, scope, mix, CLOCK_FADE);
      let type = params.clock;
      const build = (clockType: ClockType) => (into: AudioNode) =>
        buildClock(c, into, clockType, live);
      await fader.swap(build(type));

      const update = (next: ClockParams, when: number) => {
        const previous = params;
        params = next;
        if (next.room !== previous.room) {
          glide(send.gain, dbToGain(roomSendDb(next.room)), when, ROOM_GLIDE);
        }
        for (const g of live) {
          g.update(next, when);
        }
        if (next.clock !== type) {
          type = next.clock;
          fader.swap(build(type)).catch((error: unknown) => {
            init.onError?.(error);
          });
        }
      };
      return {
        update,
        dispose: () => {
          scope.dispose();
        },
      };
    }, init.onError);
  },
});
