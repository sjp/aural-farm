/**
 * Server Room: standing in the aisle between two rows of racks. A wall of air
 * from hundreds of small fans, each at a slightly different speed, so their
 * tones crowd into a dense, faintly shimmering chord that never quite
 * settles; underneath, the building's cooling units rumble; very faintly
 * above, power supplies whine; and, if on, now and then a disk seeks.
 *
 * Everything comes from one worklet (`server-room-dsp.ts`) per seed: the air
 * and the rumble are noise filtered inline, and the tones come from wave
 * tables phase-aligned to absolute time, so that each fan's pitch can wander
 * as phase modulation without the output depending on when rendering began.
 * That costs less than a native oscillator, drift and delay line per fan. A
 * seed change crossfades the worklet over 2 s. A small send to the shared
 * room reverb puts it in a hard-floored room.
 */
import { createCrossfader } from "../../audio/crossfade";
import { glide } from "../../audio/glide";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import { SERVER_ROOM_CHANNELS, SERVER_ROOM_PROCESSOR } from "./server-room-dsp";
import { serverRoomMeta } from "./server-room.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import serverRoomWorkletUrl from "./server-room.worklet.ts?worker&url";

type ServerRoomParams = ParamValues<typeof serverRoomMeta.params>;

/** The room reverb's send, in dB: a hard-floored, medium room. */
const ROOM_SEND_DB = -26;
/** The levels' glide time constant, in seconds. */
const GAIN_GLIDE = 0.1;
/** A seed change's crossfade, in seconds. */
const SEED_FADE = 2;

/** The worklet's params. */
const workletParams = (p: ServerRoomParams) => ({
  airflow: p.airflow,
  racks: p.racks,
  hvac: p.hvac,
  whine: p.whine,
  disks: p.disks ? 1 : 0,
});

/** The levels, which glide; the racks fade in the kernel, and disk ticks latch per tick. */
const GLIDING = new Set(["airflow", "hvac", "whine"]);

interface Variation extends Disposable {
  update: (params: ServerRoomParams, when: number) => void;
}

/**
 * Builds the room for `seed` into `into`, at the params `params()` gives once
 * its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => ServerRoomParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, serverRoomWorkletUrl, SERVER_ROOM_PROCESSOR, {
      channels: SERVER_ROOM_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);

    const variation: Variation = {
      update(next, when) {
        for (const [name, value] of Object.entries(workletParams(next))) {
          const param = source.parameters.get(name);
          if (!param) {
            continue;
          }
          if (GLIDING.has(name)) {
            glide(param, value, when, GAIN_GLIDE);
          } else {
            param.setValueAtTime(value, when);
          }
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

export const serverRoom = defineSound(serverRoomMeta, {
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
      const fader = createCrossfader(ctx, scope, mix, SEED_FADE);
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
