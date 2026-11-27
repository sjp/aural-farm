/**
 * Singing Bowls: metal standing bowls in a quiet room, struck softly every so
 * often, each tone blooming and hanging in the air for half a minute, wavering
 * slowly as its split partials beat; optionally one bowl rubbed around its rim,
 * singing underneath.
 *
 * The strikes, the bowls and the rim singing all come from one worklet
 * (`bowls-dsp.ts`) per key and seed, which goes on to the layer and to the
 * shared room reverb. A change of key crossfades the set over 3 s, slowly
 * because of the long tails (each set keeping its own strikes); a seed change
 * crossfades its worklet over 2 s. Bowls latches per strike, Strike every
 * re-anchors at the next strike, Rim singing fades over 4 s in the kernel, and
 * Space glides.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { BOWLS_CHANNELS, BOWLS_PROCESSOR } from "./bowls-dsp";
import { bowlsMeta, type BowlKey } from "./bowls.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import bowlsWorkletUrl from "./bowls.worklet.ts?worker&url";

type BowlsParams = ParamValues<typeof bowlsMeta.params>;

/** The room reverb's send at Space `space` (0–100), in dB: −14 to −3. */
export function spaceSendDb(space: number): number {
  return -14 + 0.11 * Math.min(100, Math.max(0, space));
}
/** Space's glide time constant, in seconds. */
const SPACE_GLIDE = 0.3;
/** Crossfades, in seconds: a change of key (slow, for the long tails), and of seed. */
const KEY_FADE = 3;
const SEED_FADE = 2;

/** The worklet's params. */
const workletParams = (p: BowlsParams) => ({
  bowls: p.bowls,
  interval: p.interval,
  rub: p.rub ? 1 : 0,
});

interface Graph extends Disposable {
  update: (params: BowlsParams, when: number) => void;
}

/** Every live graph's shared needs: the params now, absolute time, and error reporting. */
interface Context {
  ctx: BaseAudioContext;
  params: () => BowlsParams;
  absoluteNow: () => number;
  onError: ((error: unknown) => void) | undefined;
}

/**
 * Builds `key`'s set for `seed` into `into`, at the params `c.params()`
 * gives once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  c: Context,
  into: AudioNode,
  key: BowlKey,
  seed: number,
  live: Set<Graph>,
): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const initial = c.params();
    const source = await startProcessor(c.ctx, scope, bowlsWorkletUrl, BOWLS_PROCESSOR, {
      channels: BOWLS_CHANNELS,
      startAt: c.absoluteNow(),
      processorOptions: { key, seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);

    const variation: Graph = {
      update(next, when) {
        // The kernel latches each where it belongs: per strike, or by fading.
        for (const [name, value] of Object.entries(workletParams(next))) {
          source.parameters.get(name)?.setValueAtTime(value, when);
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    // A change made while the worklet loaded.
    const p = c.params();
    if (p !== initial) {
      variation.update(p, c.ctx.currentTime);
    }
    live.add(variation);
    scope.defer(() => {
      live.delete(variation);
    });
    return variation;
  }, c.onError);
}

/** Builds `key`'s set into `into`, crossfading on a seed change, and adds it to `live`. */
function buildKey(c: Context, into: AudioNode, key: BowlKey, live: Set<Graph>): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const variations = new Set<Graph>();
    const fader = createCrossfader(c.ctx, scope, into, SEED_FADE);
    let seed = c.params().seed;
    const variation = (variationSeed: number) => (out: AudioNode) =>
      buildVariation(c, out, key, variationSeed, variations);
    await fader.swap(variation(seed));

    const set: Graph = {
      update(next, when) {
        for (const v of variations) {
          v.update(next, when);
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
    live.add(set);
    scope.defer(() => {
      live.delete(set);
    });
    return set;
  }, c.onError);
}

export const bowls = defineSound(bowlsMeta, {
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
      const send = createSend(ctx, scope, mix, out, "room", spaceSendDb(params.space));

      const fader = createCrossfader(ctx, scope, mix, KEY_FADE);
      let key = params.root;
      const build = (k: BowlKey) => (into: AudioNode) => buildKey(c, into, k, live);
      await fader.swap(build(key));

      return {
        update(next, when) {
          const previous = params;
          params = next;
          if (next.space !== previous.space) {
            glide(send.gain, dbToGain(spaceSendDb(next.space)), when, SPACE_GLIDE);
          }
          for (const g of live) {
            g.update(next, when);
          }
          if (next.root !== key) {
            key = next.root;
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
