/**
 * Stream: running water over stones, heard from the bank.
 *
 *   babble:   many small air bubbles, each ringing briefly at a pitch set by
 *             its size and rising as it floats up, in clusters where the water
 *             tumbles over a stone, each cluster at its own place in the
 *             stereo field, from the stream worklet
 *   rush:     a soft bed for the flow too dense to hear as bubbles: stereo
 *             pink noise through a wide band at 1.2 kHz (a brook) to 500 Hz (a
 *             river), and brown noise between 60 and 300 Hz, up to 8 dB louder
 *             for a river; a slow drift swells and eases it by ±2 dB
 *
 * Size moves from a small brook (small, high bubbles over a faint rush) to a
 * broad river (larger, lower bubbles almost lost in a deep, full rush); flow
 * sets how much water is moving, and surges a little on its own. Distance
 * fades the babble into the rush, closes a low-pass over everything and
 * raises a send to the shared outdoor reverb.
 *
 * One worklet makes the rush's noise (already swelling) and the bubbles; the
 * filters are native nodes. The seed picks a variation (that worklet), and a
 * change crossfades to a new one. Flow, size and the bubbles' level reach the
 * worklet as AudioParams, and its bubbles latch them, so a change applies from
 * the next bubble and needs no crossfade.
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type AudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  BROWN_CHANNEL,
  BUBBLES_CHANNEL,
  outputCutoff,
  PINK_CHANNEL,
  rushCentre,
  sendDb,
  STREAM_CHANNELS,
  STREAM_PROCESSOR,
  streamLevels,
} from "./stream-dsp";
import { streamMeta } from "./stream.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import streamWorkletUrl from "./stream.worklet.ts?worker&url";

type StreamParams = ParamValues<typeof streamMeta.params>;

/** The rush's pink band's Q. */
const RUSH_Q = 0.6;
/** The rush's brown noise lies between these, in Hz. */
const BROWN_HIGHPASS = 60;
const BROWN_LOWPASS = 300;

/** Flow, size and distance glide with this time constant, in seconds. */
const GLIDE = 0.8;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

interface Variation extends Disposable {
  update: (params: StreamParams, when: number) => void;
}

/** A filter whose params move slowly, so it updates its coefficients once per render quantum. */
function slowBiquad(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: BiquadFilterOptions,
): BiquadFilterNode {
  const filter = scope.add(new BiquadFilterNode(ctx, options));
  filter.frequency.automationRate = "k-rate";
  return filter;
}

const levels = (p: StreamParams) => streamLevels(p.flow, p.size, p.distance);

/** The worklet's params. */
const bubbleParams = (p: StreamParams) => ({
  flow: p.flow,
  size: p.size,
  level: levels(p).bubbles,
});

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => StreamParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, streamWorkletUrl, STREAM_PROCESSOR, {
      channels: STREAM_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: bubbleParams(initial),
    });
    const channels = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: STREAM_CHANNELS }));
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
    const level = levels(p);

    // The rush: the pink noise's band, and the brown noise's low end.
    const band = slowBiquad(ctx, scope, {
      type: "bandpass",
      frequency: rushCentre(p.size),
      Q: RUSH_Q,
    });
    const pink = scope.add(new GainNode(ctx, { gain: level.pink }));
    pink.gain.automationRate = "k-rate";
    stereo(PINK_CHANNEL).connect(band).connect(pink).connect(into);
    const brown = scope.add(new GainNode(ctx, { gain: level.brown }));
    brown.gain.automationRate = "k-rate";
    const highpass = scope.add(
      new BiquadFilterNode(ctx, { type: "highpass", frequency: BROWN_HIGHPASS, Q: BUTTERWORTH_Q }),
    );
    const lowpass = scope.add(
      new BiquadFilterNode(ctx, { type: "lowpass", frequency: BROWN_LOWPASS, Q: BUTTERWORTH_Q }),
    );
    stereo(BROWN_CHANNEL).connect(brown).connect(highpass).connect(lowpass).connect(into);

    // The bubbles, at the level the worklet gives them.
    stereo(BUBBLES_CHANNEL).connect(into);

    const variation: Variation = {
      update(next, when) {
        const target = levels(next);
        glide(band.frequency, rushCentre(next.size), when, GLIDE);
        glide(pink.gain, target.pink, when, GLIDE);
        glide(brown.gain, target.brown, when, GLIDE);
        for (const [name, value] of Object.entries(bubbleParams(next))) {
          const param = source.parameters.get(name);
          if (param) {
            glide(param, value, when, GLIDE);
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

export const stream = defineSound(streamMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      // The variations meet here, then go through the distance's low-pass,
      // with a send to the outdoor reverb.
      const bus = scope.add(new GainNode(ctx));
      const lowpass = slowBiquad(ctx, scope, {
        type: "lowpass",
        frequency: outputCutoff(params.distance),
        Q: BUTTERWORTH_Q,
      });
      bus.connect(lowpass).connect(out);
      const send = createSend(ctx, scope, lowpass, out, "outdoor", sendDb(params.distance));

      const fader = createCrossfader(ctx, scope, bus, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
          glide(lowpass.frequency, outputCutoff(next.distance), when, GLIDE);
          glide(send.gain, dbToGain(sendDb(next.distance)), when, GLIDE);
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
