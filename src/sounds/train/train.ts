/**
 * Train Carriage: a seat in the middle of a carriage at night, the train
 * running steadily. Four layers, all from one worklet (`train-dsp.ts`):
 *
 *   rumble: the deep body of the carriage, wheels on rail and the floor's
 *           resonance, with the roar of the wheels above it, louder and
 *           higher the faster the train goes
 *   clacks: at each rail joint the four axles cross in two pairs, a quick
 *           "da-dum" from the near bogie, then the same, quieter and duller,
 *           from the far one; on welded track only a soft thump now and then
 *   points: now and then a short, irregular rattle over points
 *   sway:   the carriage leans and settles, moving the rumble's tone, the
 *           balance and the level a little
 *
 * The clacks come from the train's position along a seeded track, so at
 * steady params they fall on absolute time and a loop of whole joint
 * periods joins seamlessly. The kernel glides a change of speed and moves
 * the train's course to keep its position unbroken, so the rhythm speeds up
 * or slows down without a joint skipped, doubled or moved; it crossfades the
 * track itself, over 1.5 s. A seed change crossfades the worklet over 2 s.
 * Everything goes to the shared room reverb, faintly.
 */
import { createCrossfader } from "../../audio/crossfade";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  jointPeriod,
  POINTS_RATES,
  TRACK_VALUES,
  TRAIN_CHANNELS,
  TRAIN_PROCESSOR,
} from "./train-dsp";
import { trainMeta } from "./train.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import trainWorkletUrl from "./train.worklet.ts?worker&url";

type TrainParams = ParamValues<typeof trainMeta.params>;

/** The send to the room reverb, in dB: a carriage is a small, soft room. */
const ROOM_SEND_DB = -24;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

/** The worklet's params. The kernel glides the speed and crossfades the track; the rest latch. */
const workletParams = (p: TrainParams) => ({
  speed: p.speed,
  track: TRACK_VALUES[p.track],
  clacks: p.clacks,
  points: POINTS_RATES[p.points],
});

interface Variation extends Disposable {
  update: (params: TrainParams, when: number) => void;
}

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => TrainParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, trainWorkletUrl, TRAIN_PROCESSOR, {
      channels: TRAIN_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);

    const variation: Variation = {
      update(next, when) {
        const values = workletParams(next);
        for (const [name, value] of Object.entries(values)) {
          source.parameters.get(name)?.setValueAtTime(value, when);
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

export const train = defineSound(trainMeta, {
  // The joints' rhythm repeats every rail length; welded track, or no clacks, has none.
  loopPeriod: (params) =>
    params.track === "jointed" && params.clacks > 0 ? jointPeriod(params.speed) : undefined,
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      const mix = scope.add(new GainNode(ctx));
      mix.connect(out);
      createSend(ctx, scope, mix, out, "room", ROOM_SEND_DB);
      const fader = createCrossfader(ctx, scope, mix, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));

      return {
        update(next, when) {
          params = next;
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
