/**
 * Life Support: a space station's plant room heard from the corridor, an air
 * recycler working steadily and patiently. Four layers:
 *
 *   air:    a steady rush of air through ducts, pink noise between 120 Hz
 *           and 3.2 kHz with a broad lift of duct body around 600 Hz, its
 *           brightness and level drifting slowly
 *   pump:   every `pumpCycle` seconds a pump works through a cycle: a low
 *           motor tone at 74 Hz and a soft surge of moving fluid rise, hold,
 *           and fall away, the motor spinning up by 60 cents as it goes; a
 *           slow drift makes each cycle a little deeper or shallower
 *   valves: now and then a pressure valve releases, a soft hiss or a lower
 *           sigh that eases in and fades, from somewhere across the room,
 *           with a send to the shared metal reverb
 *   hum:    a faint electrical hum at 100 Hz, just under everything
 *
 * Everything seeded comes from one worklet (`life-support-dsp.ts`): the air,
 * the surge's noise, the valves and the pump's drift. Its channels travel
 * together through a crossfader, so a seed change crossfades to the new
 * variation while the native pump cycle, motor and hum play on untouched.
 *
 * The pump cycle is a native oscillator phase-aligned to absolute time, with
 * a custom wave of a smooth rise, hold, fall and rest; it sets the motor's
 * and the surge's levels. The motor's spin-up is phase modulation through a
 * delay line that follows the cycle's integral, rather than a change of its
 * frequency: a frequency change accumulates into the phase from whenever
 * rendering began, but a moving delay doesn't, so the output at a given time
 * depends only on that time, the seed and the params. A change of cycle
 * length glides both oscillators together, which leaves their phase off
 * absolute time until the next fresh render; at fixed params the cycle lands
 * on absolute time.
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
  humGain,
  humWave,
  LIFE_SUPPORT_CHANNELS,
  LIFE_SUPPORT_PROCESSOR,
  motorGain,
  motorWave,
  PUMP_DEPTH_SWING,
  PUMP_DRIFT,
  pumpIntegralWave,
  pumpShare,
  pumpWave,
  spinUp,
  SURGE,
  VALVE_RATES,
  VALVES_LEFT,
  VALVES_RIGHT,
} from "./life-support-dsp";
import { lifeSupportMeta } from "./life-support.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import lifeSupportWorkletUrl from "./life-support.worklet.ts?worker&url";

type LifeSupportParams = ParamValues<typeof lifeSupportMeta.params>;

/** The valves' send to the shared metal reverb, in dB. */
const VALVES_SEND_DB = -20;

/** Glide time constants, in seconds: levels, and the pump cycle's length. */
const GAIN_GLIDE = 0.15;
const CYCLE_GLIDE = 1;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

/** The worklet's params. */
const workletParams = (p: LifeSupportParams) => ({ flow: p.flow, rate: VALVE_RATES[p.valves] });

interface Variation extends Disposable {
  update: (params: LifeSupportParams, when: number) => void;
}

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => LifeSupportParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, lifeSupportWorkletUrl, LIFE_SUPPORT_PROCESSOR, {
      channels: LIFE_SUPPORT_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);
    const param = (name: string) => source.parameters.get(name);

    const variation: Variation = {
      update(next, when) {
        const values = workletParams(next);
        const flow = param("flow");
        if (flow) {
          glide(flow, values.flow, when, GAIN_GLIDE);
        }
        // Valves latch their rate each second, so it needs no glide.
        param("rate")?.setValueAtTime(values.rate, when);
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

export const lifeSupport = defineSound(lifeSupportMeta, {
  // The pump cycle repeats on absolute time; its depth drifts, but its timing doesn't.
  loopPeriod: (params) => (pumpShare(params.pump) > 0 ? params.pumpCycle : undefined),
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      const seeded = scope.add(
        new ChannelSplitterNode(ctx, { numberOfOutputs: LIFE_SUPPORT_CHANNELS }),
      );
      const fader = createCrossfader(ctx, scope, seeded, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));
      const stereo = (left: number, right: number) => {
        const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
        seeded.connect(merger, left, 0);
        seeded.connect(merger, right, 1);
        return merger;
      };

      // Air, and the valves with their send to the metal reverb.
      stereo(BED_LEFT, BED_RIGHT).connect(out);
      const valves = stereo(VALVES_LEFT, VALVES_RIGHT);
      valves.connect(out);
      createSend(ctx, scope, valves, out, "metal", VALVES_SEND_DB);

      // The pump cycle: its wave plus its mean spans 0..1, deepened or
      // shallowed by the drift.
      const start = absoluteNow();
      const pump = pumpWave();
      const cycle = createLfo(ctx, scope, {
        frequency: 1 / params.pumpCycle,
        wave: pump,
        startAt: start,
      });
      const mean = scope.addSource(new ConstantSourceNode(ctx, { offset: pump.offset }));
      mean.start(ctx.currentTime);
      const swing = scope.add(new GainNode(ctx, { gain: 1 }));
      cycle.connect(swing);
      mean.connect(swing);
      const swingDepth = scope.add(new GainNode(ctx, { gain: PUMP_DEPTH_SWING }));
      seeded.connect(swingDepth, PUMP_DRIFT).connect(swing.gain);

      // The surge: the worklet's noise, at the cycle's level.
      const surge = scope.add(new GainNode(ctx, { gain: 0 }));
      const surgeDepth = scope.add(new GainNode(ctx, { gain: pumpShare(params.pump) }));
      swing.connect(surgeDepth).connect(surge.gain);
      seeded.connect(surge, SURGE).connect(out);

      // The motor, spinning up through a delay that follows the cycle's integral.
      const spin = spinUp();
      const motor = createLfo(ctx, scope, {
        frequency: spin.frequency,
        wave: motorWave(),
        startAt: start,
      });
      const delay = scope.add(
        new DelayNode(ctx, { maxDelayTime: spin.longest, delayTime: spin.base }),
      );
      const integral = createLfo(ctx, scope, {
        frequency: 1 / params.pumpCycle,
        wave: pumpIntegralWave(),
        startAt: start,
      });
      const spinDepth = scope.add(new GainNode(ctx, { gain: spin.depth(params.pumpCycle) }));
      integral.connect(spinDepth).connect(delay.delayTime);
      const motorLevel = motorGain();
      const motorVca = scope.add(new GainNode(ctx, { gain: 0 }));
      const motorDepth = scope.add(
        new GainNode(ctx, { gain: pumpShare(params.pump) * motorLevel }),
      );
      swing.connect(motorDepth).connect(motorVca.gain);
      motor.connect(delay).connect(motorVca).connect(out);

      // The hum, centred.
      const hum = createLfo(ctx, scope, { frequency: HUM, wave: humWave(), startAt: start });
      const humLevel = scope.add(new GainNode(ctx, { gain: humGain(params.hum) }));
      hum.connect(humLevel).connect(out);

      return {
        update(next, when) {
          const previous = params;
          params = next;
          const share = pumpShare(next.pump);
          glide(surgeDepth.gain, share, when, GAIN_GLIDE);
          glide(motorDepth.gain, share * motorLevel, when, GAIN_GLIDE);
          glide(humLevel.gain, humGain(next.hum), when, GAIN_GLIDE);
          if (next.pumpCycle !== previous.pumpCycle) {
            // The cycle, its integral and the spin-up's depth glide together, so the spin-up holds.
            glide(cycle.frequency, 1 / next.pumpCycle, when, CYCLE_GLIDE);
            glide(integral.frequency, 1 / next.pumpCycle, when, CYCLE_GLIDE);
            glide(spinDepth.gain, spin.depth(next.pumpCycle), when, CYCLE_GLIDE);
          }
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
