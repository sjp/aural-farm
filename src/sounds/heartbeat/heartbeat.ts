/**
 * Heartbeat: a resting heart heard from inside, as in the womb, through warm
 * water. Each beat is a soft, low "lub-dub" over the whoosh of blood flow
 * that swells with it and eases between beats.
 *
 *   heart:  the beats and the flow, from one worklet (`heartbeat-dsp.ts`),
 *           mono, as the listener is inside the sound
 *   muffle: one low-pass over both, from close (1.6 kHz) to deep inside
 *           (320 Hz), and a faint send to the shared room reverb for body
 *
 * Each beat falls on `periodic.ts`'s grid of absolute time, so at steady
 * params a loop of whole beats joins seamlessly. A rate change applies from
 * the next beat; Flow and Muffle glide; a seed change crossfades the worklet
 * over 2 s.
 */
import { createCrossfader } from "../../audio/crossfade";
import { glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { beatPeriod, HEARTBEAT_CHANNELS, HEARTBEAT_PROCESSOR } from "./heartbeat-dsp";
import { heartbeatMeta } from "./heartbeat.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import heartbeatWorkletUrl from "./heartbeat.worklet.ts?worker&url";

type HeartbeatParams = ParamValues<typeof heartbeatMeta.params>;

/** The muffling low-pass's cutoff at Muffle `muffle` (0–100), in Hz: log-mapped from 1.6 kHz to 320 Hz. */
export function muffleCutoff(muffle: number): number {
  const m = Math.min(100, Math.max(0, muffle)) / 100;
  return MUFFLE_OPEN * (MUFFLE_CLOSED / MUFFLE_OPEN) ** m;
}
const MUFFLE_OPEN = 1600;
const MUFFLE_CLOSED = 320;
/** The low-pass's Q, 0.5, as the dB a BiquadFilterNode takes: soft, with no peak. */
const MUFFLE_Q = 20 * Math.log10(0.5);
/** Muffle's glide time constant, in seconds. */
const MUFFLE_GLIDE = 0.5;
/** The room reverb's send, in dB: a little body, no echo. */
const ROOM_SEND_DB = -26;
/** A seed change's crossfade, in seconds. */
const SEED_FADE = 2;

/** Sets the worklet's params from `when`: it latches the rate per beat and glides Flow. */
function setParams(source: AudioWorkletNode, p: HeartbeatParams, when: number): void {
  source.parameters.get("rate")?.setValueAtTime(p.rate, when);
  source.parameters.get("bed")?.setValueAtTime(p.bed, when);
}

export const heartbeat = defineSound(heartbeatMeta, {
  // One beat: each has a lub and a dub.
  loopPeriod: (params) => beatPeriod(params.rate),
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;

      const muffle = scope.add(
        new BiquadFilterNode(ctx, {
          type: "lowpass",
          frequency: muffleCutoff(params.muffle),
          Q: MUFFLE_Q,
        }),
      );
      muffle.connect(out);
      createSend(ctx, scope, muffle, out, "room", ROOM_SEND_DB);

      // The beats and flow, crossfading on a seed change.
      const live = new Set<AudioWorkletNode>();
      const variation = (seed: number) => (into: AudioNode) =>
        withAudioScope(async (heartScope) => {
          const initial = params;
          const source = await startProcessor(
            ctx,
            heartScope,
            heartbeatWorkletUrl,
            HEARTBEAT_PROCESSOR,
            {
              channels: HEARTBEAT_CHANNELS,
              startAt: absoluteNow(),
              processorOptions: { seed, rate: initial.rate },
              parameterData: { rate: initial.rate, bed: initial.bed },
            },
          );
          source.connect(into);
          // A change made while the worklet loaded.
          if (params !== initial) {
            setParams(source, params, ctx.currentTime);
          }
          live.add(source);
          heartScope.defer(() => {
            live.delete(source);
          });
          return {
            dispose: () => {
              heartScope.dispose();
            },
          };
        }, init.onError);
      const heart = createCrossfader(ctx, scope, muffle, SEED_FADE);
      let seed = init.seed;
      await heart.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
          glide(muffle.frequency, muffleCutoff(next.muffle), when, MUFFLE_GLIDE);
          for (const source of live) {
            setParams(source, next, when);
          }
          if (next.seed !== seed) {
            seed = next.seed;
            heart.swap(variation(seed)).catch((error: unknown) => {
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
