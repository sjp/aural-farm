/**
 * Crew Quarters: a small starship cabin at night, lights down, heard from the
 * bunk, everything on the other side of a wall. Three layers:
 *
 *   ventilation: a low, soft rumble of brown noise from a vent, darker as
 *                Warmth rises, with a little band of body around 320 Hz
 *   engine:      a faint, deep hum at 36 Hz through the hull, rolled off
 *                steeply above 170 Hz, its level drifting by a decibel or so
 *                and its pitch by a cent or two
 *   hull:        three low, dull resonances of the structure, each swelling
 *                and fading on its own over minutes
 *
 * and the whole sent faintly to the shared room reverb. There are no events.
 *
 * Everything seeded comes from one worklet (`quarters-dsp.ts`): the
 * ventilation and hull, and the hum's drifts. Its channels travel together
 * through a crossfader, so a seed change crossfades to the new variation while
 * the hum plays on untouched (crossfading two copies of the same hum would
 * bump its level). The hum is one native oscillator, phase-aligned to
 * absolute time. Its pitch wanders as phase modulation, through a delay line
 * whose delay the drift moves, rather than by moving its frequency: a
 * frequency change accumulates into the phase from whenever rendering began,
 * but a moving delay doesn't, so the output at a given time depends only on
 * that time, the seed and the params.
 */
import { createCrossfader } from "../../audio/crossfade";
import { glide } from "../../audio/glide";
import { createLfo } from "../../audio/lfo";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  BED_LEFT,
  BED_RIGHT,
  HUM,
  HUM_LEVEL,
  HUM_WANDER,
  humGain,
  humWave,
  QUARTERS_CHANNELS,
  QUARTERS_PROCESSOR,
  WANDER_DELAY,
  WANDER_SWING,
} from "./quarters-dsp";
import { quartersMeta } from "./quarters.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import quartersWorkletUrl from "./quarters.worklet.ts?worker&url";

type QuartersParams = ParamValues<typeof quartersMeta.params>;

/** How far the drift moves the hum's level: ±0.19, about ±1.5 dB. */
const HUM_LEVEL_SWING = 0.19;
/** The room reverb send, in dB: a small, soft room, barely there. */
const ROOM_SEND_DB = -30;

/** Glide time constants, in seconds: levels, and Warmth. */
const GAIN_GLIDE = 0.15;
const WARMTH_GLIDE = 1;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

/** The worklet's params. */
const workletParams = (p: QuartersParams) => ({ air: p.air, hull: p.hull, warmth: p.warmth });

interface Variation extends Disposable {
  update: (params: QuartersParams, when: number) => void;
}

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => QuartersParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, quartersWorkletUrl, QUARTERS_PROCESSOR, {
      channels: QUARTERS_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);
    const param = (name: string) => source.parameters.get(name);

    const variation: Variation = {
      update(next, when) {
        const values = workletParams(next);
        const air = param("air");
        const hull = param("hull");
        const warmth = param("warmth");
        if (air) {
          glide(air, values.air, when, GAIN_GLIDE);
        }
        if (hull) {
          glide(hull, values.hull, when, GAIN_GLIDE);
        }
        if (warmth) {
          glide(warmth, values.warmth, when, WARMTH_GLIDE);
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

export const quarters = defineSound(quartersMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      const seeded = scope.add(
        new ChannelSplitterNode(ctx, { numberOfOutputs: QUARTERS_CHANNELS }),
      );
      const fader = createCrossfader(ctx, scope, seeded, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      // Everything meets here, on its way out and to the room reverb.
      const mix = scope.add(new GainNode(ctx));
      mix.connect(out);
      createSend(ctx, scope, mix, out, "room", ROOM_SEND_DB);

      // The ventilation and hull.
      const bed = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      seeded.connect(bed, BED_LEFT, 0);
      seeded.connect(bed, BED_RIGHT, 1);
      bed.connect(mix);

      // Engine: the hum, centred, its pitch wandering through a moving delay.
      const wave = humWave();
      const hum = createLfo(ctx, scope, { frequency: HUM, wave, startAt: absoluteNow() });
      const wander = scope.add(
        new DelayNode(ctx, { maxDelayTime: 3 * WANDER_DELAY, delayTime: WANDER_DELAY }),
      );
      const wanderDepth = scope.add(new GainNode(ctx, { gain: WANDER_SWING }));
      seeded.connect(wanderDepth, HUM_WANDER).connect(wander.delayTime);
      const humSwing = scope.add(new GainNode(ctx, { gain: 1 }));
      const humDepth = scope.add(new GainNode(ctx, { gain: HUM_LEVEL_SWING }));
      seeded.connect(humDepth, HUM_LEVEL).connect(humSwing.gain);
      const engine = scope.add(new GainNode(ctx, { gain: humGain(params.hum) }));
      hum.connect(wander).connect(humSwing).connect(engine).connect(mix);

      return {
        update(next, when) {
          params = next;
          glide(engine.gain, humGain(next.hum), when, GAIN_GLIDE);
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
