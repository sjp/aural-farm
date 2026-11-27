/**
 * Airplane Cabin: a window seat on a long night flight, lights dimmed, a jet
 * airliner at cruise. Four layers:
 *
 *   rumble:  the broad, enveloping roar of air over the fuselage and the
 *            engines through the floor, brown noise with a little pink,
 *            shaped like a cabin's noise; most of the sound
 *   engines: a faint buzz from the engines' fans, the two turning at very
 *            slightly different speeds so they beat slowly, "wah-wah", every
 *            two to four seconds, with the fan blades' faint whine above
 *   vent:    the overhead air nozzle's soft, close hiss
 *   chime:   optionally, once in a long while, a soft two-tone chime far up
 *            the cabin, sent to the shared hall reverb
 *
 * The seat moves the balance: at the front the airflow is brighter and the
 * engines quieter, at the rear the rumble darker and the engines louder.
 *
 * Everything seeded comes from one worklet (`airplane-dsp.ts`) and two native
 * oscillators, whose speeds come from the seed. They travel together through
 * a crossfader, so a seed change crossfades to the new variation. Each
 * engine's oscillator is phase-aligned to absolute time, and its pitch
 * wanders as phase modulation, through a delay line whose delay one of the
 * worklet's drifts moves: a frequency change would accumulate into the phase
 * from whenever rendering began, but a moving delay doesn't, so the output at
 * a given time depends only on that time, the seed and the params.
 */
import { createCrossfader } from "../../audio/crossfade";
import { glide } from "../../audio/glide";
import { createLfo } from "../../audio/lfo";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  AIRPLANE_CHANNELS,
  AIRPLANE_PROCESSOR,
  beatPeriod,
  CHIME,
  CHIME_RATES,
  engineGains,
  engineSpeeds,
  engineWave,
  RUMBLE_LEFT,
  RUMBLE_RIGHT,
  SEATS,
  WANDER_DELAY,
  WANDER_FIRST,
  WANDER_SECOND,
  WANDER_SWING,
} from "./airplane-dsp";
import { airplaneMeta } from "./airplane.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import airplaneWorkletUrl from "./airplane.worklet.ts?worker&url";

type AirplaneParams = ParamValues<typeof airplaneMeta.params>;

/** The chime's send to the hall reverb, in dB: far up the cabin. */
const CHIME_SEND_DB = -14;
/** Glide time constants, in seconds: levels, and a change of seat. */
const GAIN_GLIDE = 0.1;
const SEAT_GLIDE = 1;
/** A seed change's crossfade, in seconds. */
const FADE = 2;
/** What a variation sends on, channel by channel: each side, and the chime. */
const VARIATION_LEFT = 0;
const VARIATION_RIGHT = 1;
const VARIATION_CHIME = 2;
const VARIATION_CHANNELS = 3;

/** The worklet's params. */
const workletParams = (p: AirplaneParams) => ({
  lowpass: SEATS[p.seat].lowpass,
  vent: p.vent,
  chime: CHIME_RATES[p.chime],
});

interface Variation extends Disposable {
  update: (params: AirplaneParams, previous: AirplaneParams, when: number) => void;
}

/**
 * Builds the variation for `seed` into `into` (three channels: each side,
 * and the chime), at the params `params()` gives once its worklet has loaded,
 * and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => AirplaneParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, airplaneWorkletUrl, AIRPLANE_PROCESSOR, {
      channels: AIRPLANE_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    const param = (name: string) => source.parameters.get(name);
    const split = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: AIRPLANE_CHANNELS }));
    source.connect(split);
    const merge = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: VARIATION_CHANNELS }));
    split.connect(merge, RUMBLE_LEFT, VARIATION_LEFT);
    split.connect(merge, RUMBLE_RIGHT, VARIATION_RIGHT);
    split.connect(merge, CHIME, VARIATION_CHIME);
    merge.connect(into);

    // The engines: each an oscillator through its wandering delay line, into each side.
    const speeds = engineSpeeds(seed);
    const gains = engineGains(initial.engines, initial.seat);
    const engine = (frequency: number, withBlades: boolean, wander: number) => {
      const osc = createLfo(ctx, scope, {
        frequency,
        wave: engineWave(withBlades),
        startAt: absoluteNow(),
      });
      const delay = scope.add(
        new DelayNode(ctx, { maxDelayTime: 2 * WANDER_DELAY, delayTime: WANDER_DELAY }),
      );
      const depth = scope.add(new GainNode(ctx, { gain: WANDER_SWING }));
      split.connect(depth, wander).connect(delay.delayTime);
      osc.connect(delay);
      return delay;
    };
    const side = (from: AudioNode, gain: number, channel: number) => {
      const level = scope.add(new GainNode(ctx, { gain }));
      from.connect(level).connect(merge, 0, channel);
      return level;
    };
    const first = engine(speeds.first, true, WANDER_FIRST);
    const second = engine(speeds.second, false, WANDER_SECOND);
    const firstLeft = side(first, gains.firstLeft, VARIATION_LEFT);
    const firstRight = side(first, gains.firstRight, VARIATION_RIGHT);
    const secondLeft = side(second, gains.secondLeft, VARIATION_LEFT);
    const secondRight = side(second, gains.secondRight, VARIATION_RIGHT);

    const variation: Variation = {
      update(next, previous, when) {
        const values = workletParams(next);
        const seatChanged = next.seat !== previous.seat;
        const lowpass = param("lowpass");
        const vent = param("vent");
        if (lowpass) {
          glide(lowpass, values.lowpass, when, SEAT_GLIDE);
        }
        if (vent) {
          glide(vent, values.vent, when, GAIN_GLIDE);
        }
        // Chimes latch their rate as each block begins, so it needs no glide.
        param("chime")?.setValueAtTime(values.chime, when);
        const g = engineGains(next.engines, next.seat);
        const tau = seatChanged ? SEAT_GLIDE : GAIN_GLIDE;
        glide(firstLeft.gain, g.firstLeft, when, tau);
        glide(firstRight.gain, g.firstRight, when, tau);
        glide(secondLeft.gain, g.secondLeft, when, tau);
        glide(secondRight.gain, g.secondRight, when, tau);
      },
      dispose: () => {
        scope.dispose();
      },
    };
    // A change made while the worklet loaded.
    const p = params();
    if (p !== initial) {
      variation.update(p, initial, ctx.currentTime);
    }
    live.add(variation);
    scope.defer(() => {
      live.delete(variation);
    });
    return variation;
  }, onError);
}

export const airplane = defineSound(airplaneMeta, {
  // The engines beat steadily, at a period the seed sets; nothing else is rhythmic.
  loopPeriod: (params) => (params.engines > 0 ? beatPeriod(params.seed) : undefined),
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      const seeded = scope.add(
        new ChannelSplitterNode(ctx, { numberOfOutputs: VARIATION_CHANNELS }),
      );
      const fader = createCrossfader(ctx, scope, seeded, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      // The rumble, vent and engines on each side, and the chime in the middle,
      // with a send to the hall reverb.
      const mix = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      seeded.connect(mix, VARIATION_LEFT, 0);
      seeded.connect(mix, VARIATION_RIGHT, 1);
      mix.connect(out);
      const chime = scope.add(new GainNode(ctx));
      seeded.connect(chime, VARIATION_CHIME);
      chime.connect(out);
      createSend(ctx, scope, chime, out, "hall", CHIME_SEND_DB);

      return {
        update(next, when) {
          const previous = params;
          params = next;
          for (const v of live) {
            v.update(next, previous, when);
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
