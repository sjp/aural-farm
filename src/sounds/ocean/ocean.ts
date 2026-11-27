/**
 * Ocean Waves: waves breaking on a shore, heard from a little way up the beach.
 * Each wave swells, breaks, foams and drains back, and no two are quite alike.
 *
 *   bed:       stereo brown noise above 60 Hz, through a low-pass at 180 Hz,
 *              at −18 dB between waves. The swell raises its level and opens
 *              it a little, and the crash opens it wide (1.5–3.5 kHz by size)
 *              at full level: a dull roar turning bright as the wave tips
 *              over. The low-pass has a gentle bump at its cutoff, so the
 *              swell's rumble still reads on small speakers.
 *   foam:      stereo pink noise under each wave's foam envelope, panned by
 *              the wave, through 900 Hz–6.5 kHz; a drift churns the low-pass.
 *   backwash:  the same pink noise under the backwash's envelope, through a
 *              band at 2.5 kHz that falls 20 % as the water recedes, joining
 *              the foam. On pebbles a soft rattle drains with it.
 *
 * The ocean worklet makes the noise and applies everything that follows each
 * wave: the bed's level, the foam's and the backwash's envelopes, the
 * backwash's band, and the bed's low-pass cutoff, which it outputs as a control.
 * The fixed filters are native nodes.
 * Size and distance reach the worklet as AudioParams, so they glide. The
 * wave schedule runs on absolute time in the worklet, so nothing is scheduled
 * from the main thread. Distance dulls and lowers the crash and foam, leaving
 * the bed relatively louder, and raises a send to the shared outdoor reverb.
 *
 * The seed and the shore pick a variation (the worklet), and a change to
 * either crossfades to a new one; a shore change keeps the seed, so the same
 * waves carry on through it.
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type AudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  BED_CHANNEL,
  CHURN_CHANNEL,
  CUTOFF_CHANNEL,
  foamCutoff,
  foamLevel,
  OCEAN_CHANNELS,
  OCEAN_PROCESSOR,
  outputDb,
  sendDb,
  WATER_CHANNEL,
} from "./ocean-dsp";
import { oceanMeta, type OceanShore } from "./ocean.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import oceanWorkletUrl from "./ocean.worklet.ts?worker&url";

type OceanParams = ParamValues<typeof oceanMeta.params>;

/** The bed's high-pass, in Hz: brown noise has most of its power below here. */
const BED_HIGHPASS = 60;
/**
 * The bed's low-pass Q: a bump of about 3 dB at the cutoff, which gives the
 * swell's rumble some body in the 200–700 Hz that small speakers can play.
 */
const BED_Q = 1.2;
/** The water's high-pass, in Hz. */
const WATER_HIGHPASS = 900;

/** The whole sound's level, to about −23 LUFS at defaults (−23 to −24 across seeds). */
const OUTPUT_TRIM_DB = 0.8;
/** Size and distance glide with this time constant, in seconds. */
const GLIDE = 0.8;
/** A seed or shore change's crossfade, in seconds. */
const FADE = 2;

interface Variation extends Disposable {
  update: (params: OceanParams, when: number) => void;
}

/** A filter whose params move slowly, so it updates its coefficients once per render quantum. */
function slowBiquad(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: BiquadFilterOptions,
): BiquadFilterNode {
  const filter = scope.add(new BiquadFilterNode(ctx, options));
  filter.frequency.automationRate = "k-rate";
  filter.detune.automationRate = "k-rate";
  return filter;
}

/** The worklet's params: the wave period, size and distance. */
const shape = (p: OceanParams) => ({ period: p.period, size: p.size, distance: p.distance });

/**
 * Builds the variation for `seed` and `shore` into `into`, at the params
 * `params()` gives once its worklet has loaded, and adds it to `live` until it
 * is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  shore: OceanShore,
  params: () => OceanParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, oceanWorkletUrl, OCEAN_PROCESSOR, {
      channels: OCEAN_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed, shore, period: initial.period },
      parameterData: shape(initial),
    });
    const channels = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: OCEAN_CHANNELS }));
    source.connect(channels);
    const stereo = (first: number) => {
      const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      channels.connect(merger, first, 0);
      channels.connect(merger, first + 1, 1);
      return merger;
    };
    // Built after the await, so a change made meanwhile is already in (and
    // passed on to the worklet below).
    const p = params();

    // Bed: brown noise above 60 Hz, at the level the worklet gives it, through
    // the low-pass the worklet's cutoff (in Hz) opens.
    const bedHighpass = scope.add(
      new BiquadFilterNode(ctx, { type: "highpass", frequency: BED_HIGHPASS, Q: BUTTERWORTH_Q }),
    );
    const bedLowpass = slowBiquad(ctx, scope, { type: "lowpass", frequency: 0, Q: BED_Q });
    stereo(BED_CHANNEL).connect(bedHighpass).connect(bedLowpass).connect(into);
    channels.connect(bedLowpass.frequency, CUTOFF_CHANNEL);

    // The water (foam and backwash): already under its envelopes; churned by
    // the drift (in cents) on its low-pass.
    const foamHighpass = scope.add(
      new BiquadFilterNode(ctx, { type: "highpass", frequency: WATER_HIGHPASS, Q: BUTTERWORTH_Q }),
    );
    const foamLowpass = slowBiquad(ctx, scope, {
      type: "lowpass",
      frequency: foamCutoff(p.distance),
      Q: BUTTERWORTH_Q,
    });
    const foam = scope.add(new GainNode(ctx, { gain: foamLevel(p.size, p.distance) }));
    stereo(WATER_CHANNEL).connect(foamHighpass).connect(foamLowpass).connect(foam).connect(into);
    channels.connect(foamLowpass.detune, CHURN_CHANNEL);

    const variation: Variation = {
      update(next, when) {
        glide(foam.gain, foamLevel(next.size, next.distance), when, GLIDE);
        glide(foamLowpass.frequency, foamCutoff(next.distance), when, GLIDE);
        for (const [name, value] of Object.entries(shape(next))) {
          const param = source.parameters.get(name);
          if (param) {
            if (name === "period") {
              // The schedule takes a new period from the next wave on, so it needs no glide.
              param.setValueAtTime(value, when);
            } else {
              glide(param, value, when, GLIDE);
            }
          }
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
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

export const ocean = defineSound(oceanMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      let shore = params.shore;
      const live = new Set<Variation>();

      // The variations meet here, with a send to the outdoor reverb.
      const busGain = (p: OceanParams) => dbToGain(OUTPUT_TRIM_DB + outputDb(p.size, p.distance));
      const bus = scope.add(new GainNode(ctx, { gain: busGain(params) }));
      bus.connect(out);
      const send = createSend(ctx, scope, bus, out, "outdoor", sendDb(params.distance));

      const fader = createCrossfader(ctx, scope, bus, FADE);
      const variation = (variationSeed: number, variationShore: OceanShore) => (into: AudioNode) =>
        buildVariation(
          ctx,
          into,
          variationSeed,
          variationShore,
          () => params,
          absoluteNow,
          live,
          init.onError,
        );
      await fader.swap(variation(seed, shore));

      return {
        update(next, when) {
          params = next;
          glide(bus.gain, busGain(next), when, GLIDE);
          glide(send.gain, dbToGain(sendDb(next.distance)), when, GLIDE);
          for (const v of live) {
            v.update(next, when);
          }
          if (next.seed !== seed || next.shore !== shore) {
            seed = next.seed;
            shore = next.shore;
            fader.swap(variation(seed, shore)).catch((error: unknown) => {
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
