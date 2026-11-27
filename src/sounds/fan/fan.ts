/**
 * Fan: a fan running in a bedroom, heard from the bed. The air is the point;
 * the motor and blades are just enough to make it a real fan rather than
 * plain noise. Two layers:
 *
 *   air:   pink noise with a little brown under it, shaped by the fan's own
 *          high-pass, body and low-pass, louder and brighter with Speed, and
 *          swelling and dipping as the blades pass (a desk fan's quick
 *          flutter, a ceiling fan's slow whum, a box fan's coarser one, an
 *          air conditioner's faint ripple); desk and box fans can oscillate,
 *          turning slowly side to side
 *   motor: a faint tone under the air: a bladed fan's whirr at six times its
 *          rotation, an air conditioner's compressor hum at 100 Hz, or a
 *          ceiling fan's faint 120 Hz
 *
 * The air comes from one worklet (`fan-dsp.ts`) per kind of fan and seed. A
 * change of fan crossfades the whole graph over 1.5 s; a seed change
 * crossfades the worklet alone over 2 s, under the same motor. The motor is a
 * native oscillator phase-aligned to absolute time; a change of Speed glides
 * its pitch and the blades' rate like a fan spinning up or down, which leaves
 * their phase off absolute time until the next fresh render. At steady
 * params everything lands on absolute time.
 */
import { createCrossfader } from "../../audio/crossfade";
import { glide } from "../../audio/glide";
import { createLfo } from "../../audio/lfo";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  FAN_CHANNELS,
  FAN_PROCESSOR,
  motorFrequency,
  motorGain,
  motorWave,
  sweepShare,
  SWEEP_PERIOD,
} from "./fan-dsp";
import { fanMeta, type FanType } from "./fan.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import fanWorkletUrl from "./fan.worklet.ts?worker&url";

type FanParams = ParamValues<typeof fanMeta.params>;

/** Glide time constants, in seconds: Speed (a fan spinning up), Tone, Oscillate and Motor. */
const SPEED_GLIDE = 1.5;
const TONE_GLIDE = 0.5;
/** Most of the way in 2 s. */
const SWEEP_GLIDE = 0.5;
const GAIN_GLIDE = 0.1;
/** Crossfades, in seconds: a change of fan, and of seed. */
const TYPE_FADE = 1.5;
const SEED_FADE = 2;

/** The worklet's params. */
const workletParams = (p: FanParams) => ({
  speed: p.speed,
  tone: p.tone,
  oscillate: p.oscillate ? 1 : 0,
});

interface Graph extends Disposable {
  update: (params: FanParams, previous: FanParams, when: number) => void;
}

/** Every live graph's shared needs: the params now, absolute time, and error reporting. */
interface Context {
  ctx: BaseAudioContext;
  params: () => FanParams;
  absoluteNow: () => number;
  onError: ((error: unknown) => void) | undefined;
}

/**
 * Builds the air of fan `type` for `seed` into `into`, at the params
 * `c.params()` gives once its worklet has loaded, and adds it to `live` until
 * it is disposed.
 */
function buildAir(
  c: Context,
  into: AudioNode,
  type: FanType,
  seed: number,
  live: Set<Graph>,
): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const initial = c.params();
    const source = await startProcessor(c.ctx, scope, fanWorkletUrl, FAN_PROCESSOR, {
      channels: FAN_CHANNELS,
      startAt: c.absoluteNow(),
      processorOptions: { type, seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);
    const param = (name: string) => source.parameters.get(name);

    const air: Graph = {
      update(next, _previous, when) {
        const values = workletParams(next);
        const speed = param("speed");
        const tone = param("tone");
        const oscillate = param("oscillate");
        if (speed) {
          glide(speed, values.speed, when, SPEED_GLIDE);
        }
        if (tone) {
          glide(tone, values.tone, when, TONE_GLIDE);
        }
        if (oscillate) {
          glide(oscillate, values.oscillate, when, SWEEP_GLIDE);
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    // A change made while the worklet loaded.
    const p = c.params();
    if (p !== initial) {
      air.update(p, initial, c.ctx.currentTime);
    }
    live.add(air);
    scope.defer(() => {
      live.delete(air);
    });
    return air;
  }, c.onError);
}

/**
 * Builds fan `type` into `into`: its air, crossfading on a seed change, and
 * its motor. Adds it to `live` until it is disposed.
 */
function buildFan(c: Context, into: AudioNode, type: FanType, live: Set<Graph>): Promise<Graph> {
  return withAudioScope(async (scope): Promise<Graph> => {
    const { ctx } = c;
    const airs = new Set<Graph>();
    const fader = createCrossfader(ctx, scope, into, SEED_FADE);
    let seed = c.params().seed;
    const air = (airSeed: number) => (out: AudioNode) => buildAir(c, out, type, airSeed, airs);
    await fader.swap(air(seed));

    // The motor, centred.
    const initial = c.params();
    const motor = createLfo(ctx, scope, {
      frequency: motorFrequency(type, initial.speed),
      wave: motorWave(type),
      startAt: c.absoluteNow(),
    });
    const motorLevel = scope.add(
      new GainNode(ctx, { gain: motorGain(type, initial.motor, initial.speed) }),
    );
    motor.connect(motorLevel).connect(into);

    const fan: Graph = {
      update(next, previous, when) {
        if (next.speed !== previous.speed) {
          glide(motor.frequency, motorFrequency(type, next.speed), when, SPEED_GLIDE);
        }
        // The motor follows the air's level, which glides with Speed.
        const tau = next.speed === previous.speed ? GAIN_GLIDE : SPEED_GLIDE;
        glide(motorLevel.gain, motorGain(type, next.motor, next.speed), when, tau);
        for (const a of airs) {
          a.update(next, previous, when);
        }
        if (next.seed !== seed) {
          seed = next.seed;
          fader.swap(air(seed)).catch((error: unknown) => {
            c.onError?.(error);
          });
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    // A change made while the worklet loaded.
    const p = c.params();
    if (p !== initial) {
      fan.update(p, initial, ctx.currentTime);
    }
    live.add(fan);
    scope.defer(() => {
      live.delete(fan);
    });
    return fan;
  }, c.onError);
}

export const fan = defineSound(fanMeta, {
  // Only the oscillation is a rhythm a loop's join could break: the blades'
  // flutter is too quick to hear its phase.
  loopPeriod: (params) =>
    sweepShare(params.type, params.oscillate ? 1 : 0) > 0 ? SWEEP_PERIOD : undefined,
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
      const fans = new Set<Graph>();
      const fader = createCrossfader(ctx, scope, out, TYPE_FADE);
      const build = (type: FanType) => (into: AudioNode) => buildFan(c, into, type, fans);
      await fader.swap(build(params.type));

      return {
        update(next, when) {
          const previous = params;
          params = next;
          for (const f of fans) {
            f.update(next, previous, when);
          }
          if (next.type !== previous.type) {
            fader.swap(build(next.type)).catch((error: unknown) => {
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
