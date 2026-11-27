/**
 * Wind Chimes: a set of tuned tubes hanging on a porch, stirred by a light
 * breeze. Most of the time a tube rings now and then and fades over many
 * seconds; when a gust comes through, several ring together in a soft
 * cluster, then it settles again. Because the tubes are tuned to a scale, any
 * combination is consonant.
 *
 * The gusts, the strikes and the tubes all come from one worklet
 * (`chimes-dsp.ts`) per tuning and seed, which goes on to the layer and to the
 * shared outdoor reverb. A change of tuning crossfades the set over 1.5 s
 * (each set keeping its own strikes, so both are briefly heard); a seed change
 * crossfades its worklet over 2 s. Tubes and Wind latch per strike, and Space
 * glides.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { CHIMES_CHANNELS, CHIMES_PROCESSOR } from "./chimes-dsp";
import { chimesMeta, type ChimeTuning } from "./chimes.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import chimesWorkletUrl from "./chimes.worklet.ts?worker&url";

type ChimesParams = ParamValues<typeof chimesMeta.params>;

/** The outdoor reverb's send at Space `space` (0–100), in dB: −16 to −4. */
export function spaceSendDb(space: number): number {
  return -16 + 0.12 * Math.min(100, Math.max(0, space));
}
/** Space's glide time constant, in seconds. */
const SPACE_GLIDE = 0.3;
/** Crossfades, in seconds: a change of tuning, and of seed. */
const TUNING_FADE = 1.5;
const SEED_FADE = 2;

/** The worklet's params. */
const workletParams = (p: ChimesParams) => ({ tubes: p.tubes, wind: p.wind });

interface Graph extends Disposable {
  update: (params: ChimesParams, when: number) => void;
}

/** Every live graph's shared needs: the params now, absolute time, and error reporting. */
interface Context {
  ctx: BaseAudioContext;
  params: () => ChimesParams;
  absoluteNow: () => number;
  onError: ((error: unknown) => void) | undefined;
}

/**
 * Builds `tuning`'s set for `seed` into `into`, at the params `c.params()`
 * gives once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  c: Context,
  into: AudioNode,
  tuning: ChimeTuning,
  seed: number,
  live: Set<Graph>,
): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const initial = c.params();
    const source = await startProcessor(c.ctx, scope, chimesWorkletUrl, CHIMES_PROCESSOR, {
      channels: CHIMES_CHANNELS,
      startAt: c.absoluteNow(),
      processorOptions: { tuning, seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);

    const variation: Graph = {
      update(next, when) {
        // Both latch in the kernel, per strike.
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

/** Builds `tuning`'s set into `into`, crossfading on a seed change, and adds it to `live`. */
function buildTuning(
  c: Context,
  into: AudioNode,
  tuning: ChimeTuning,
  live: Set<Graph>,
): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const variations = new Set<Graph>();
    const fader = createCrossfader(c.ctx, scope, into, SEED_FADE);
    let seed = c.params().seed;
    const variation = (variationSeed: number) => (out: AudioNode) =>
      buildVariation(c, out, tuning, variationSeed, variations);
    await fader.swap(variation(seed));

    const set: Graph = {
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
    live.add(set);
    scope.defer(() => {
      live.delete(set);
    });
    return set;
  }, c.onError);
}

export const chimes = defineSound(chimesMeta, {
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
      const send = createSend(ctx, scope, mix, out, "outdoor", spaceSendDb(params.space));

      const fader = createCrossfader(ctx, scope, mix, TUNING_FADE);
      let tuning = params.tuning;
      const build = (t: ChimeTuning) => (into: AudioNode) => buildTuning(c, into, t, live);
      await fader.swap(build(tuning));

      return {
        update(next, when) {
          const previous = params;
          params = next;
          if (next.space !== previous.space) {
            glide(send.gain, dbToGain(spaceSendDb(next.space)), when, SPACE_GLIDE);
          }
          for (const g of live) {
            g.update(next, when);
          }
          if (next.tuning !== tuning) {
            tuning = next.tuning;
            fader.swap(build(tuning)).catch((error: unknown) => {
              init.onError?.(error);
            });
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    }, init.onError);
  },
});
