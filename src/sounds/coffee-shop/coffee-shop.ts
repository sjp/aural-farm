/**
 * Coffee Shop: a busy, friendly café heard from a corner table. A warm murmur
 * of conversation all around, people talking in pairs and taking turns, never
 * a word you could make out; the odd clink of a cup on a saucer; and now and
 * then the soft hiss of the steam wand, over the room's faint air.
 *
 * Everything comes from one worklet (`coffee-shop-dsp.ts`) per seed, whose
 * four channels are the sound and its feed to the shared room reverb, so the
 * talk can sit further back in the room than the clinks at the cost of one
 * send. Crowd fades people in or out over 1.5 s, Clatter changes the clinks'
 * rate from the next second, and Room size glides the reverb feed. A seed
 * change crossfades the worklet over 2 s.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { COFFEE_SHOP_CHANNELS, COFFEE_SHOP_PROCESSOR, roomDb } from "./coffee-shop-dsp";
import { coffeeShopMeta } from "./coffee-shop.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import coffeeShopWorkletUrl from "./coffee-shop.worklet.ts?worker&url";

type CoffeeShopParams = ParamValues<typeof coffeeShopMeta.params>;

/** The reverb send's glide time constant, in seconds. */
const ROOM_GLIDE = 0.3;
/** A seed change's crossfade, in seconds. */
const SEED_FADE = 2;

/** The worklet's params. */
const workletParams = (p: CoffeeShopParams) => ({ crowd: p.crowd, clatter: p.clatter });

interface Variation extends Disposable {
  update: (params: CoffeeShopParams, when: number) => void;
}

/**
 * Builds the café for `seed` into `into`, at the params `params()` gives once
 * its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => CoffeeShopParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, coffeeShopWorkletUrl, COFFEE_SHOP_PROCESSOR, {
      channels: COFFEE_SHOP_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);

    const variation: Variation = {
      update(next, when) {
        // The kernel fades the crowd and latches the clatter per block.
        for (const [name, value] of Object.entries(workletParams(next))) {
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

export const coffeeShop = defineSound(coffeeShopMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      // The variations meet here, four channels wide: the sound goes on to the
      // layer, the reverb feed to the room reverb.
      const bus = scope.add(new GainNode(ctx, { channelCount: COFFEE_SHOP_CHANNELS }));
      const channels = scope.add(
        new ChannelSplitterNode(ctx, { numberOfOutputs: COFFEE_SHOP_CHANNELS }),
      );
      bus.connect(channels);
      const stereo = (first: number) => {
        const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
        channels.connect(merger, first, 0);
        channels.connect(merger, first + 1, 1);
        return merger;
      };
      stereo(0).connect(out);
      const send = createSend(ctx, scope, stereo(2), out, "room", roomDb(params.room));

      const fader = createCrossfader(ctx, scope, bus, SEED_FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
          glide(send.gain, dbToGain(roomDb(next.room)), when, ROOM_GLIDE);
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
