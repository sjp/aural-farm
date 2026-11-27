/**
 * Birdsong: songbirds in a garden or wood, heard from a bench or an open
 * window. A handful of generic birds at their own distances and places, each
 * with its own voice and a small repertoire of phrases, singing, pausing and
 * now and then waiting for a nearer bird to finish, over a faint band of air.
 * The time of day sets how many sing and how busy they are: a dawn chorus,
 * a lively morning, or a sparse, quiet day.
 *
 * One worklet makes it all (`birdsong-dsp.ts`), each bird's dry signal and its
 * reverb send on their own stereo pair, so a far bird sounds further away than
 * a near one in the shared outdoor reverb. The seed picks a variation (that
 * worklet), and a change crossfades to a new one. The time of day, Activity
 * and Distance reach the worklet as AudioParams: each phrase latches the
 * first two as it is scheduled, each syllable the distance as it starts.
 */
import { createCrossfader } from "../../audio/crossfade";
import { glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { BIRDSONG_CHANNELS, BIRDSONG_PROCESSOR } from "./birdsong-dsp";
import { BIRDSONG_TIMES, birdsongMeta, type BirdsongTime } from "./birdsong.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import birdsongWorkletUrl from "./birdsong.worklet.ts?worker&url";

type BirdsongParams = ParamValues<typeof birdsongMeta.params>;

/** The distance glides with this time constant, in seconds. */
const DISTANCE_GLIDE = 0.8;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

/** The worklet's index for time of day `time`. */
const timeIndex = (time: BirdsongTime) =>
  Math.max(
    0,
    BIRDSONG_TIMES.findIndex((t) => t.value === time),
  );

interface Variation extends Disposable {
  update: (params: BirdsongParams, when: number) => void;
}

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => BirdsongParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, birdsongWorkletUrl, BIRDSONG_PROCESSOR, {
      channels: BIRDSONG_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: {
        time: timeIndex(initial.time),
        density: initial.density,
        distance: initial.distance,
      },
    });
    source.connect(into);
    const param = (name: string) => source.parameters.get(name);

    const variation: Variation = {
      update(next, when) {
        // Phrases latch the time of day and Activity, so they need no glide.
        param("time")?.setValueAtTime(timeIndex(next.time), when);
        param("density")?.setValueAtTime(next.density, when);
        const distance = param("distance");
        if (distance) {
          glide(distance, next.distance, when, DISTANCE_GLIDE);
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

export const birdsong = defineSound(birdsongMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      // The variations meet here, four channels wide, then split into the dry
      // pair, to the output, and the reverb pair, to the outdoor reverb.
      const bus = scope.add(
        new GainNode(ctx, {
          channelCount: BIRDSONG_CHANNELS,
          channelCountMode: "explicit",
          channelInterpretation: "discrete",
        }),
      );
      const channels = scope.add(
        new ChannelSplitterNode(ctx, { numberOfOutputs: BIRDSONG_CHANNELS }),
      );
      bus.connect(channels);
      const stereo = (first: number) => {
        const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
        channels.connect(merger, first, 0);
        channels.connect(merger, first + 1, 1);
        return merger;
      };
      stereo(0).connect(out);
      createSend(ctx, scope, stereo(2), out, "outdoor", 0);

      const fader = createCrossfader(ctx, scope, bus, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
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
