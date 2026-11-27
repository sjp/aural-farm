/**
 * Rain: steady rain heard from under cover, in three layers.
 *
 *   wash:    stereo pink noise, high-passed at 250 Hz and low-passed at a cutoff
 *            that rises with intensity and falls with distance, plus the same
 *            noise below 350 Hz for the weight of heavy rain; two slow drifts
 *            thicken and ease it (level and cutoff)
 *   drops:   single nearer drops on top, each a short tick of band-passed noise
 *            coloured by the surface, from the rain worklet
 *   plinks:  some drops trap a bubble that rings with a rising pitch (the
 *            worklet's bubble voices), the "plip" of rain on puddles
 *
 * The drops pass through a low-pass that closes with distance (in the worklet,
 * as the wash has its own), and everything has a send to the shared outdoor
 * reverb that grows with it.
 *
 * One worklet makes the wash's noise and drifts and the drops. The seed and the
 * surface pick a variation: that worklet and the wash's surface shaping. A
 * change to either crossfades to a new variation. A surface change keeps the
 * seed, so the same drops land on the new surface through the crossfade.
 *
 * Heavy rain's weight is the wash's own noise low-passed, rather than a second
 * (brown) noise: below 350 Hz the two sound alike under the wash, and one noise
 * source costs less.
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type AudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  DRIFT_CHANNEL,
  dropRate,
  DROPS_CHANNEL,
  NOISE_CHANNEL,
  RAIN_CHANNELS,
  dropsDb,
  outputCutoff,
  RAIN_PROCESSOR,
  sendDb,
  SHELF_FREQUENCY,
  SURFACES,
  washCutoff,
  washDb,
  weightLevel,
} from "./rain-dsp";
import { rainMeta, type RainSurface } from "./rain.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import rainWorkletUrl from "./rain.worklet.ts?worker&url";

type RainParams = ParamValues<typeof rainMeta.params>;

/** The wash's level, from `washDb`'s scale to about −23 LUFS with the drops at defaults. */
const WASH_TRIM_DB = 14;
/** The wash's high-pass, and the top of heavy rain's weight, in Hz. */
const WASH_HIGHPASS = 250;
const WEIGHT_LOWPASS = 350;

/**
 * How far the wash's drifts (from the worklet) move it: the main one its level
 * by about ±2 dB and its cutoff by ±10 % (±165 cents); the slower one its level
 * by ±1.5 dB.
 */
const SWELL = [dbToGain(2) - 1, dbToGain(1.5) - 1] as const;
const CUTOFF_SWING_CENTS = 1200 * Math.log2(1.1);

/** Glide time constants, in seconds: levels, filters and rate; the plink chance. */
const GLIDE = 0.5;
const BUBBLES_GLIDE = 0.1;
/** A seed or surface change's crossfade, in seconds. */
const FADE = 2;

interface Variation extends Disposable {
  update: (params: RainParams, when: number) => void;
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

const washGain = (params: RainParams, surface: RainSurface) =>
  dbToGain(washDb(params.intensity) + SURFACES[surface].washDb + WASH_TRIM_DB);

const weightGain = (params: RainParams, surface: RainSurface) =>
  weightLevel(params.intensity) * dbToGain(SURFACES[surface].weightDb);

/** The worklet's params: drops per second, plink chance, the drops' level and low-pass. */
const dropParams = (params: RainParams) => ({
  rate: dropRate(params.intensity, params.distance),
  bubbles: params.bubbles / 100,
  level: dbToGain(dropsDb(params.distance)),
  cutoff: outputCutoff(params.distance),
});

/**
 * Builds the variation for `seed` and `surface` into `into`, at the params
 * `params()` gives once its worklet has loaded, and adds it to `live` until it
 * is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  surface: RainSurface,
  params: () => RainParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const profile = SURFACES[surface];
    const initial = params();
    const source = await startProcessor(ctx, scope, rainWorkletUrl, RAIN_PROCESSOR, {
      channels: RAIN_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed, surface },
      parameterData: dropParams(initial),
    });
    const channels = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: RAIN_CHANNELS }));
    source.connect(channels);
    const stereo = (first: number) => {
      const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      channels.connect(merger, first, 0);
      channels.connect(merger, first + 1, 1);
      return merger;
    };
    const noise = stereo(NOISE_CHANNEL);
    const drops = stereo(DROPS_CHANNEL);
    // Built after the await, so a change made meanwhile is already in (and
    // passed on to the worklet below).
    const p = params();

    // Wash: the noise above 250 Hz, plus its band below 350 Hz for heavy rain's
    // weight, through the cutoff. The weight's gain comes first, so at 0 it
    // passes silence on and its filter does no work.
    const highpass = scope.add(
      new BiquadFilterNode(ctx, { type: "highpass", frequency: WASH_HIGHPASS, Q: BUTTERWORTH_Q }),
    );
    const weight = scope.add(new GainNode(ctx, { gain: weightGain(p, surface) }));
    const weightBand = scope.add(
      new BiquadFilterNode(ctx, { type: "lowpass", frequency: WEIGHT_LOWPASS, Q: BUTTERWORTH_Q }),
    );
    const cutoff = slowBiquad(ctx, scope, {
      type: "lowpass",
      frequency: washCutoff(p.intensity, p.distance, profile),
      Q: BUTTERWORTH_Q,
    });
    noise.connect(highpass).connect(cutoff);
    noise.connect(weight).connect(weightBand).connect(cutoff);

    // The wash's level, which the drifts swell by a share of it, and its cutoff, which they move.
    const level = scope.add(new GainNode(ctx, { gain: washGain(p, surface) }));
    level.gain.automationRate = "k-rate";
    cutoff.connect(level);
    const swells = SWELL.map((depth, i) => {
      const swell = scope.add(new GainNode(ctx, { gain: depth * washGain(p, surface) }));
      channels.connect(swell, DRIFT_CHANNEL + i).connect(level.gain);
      return swell;
    });
    channels
      .connect(scope.add(new GainNode(ctx, { gain: CUTOFF_SWING_CENTS })), DRIFT_CHANNEL)
      .connect(cutoff.detune);

    // The drops join the wash, through the surface's shelf if it has one.
    if (profile.shelfDb === 0) {
      level.connect(into);
      drops.connect(into);
    } else {
      const shelf = scope.add(
        new BiquadFilterNode(ctx, {
          type: "highshelf",
          frequency: SHELF_FREQUENCY,
          gain: profile.shelfDb,
        }),
      );
      level.connect(shelf);
      drops.connect(shelf);
      shelf.connect(into);
    }

    const variation: Variation = {
      update(next, when) {
        const wash = washGain(next, surface);
        glide(cutoff.frequency, washCutoff(next.intensity, next.distance, profile), when, GLIDE);
        glide(level.gain, wash, when, GLIDE);
        swells.forEach((swell, i) => {
          glide(swell.gain, (SWELL[i] ?? 0) * wash, when, GLIDE);
        });
        glide(weight.gain, weightGain(next, surface), when, GLIDE);
        const target = dropParams(next);
        for (const [name, value] of Object.entries(target)) {
          const param = source.parameters.get(name);
          if (param) {
            glide(param, value, when, name === "bubbles" ? BUBBLES_GLIDE : GLIDE);
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

export const rain = defineSound(rainMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      let surface = params.surface;
      const live = new Set<Variation>();

      // The variations meet here, with a send to the outdoor reverb.
      const bus = scope.add(new GainNode(ctx));
      bus.connect(out);
      const send = createSend(ctx, scope, bus, out, "outdoor", sendDb(params.distance));

      const fader = createCrossfader(ctx, scope, bus, FADE);
      const variation =
        (variationSeed: number, variationSurface: RainSurface) => (into: AudioNode) =>
          buildVariation(
            ctx,
            into,
            variationSeed,
            variationSurface,
            () => params,
            absoluteNow,
            live,
            init.onError,
          );
      await fader.swap(variation(seed, surface));

      return {
        update(next, when) {
          params = next;
          glide(send.gain, dbToGain(sendDb(next.distance)), when, GLIDE);
          for (const v of live) {
            v.update(next, when);
          }
          if (next.seed !== seed || next.surface !== surface) {
            seed = next.seed;
            surface = next.surface;
            fader.swap(variation(seed, surface)).catch((error: unknown) => {
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
