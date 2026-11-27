/**
 * Night Insects: a warm summer night outdoors.
 *
 *   crickets: up to twelve, each at its own distance and place around the
 *             listener, with its own pitch and pace, chirping in bouts with
 *             pauses between; warmer nights chirp faster (Dolbear's law)
 *   katydids: optionally, a few far-off rasping insects
 *   chorus:   a faint shimmer of countless far-off insects, throbbing at
 *             about the crickets' pulse rate, over a faint low bed of night air
 *
 * One worklet makes it all (`insects-dsp.ts`); a native low-pass at 7 kHz
 * keeps the highs comfortable for hours, with a send to the shared outdoor
 * reverb. The seed picks a variation (that worklet), and a change crossfades
 * to a new one. The count, warmth, distance and the katydids' level reach the
 * worklet as AudioParams: each chirp latches the warmth and distance as it
 * starts, so a change applies from the next chirp.
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { INSECTS_CHANNELS, INSECTS_PROCESSOR, sendDb } from "./insects-dsp";
import { insectsMeta } from "./insects.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import insectsWorkletUrl from "./insects.worklet.ts?worker&url";

type InsectsParams = ParamValues<typeof insectsMeta.params>;

/** The comfort low-pass over everything, in Hz (12 dB per octave). */
const COMFORT_CUTOFF = 7000;
/** The distance glides with this time constant, in seconds. */
const DISTANCE_GLIDE = 0.8;
/** The katydids fade in or out over about a second: three of these time constants. */
const KATYDID_GLIDE = 0.33;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

interface Variation extends Disposable {
  update: (params: InsectsParams, when: number) => void;
}

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => InsectsParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, insectsWorkletUrl, INSECTS_PROCESSOR, {
      channels: INSECTS_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed, warmth: initial.warmth },
      parameterData: {
        count: initial.count,
        warmth: initial.warmth,
        distance: initial.distance,
        katydids: initial.katydids ? 1 : 0,
      },
    });
    source.connect(into);
    const param = (name: string) => source.parameters.get(name);

    const variation: Variation = {
      update(next, when) {
        // Chirps latch the count and warmth, so they need no glide.
        param("count")?.setValueAtTime(next.count, when);
        param("warmth")?.setValueAtTime(next.warmth, when);
        const distance = param("distance");
        if (distance) {
          glide(distance, next.distance, when, DISTANCE_GLIDE);
        }
        const katydids = param("katydids");
        if (katydids) {
          glide(katydids, next.katydids ? 1 : 0, when, KATYDID_GLIDE);
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

export const insects = defineSound(insectsMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      // The variations meet here, then go through the comfort low-pass, with
      // a send to the outdoor reverb.
      const bus = scope.add(new GainNode(ctx));
      const lowpass = scope.add(
        new BiquadFilterNode(ctx, {
          type: "lowpass",
          frequency: COMFORT_CUTOFF,
          Q: BUTTERWORTH_Q,
        }),
      );
      bus.connect(lowpass).connect(out);
      const send = createSend(ctx, scope, lowpass, out, "outdoor", sendDb(params.distance));

      const fader = createCrossfader(ctx, scope, bus, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
          glide(send.gain, dbToGain(sendDb(next.distance)), when, DISTANCE_GLIDE);
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
