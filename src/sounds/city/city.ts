/**
 * Distant City: a city heard from an open window several streets away, or
 * from a balcony high up. Nothing is close: the low wash of traffic from
 * everywhere at once, swelling and easing as lights change across town; now
 * and then a single car on a nearer road, a soft whoosh that crosses from one
 * side to the other with a slight fall in pitch; and, if on, a very distant
 * horn or siren.
 *
 * Everything comes from one worklet (`city-dsp.ts`) per seed, whose four
 * channels are the sound and its feed to the shared outdoor reverb, so the
 * cars and signals can lean on the reverb more than the rumble does at the
 * cost of one send. Time glides the rumble to its day or night setting over
 * about two seconds and changes the cars' rate from the next second; Traffic
 * and the signals latch the same way, and Rumble glides. A seed change
 * crossfades the worklet over 2 s.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { CITY_CHANNELS, CITY_PROCESSOR, signalRate, spaceDb } from "./city-dsp";
import { cityMeta } from "./city.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import cityWorkletUrl from "./city.worklet.ts?worker&url";

type CityParams = ParamValues<typeof cityMeta.params>;

/** Glide time constants, in seconds: the rumble's level, and the reverb send. */
const RUMBLE_GLIDE = 0.1;
const SPACE_GLIDE = 0.3;
/** A seed change's crossfade, in seconds. */
const SEED_FADE = 2;

/** The worklet's params. */
const workletParams = (p: CityParams) => ({
  day: p.time === "day" ? 1 : 0,
  traffic: p.traffic,
  rumble: p.rumble,
  signals: signalRate(p.signals),
});

interface Variation extends Disposable {
  update: (params: CityParams, when: number) => void;
}

/**
 * Builds the city for `seed` into `into`, at the params `params()` gives once
 * its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => CityParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, cityWorkletUrl, CITY_PROCESSOR, {
      channels: CITY_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);

    const variation: Variation = {
      update(next, when) {
        for (const [name, value] of Object.entries(workletParams(next))) {
          const param = source.parameters.get(name);
          if (!param) {
            continue;
          }
          // The kernel glides the day and latches traffic and signals per block.
          if (name === "rumble") {
            glide(param, value, when, RUMBLE_GLIDE);
          } else {
            param.setValueAtTime(value, when);
          }
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

export const city = defineSound(cityMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      // The variations meet here, four channels wide: the sound goes on to the
      // layer, the reverb feed to the outdoor reverb.
      const bus = scope.add(new GainNode(ctx, { channelCount: CITY_CHANNELS }));
      const channels = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: CITY_CHANNELS }));
      bus.connect(channels);
      const stereo = (first: number) => {
        const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
        channels.connect(merger, first, 0);
        channels.connect(merger, first + 1, 1);
        return merger;
      };
      stereo(0).connect(out);
      const send = createSend(ctx, scope, stereo(2), out, "outdoor", spaceDb(params.space));

      const fader = createCrossfader(ctx, scope, bus, SEED_FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
          glide(send.gain, dbToGain(spaceDb(next.space)), when, SPACE_GLIDE);
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
