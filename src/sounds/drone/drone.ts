/**
 * Drone Pad: a warm, open chord that glows for a minute or so, then dissolves
 * into another over tens of seconds, never a melody and with no beat.
 *
 * The voices, their crossfades and the filter all come from one worklet
 * (`drone-dsp.ts`) per key and seed, which goes on to the layer and to the
 * shared hall reverb. A change of key crossfades the whole pad over 4 s; a
 * seed change crossfades its worklet over 2 s. Brightness glides over a
 * second, Movement re-times the chord changes from the next one (sliding its
 * drift depth there), and Space glides.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { DRONE_CHANNELS, DRONE_PROCESSOR } from "./drone-dsp";
import { droneMeta, type DroneKey } from "./drone.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import droneWorkletUrl from "./drone.worklet.ts?worker&url";

type DroneParams = ParamValues<typeof droneMeta.params>;

/** The hall reverb's send at Space `space` (0–100), in dB: −18 to −2. */
export function spaceSendDb(space: number): number {
  return -18 + 0.16 * Math.min(100, Math.max(0, space));
}
/** Glide time constants, in seconds: Brightness, and Space. */
const BRIGHTNESS_GLIDE = 1;
const SPACE_GLIDE = 0.3;
/** Crossfades, in seconds: a change of key, and of seed. */
const KEY_FADE = 4;
const SEED_FADE = 2;

interface Graph extends Disposable {
  update: (params: DroneParams, previous: DroneParams, when: number) => void;
}

/** Every live graph's shared needs: the params now, absolute time, and error reporting. */
interface Context {
  ctx: BaseAudioContext;
  params: () => DroneParams;
  absoluteNow: () => number;
  onError: ((error: unknown) => void) | undefined;
}

/** Sets the worklet's params from `next`, gliding Brightness. */
function apply(node: AudioWorkletNode, next: DroneParams, previous: DroneParams, when: number) {
  const brightness = node.parameters.get("brightness");
  if (brightness && next.brightness !== previous.brightness) {
    glide(brightness, next.brightness, when, BRIGHTNESS_GLIDE);
  }
  if (next.movement !== previous.movement) {
    node.parameters.get("movement")?.setValueAtTime(next.movement, when);
  }
}

/**
 * Builds `key`'s pad for `seed` into `into`, at the params `c.params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  c: Context,
  into: AudioNode,
  key: DroneKey,
  seed: number,
  live: Set<Graph>,
): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const initial = c.params();
    const source = await startProcessor(c.ctx, scope, droneWorkletUrl, DRONE_PROCESSOR, {
      channels: DRONE_CHANNELS,
      startAt: c.absoluteNow(),
      processorOptions: { key, seed },
      parameterData: { brightness: initial.brightness, movement: initial.movement },
    });
    source.connect(into);

    const variation: Graph = {
      update(next, previous, when) {
        apply(source, next, previous, when);
      },
      dispose: () => {
        scope.dispose();
      },
    };
    // A change made while the worklet loaded.
    const p = c.params();
    if (p !== initial) {
      apply(source, p, initial, c.ctx.currentTime);
    }
    live.add(variation);
    scope.defer(() => {
      live.delete(variation);
    });
    return variation;
  }, c.onError);
}

/** Builds `key`'s pad into `into`, crossfading on a seed change, and adds it to `live`. */
function buildKey(c: Context, into: AudioNode, key: DroneKey, live: Set<Graph>): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const variations = new Set<Graph>();
    const fader = createCrossfader(c.ctx, scope, into, SEED_FADE);
    let seed = c.params().seed;
    const variation = (variationSeed: number) => (out: AudioNode) =>
      buildVariation(c, out, key, variationSeed, variations);
    await fader.swap(variation(seed));

    const pad: Graph = {
      update(next, previous, when) {
        for (const v of variations) {
          v.update(next, previous, when);
        }
        if (next.seed !== seed) {
          seed = next.seed;
          fader.swap(variation(seed)).catch((error: unknown) => {
            c.onError?.(error);
          });
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    live.add(pad);
    scope.defer(() => {
      live.delete(pad);
    });
    return pad;
  }, c.onError);
}

export const drone = defineSound(droneMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      let params = init.params;
      const c: Context = {
        ctx,
        params: () => params,
        absoluteNow: () => ctx.currentTime + offset,
        onError: init.onError,
      };
      const live = new Set<Graph>();

      const mix = scope.add(new GainNode(ctx));
      mix.connect(out);
      const send = createSend(ctx, scope, mix, out, "hall", spaceSendDb(params.space));

      const fader = createCrossfader(ctx, scope, mix, KEY_FADE);
      let key = params.key;
      const build = (k: DroneKey) => (into: AudioNode) => buildKey(c, into, k, live);
      await fader.swap(build(key));

      return {
        update(next, when) {
          const previous = params;
          params = next;
          if (next.space !== previous.space) {
            glide(send.gain, dbToGain(spaceSendDb(next.space)), when, SPACE_GLIDE);
          }
          for (const g of live) {
            g.update(next, previous, when);
          }
          if (next.key !== key) {
            key = next.key;
            fader.swap(build(key)).catch((error: unknown) => {
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
