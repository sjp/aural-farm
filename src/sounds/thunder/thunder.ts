/**
 * Distant Thunder: a storm some miles away. Mostly quiet, then now and again a
 * long, low rumble swells in, rolls through a few overlapping peaks and dies
 * away over many seconds.
 *
 *   rumbles:  from the thunder worklet, which makes each one from its own
 *             counter-hashed noise: brown-ish noise in a low band (felt), a
 *             band at 160–450 Hz (heard, on small speakers too), a grumbling
 *             texture on each, and for a near storm a muffled crack.
 *   distance: nearer storms are brighter and quicker, with a crack from 60
 *             up; further ones send more to the shared outdoor reverb.
 *
 * The worklet does all the work, and nothing between rumbles. Every param
 * latches as a rumble starts (the gap as each second starts), so a change
 * applies from the next rumble and needs no glide or crossfade. The seed picks
 * a variation (that worklet), and a change crossfades to a new one.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { MEAN_GAPS, sendDb, THUNDER_CHANNELS, THUNDER_PROCESSOR } from "./thunder-dsp";
import { thunderMeta } from "./thunder.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import thunderWorkletUrl from "./thunder.worklet.ts?worker&url";

type ThunderParams = ParamValues<typeof thunderMeta.params>;

/** The reverb send glides with this time constant, in seconds. */
const GLIDE = 0.5;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

interface Variation extends Disposable {
  update: (params: ThunderParams, when: number) => void;
}

/** The worklet's params. */
const rumbleParams = (p: ThunderParams) => ({
  gap: MEAN_GAPS[p.often],
  distance: p.distance,
  roll: p.roll,
});

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => ThunderParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, thunderWorkletUrl, THUNDER_PROCESSOR, {
      channels: THUNDER_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: rumbleParams(initial),
    });
    source.connect(into);

    const variation: Variation = {
      update(next, when) {
        // Rumbles latch these as they start, so they need no glide.
        for (const [name, value] of Object.entries(rumbleParams(next))) {
          source.parameters.get(name)?.setValueAtTime(value, when);
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    // A change made while the worklet loaded.
    const p = params();
    if (p !== initial) {
      variation.update(p, ctx.currentTime);
    }
    live.add(variation);
    scope.defer(() => {
      live.delete(variation);
    });
    return variation;
  }, onError);
}

export const thunder = defineSound(thunderMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      // The variations meet here, with a send to the outdoor reverb.
      const bus = scope.add(new GainNode(ctx));
      bus.connect(out);
      const send = createSend(ctx, scope, bus, out, "outdoor", sendDb(params.distance));

      const fader = createCrossfader(ctx, scope, bus, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
          glide(send.gain, dbToGain(sendDb(next.distance)), when, GLIDE);
          for (const v of live) {
            v.update(next, when);
          }
          if (next.seed !== seed) {
            seed = next.seed;
            fader.swap(variation(seed)).catch((error: unknown) => {
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
