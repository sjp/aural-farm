/**
 * Fireplace: a wood fire in an open hearth, heard from an armchair across the
 * room.
 *
 *   roar:     the soft breathing of the flames and the draught: stereo brown
 *             noise above 60 Hz through a low-pass at 160–320 Hz, plus pink
 *             noise through a wide band at 550 Hz, 8 dB down. A lively drift
 *             flickers its level by ±3 dB, and a slow one moves the band by
 *             ±25 %. The fire's size sets its level and low-pass.
 *   events:   crackles in little clusters, the odd pop with a woody body, a
 *             few seconds of sap hiss now and then, and rarely a log settling
 *             with a soft thump and a rustle of crackles, from the fireplace
 *             worklet.
 *   room:     a gentle high shelf that dulls the fire as you sit further back,
 *             and a send to the shared room reverb that grows with it.
 *
 * One worklet makes the roar's noise (already flickering), the band's drift
 * and the events; the filters are native nodes. The seed picks a variation
 * (that worklet), and a change crossfades to a new one. The fire's size,
 * crackle and wood reach the worklet as AudioParams, and its events latch
 * them, so a change applies from the next event and needs no crossfade.
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type AudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  BAND_CHANNEL,
  BROWN_CHANNEL,
  EVENTS_CHANNEL,
  FIREPLACE_CHANNELS,
  FIREPLACE_PROCESSOR,
  PINK_CHANNEL,
  roarCutoff,
  roarDb,
  sendDb,
  shelfDb,
} from "./fireplace-dsp";
import { fireplaceMeta } from "./fireplace.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import fireplaceWorkletUrl from "./fireplace.worklet.ts?worker&url";

type FireplaceParams = ParamValues<typeof fireplaceMeta.params>;

/** The roar's level, from `roarDb`'s scale to about −23 LUFS with the events at defaults. */
const ROAR_TRIM_DB = -0.5;
/** The brown noise's high-pass, in Hz: it has most of its power below here. */
const ROAR_HIGHPASS = 60;
/** The roar's band: its centre (Hz), Q, and level against the low roar (dB). */
const BAND_CENTRE = 550;
const BAND_Q = 0.8;
const BAND_DB = -8;
/** The room's high shelf's corner, in Hz. */
const SHELF_FREQUENCY = 4000;

/** Size and room glide with this time constant, in seconds. */
const GLIDE = 0.5;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

interface Variation extends Disposable {
  update: (params: FireplaceParams, when: number) => void;
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

const roarGain = (p: FireplaceParams) => dbToGain(roarDb(p.size) + ROAR_TRIM_DB);

/** The worklet's params. */
const fireParams = (p: FireplaceParams) => ({
  size: p.size,
  crackle: p.crackle,
  softwood: p.wood === "softwood" ? 1 : 0,
});

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => FireplaceParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, fireplaceWorkletUrl, FIREPLACE_PROCESSOR, {
      channels: FIREPLACE_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: fireParams(initial),
    });
    const channels = scope.add(
      new ChannelSplitterNode(ctx, { numberOfOutputs: FIREPLACE_CHANNELS }),
    );
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

    // The roar: the brown noise's low end and the pink noise's band, at the
    // fire's level; the band's drift (in cents) moves its centre.
    const level = scope.add(new GainNode(ctx, { gain: roarGain(p) }));
    const highpass = scope.add(
      new BiquadFilterNode(ctx, { type: "highpass", frequency: ROAR_HIGHPASS, Q: BUTTERWORTH_Q }),
    );
    const lowpass = slowBiquad(ctx, scope, {
      type: "lowpass",
      frequency: roarCutoff(p.size),
      Q: BUTTERWORTH_Q,
    });
    stereo(BROWN_CHANNEL).connect(highpass).connect(lowpass).connect(level);
    const band = slowBiquad(ctx, scope, {
      type: "bandpass",
      frequency: BAND_CENTRE,
      Q: BAND_Q,
    });
    const bandLevel = scope.add(new GainNode(ctx, { gain: dbToGain(BAND_DB) }));
    stereo(PINK_CHANNEL).connect(band).connect(bandLevel).connect(level);
    channels.connect(band.detune, BAND_CHANNEL);
    level.connect(into);

    // The events, at the levels the worklet gives them.
    stereo(EVENTS_CHANNEL).connect(into);

    const variation: Variation = {
      update(next, when) {
        glide(level.gain, roarGain(next), when, GLIDE);
        glide(lowpass.frequency, roarCutoff(next.size), when, GLIDE);
        for (const [name, value] of Object.entries(fireParams(next))) {
          const param = source.parameters.get(name);
          if (param) {
            if (name === "softwood") {
              // Events latch the wood as they start, so it needs no glide.
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

export const fireplace = defineSound(fireplaceMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      // The variations meet here, then go through the room's shelf, with a
      // send to the room reverb.
      const bus = scope.add(new GainNode(ctx));
      const shelf = scope.add(
        new BiquadFilterNode(ctx, {
          type: "highshelf",
          frequency: SHELF_FREQUENCY,
          gain: shelfDb(params.room),
        }),
      );
      shelf.gain.automationRate = "k-rate";
      bus.connect(shelf).connect(out);
      const send = createSend(ctx, scope, shelf, out, "room", sendDb(params.room));

      const fader = createCrossfader(ctx, scope, bus, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
          glide(shelf.gain, shelfDb(next.room), when, GLIDE);
          glide(send.gain, dbToGain(sendDb(next.room)), when, GLIDE);
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
