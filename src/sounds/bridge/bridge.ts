/**
 * Starship Bridge: the quiet background of a large, carpeted command room on
 * a ship cruising smoothly. Four layers, bottom to top:
 *
 *   room:     warm brown noise between 60 and 380 Hz, the sound of a big
 *             quiet space, under a band of ventilation air around 900 Hz
 *             whose level and centre drift, both sent to the shared room
 *             reverb
 *   engine:   a very low, steady hum at 41 Hz felt through the deck, its
 *             harmonics up to 250 Hz so it carries on small speakers, rolled
 *             off above 260 Hz to sound far away, its level drifting by about
 *             a decibel; no throb
 *   consoles: now and then a short soft blip or a little phrase of two to
 *             four notes from a console somewhere in the room, with a send to
 *             the room reverb
 *   doors:    optionally, a rare soft whoosh of a door off to one side
 *
 * and, off unless asked for, a soft, slow falling two-note attention tone.
 *
 * Everything seeded comes from one worklet (`bridge-dsp.ts`): the room's
 * bed, the consoles, doors and alert, and the hum's drift. Its channels
 * travel together through a crossfader, so a seed change crossfades to the
 * new variation while the hum plays on untouched (crossfading two copies of
 * the same hum would bump its level). The hum is three native oscillators,
 * phase-aligned to absolute time. Activity and Doors set event rates the
 * worklet latches each second, so they apply from the next phrase or door;
 * the alert fades in and out over about a second and a half.
 */
import { createCrossfader } from "../../audio/crossfade";
import { dbToGain, glide } from "../../audio/glide";
import { createLfo, type Wave } from "../../audio/lfo";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { startProcessor } from "../../audio/worklets";
import { defineSound, type ParamValues } from "../types";
import {
  ACTIVITY_RATES,
  ALERT_PERIOD,
  BED_LEFT,
  BED_RIGHT,
  BRIDGE_CHANNELS,
  BRIDGE_PROCESSOR,
  DOOR_RATES,
  ENGINE_DRIFT,
  EVENTS_LEFT,
  EVENTS_RIGHT,
  ROOM_DB,
} from "./bridge-dsp";
import { bridgeMeta } from "./bridge.meta";
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import bridgeWorkletUrl from "./bridge.worklet.ts?worker&url";

type BridgeParams = ParamValues<typeof bridgeMeta.params>;

/**
 * The engine hum: a sine at 41 Hz in the centre, for mono, and a wave of
 * harmonics 1–6 (1 and 2 at −6 dB) on each side, the right 0.05 Hz higher for
 * a slow, wide beat. A low-pass at 260 Hz (Q 0.6) softens it to sound distant:
 * its gain at each harmonic is built into the waves, which saves a filter. At
 * Engine hum 100 it sits 14 dB under the room tone; a drift moves its level by
 * ±1 dB.
 */
const HUM = 41;
const HUM_DETUNE = 0.05;
const HUM_HARMONICS = [0.5, 0.5, 1, 1, 1, 1];
const HUM_SINE = 0.5;
const HUM_LOWPASS = 260;
const HUM_Q = 0.6;
const HUM_UNDER_ROOM_DB = -14;
const HUM_LEVEL_SWING = 0.115;

/** The low-pass's gain at `frequency`. */
function humRolloff(frequency: number): number {
  const x = frequency / HUM_LOWPASS;
  return 1 / Math.hypot(1 - x * x, x / HUM_Q);
}

/** A wave of `amplitudes` (harmonics 1, 2, …), rolled off by the low-pass. */
function humWave(amplitudes: readonly number[]): Wave {
  return {
    real: amplitudes.map(() => 0).concat(0),
    imag: [0, ...amplitudes.map((a, k) => a * humRolloff(HUM * (k + 1)))],
  };
}

const HARMONICS_WAVE = humWave(HUM_HARMONICS);
const SINE = humWave([HUM_SINE]);

/** The hum's RMS on each side before its level: the sine adds to the wave's fundamental. */
const HUM_RMS = Math.sqrt(
  HARMONICS_WAVE.imag.reduce(
    (sum, a, k) => sum + (a + (k === 1 ? (SINE.imag[1] ?? 0) : 0)) ** 2 / 2,
    0,
  ),
);

/** The room reverb sends: the room's bed, and the consoles, doors and alert, in dB. */
const ROOM_SEND_DB = -22;
const EVENTS_SEND_DB = -16;

/** Glide time constants, in seconds. */
const GAIN_GLIDE = 0.1;
/** The alert fades over about a second and a half: three of these. */
const ALERT_GLIDE = 0.5;
/** A seed change's crossfade, in seconds. */
const FADE = 2;

/** The engine hum's level at `engine` (0–100): 0 is none, 100 sits 14 dB under the room. */
function humGain(engine: number): number {
  const share = Math.min(1, Math.max(0, engine / 100));
  return (dbToGain(ROOM_DB + HUM_UNDER_ROOM_DB) / HUM_RMS) * share;
}

/** The worklet's params. */
const workletParams = (p: BridgeParams) => ({
  rate: ACTIVITY_RATES[p.activity],
  doors: DOOR_RATES[p.doors],
  alert: p.alert ? 1 : 0,
  air: p.air,
});

interface Variation extends Disposable {
  update: (params: BridgeParams, when: number) => void;
}

/**
 * Builds the variation for `seed` into `into`, at the params `params()` gives
 * once its worklet has loaded, and adds it to `live` until it is disposed.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  params: () => BridgeParams,
  absoluteNow: () => number,
  live: Set<Variation>,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const initial = params();
    const source = await startProcessor(ctx, scope, bridgeWorkletUrl, BRIDGE_PROCESSOR, {
      channels: BRIDGE_CHANNELS,
      startAt: absoluteNow(),
      processorOptions: { seed },
      parameterData: workletParams(initial),
    });
    source.connect(into);
    const param = (name: string) => source.parameters.get(name);

    const variation: Variation = {
      update(next, when) {
        const values = workletParams(next);
        // Phrases and doors latch their rates each second, so they need no glide.
        param("rate")?.setValueAtTime(values.rate, when);
        param("doors")?.setValueAtTime(values.doors, when);
        const alert = param("alert");
        if (alert) {
          glide(alert, values.alert, when, ALERT_GLIDE);
        }
        const air = param("air");
        if (air) {
          glide(air, values.air, when, GAIN_GLIDE);
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

export const bridge = defineSound(bridgeMeta, {
  // The alert repeats exactly every few seconds of absolute time; nothing else is rhythmic.
  loopPeriod: (params) => (params.alert ? ALERT_PERIOD : undefined),
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;
      let seed = init.seed;
      const live = new Set<Variation>();

      const seeded = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: BRIDGE_CHANNELS }));
      const fader = createCrossfader(ctx, scope, seeded, FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, () => params, absoluteNow, live, init.onError);
      await fader.swap(variation(seed));
      const stereo = (left: number, right: number) => {
        const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
        seeded.connect(merger, left, 0);
        seeded.connect(merger, right, 1);
        return merger;
      };

      // The room's bed, and the consoles, doors and alert, each with a send to the room reverb.
      const bed = stereo(BED_LEFT, BED_RIGHT);
      bed.connect(out);
      createSend(ctx, scope, bed, out, "room", ROOM_SEND_DB);
      const events = stereo(EVENTS_LEFT, EVENTS_RIGHT);
      events.connect(out);
      createSend(ctx, scope, events, out, "room", EVENTS_SEND_DB);

      // Engine: the hum, a centred sine plus a slowly beating harmonic wave each side.
      const start = absoluteNow();
      const sine = createLfo(ctx, scope, { frequency: HUM, wave: SINE, startAt: start });
      const left = createLfo(ctx, scope, { frequency: HUM, wave: HARMONICS_WAVE, startAt: start });
      const right = createLfo(ctx, scope, {
        frequency: HUM + HUM_DETUNE,
        wave: HARMONICS_WAVE,
        startAt: start,
      });
      const hum = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      left.connect(hum, 0, 0);
      right.connect(hum, 0, 1);
      sine.connect(hum, 0, 0);
      sine.connect(hum, 0, 1);
      const humSwing = scope.add(new GainNode(ctx, { gain: 1 }));
      const humDepth = scope.add(new GainNode(ctx, { gain: HUM_LEVEL_SWING }));
      seeded.connect(humDepth, ENGINE_DRIFT).connect(humSwing.gain);
      const engine = scope.add(new GainNode(ctx, { gain: humGain(params.engine) }));
      hum.connect(humSwing).connect(engine).connect(out);

      return {
        update(next, when) {
          params = next;
          glide(engine.gain, humGain(next.engine), when, GAIN_GLIDE);
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
