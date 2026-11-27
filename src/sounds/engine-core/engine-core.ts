/**
 * Starship Engine Core: a large machine running smoothly, heard from a few
 * metres away in a metal room. Four parts, bottom to top:
 *
 *   drone:  sine at `pitch` (centred) + harmonic wave (right channel 0.08 Hz
 *           higher, for slow-beating width) → pitch wander → low-pass at `power`
 *           ↘ band-pass at 2.5 × pitch → throb swell ↗ (in parallel)
 *   throb:  an asymmetric pulse LFO at `pulseRate` that swells that band, opens
 *           the low-pass and lifts the air, all in phase
 *   room:   pink noise and a little of the drone ringing three narrow band-passes
 *           at unrelated multiples of the pitch, placed left, right and centre,
 *           plus a send of drone and resonances to the shared metal reverb
 *   air:    pink noise band-passed to 1.8–6.5 kHz, a faint ventilation hiss
 *
 * Every oscillator is phase-aligned to absolute time, and the slow random
 * motion (pitch wander, the throb's rate wander, the resonances' levels and the
 * air's band) comes from drifts of absolute time. The pitch and rate
 * wander are applied as phase modulation, through a delay line whose delay the
 * drift moves, rather than by moving the oscillators' frequencies: a frequency
 * change accumulates into the phase from whenever rendering began, but a
 * moving delay doesn't, so the output at a given time depends only on that
 * time, the seed and the params.
 *
 * The seed only picks the noise and the drifts. They travel together as one
 * multichannel signal through a crossfader, so a seed change crossfades the
 * noise and the motion to the new variation while the drone itself plays on
 * untouched (crossfading two copies of the same drone would bump its level).
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { createDrifts } from "../../audio/drift";
import { dbToGain, glide } from "../../audio/glide";
import { createLfo } from "../../audio/lfo";
import { createNoise } from "../../audio/noise";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type AudioScope, type Disposable } from "../../audio/scope";
import { defineSound, type ParamValues } from "../types";
import {
  droneCutoff,
  droneWave,
  RESONANCES,
  roomSendDb,
  THROB,
  THROB_AIR,
  THROB_BAND,
  THROB_BRIGHTNESS,
  THROB_LEVEL,
  throbDepth,
} from "./engine-core-dsp";
import { engineCoreMeta } from "./engine-core.meta";

type EngineParams = ParamValues<typeof engineCoreMeta.params>;

/** The right channel's harmonic wave runs this much higher than the left's, in Hz. */
const DETUNE = 0.08;

/**
 * Pitch wander: the delay line's base delay and swing, in seconds. A delay
 * moving at rate r shifts the pitch by a fraction r; the drift's slope stays
 * under about 0.09 per second 99 % of the time, so a swing of 40 ms keeps the
 * wander within about ±6 cents.
 */
const WANDER_DELAY = 0.06;
const WANDER_SWING = 0.04;
/**
 * Rate wander, the same way on the throb's LFO: the slower drift's slope stays
 * under about 0.036 per second, so a swing of 0.42 s nudges the rate by up to
 * about ±1.5 %.
 */
const RATE_DELAY = 0.6;
const RATE_SWING = 0.42;

/** The throb band's Q, and the room resonances'. */
const THROB_Q = 1.2;
const RESONANCE_Q = 8;
/** How far each resonance's level drifts: ±0.35, about ±3 dB. */
const RESONANCE_SWING = 0.35;
/** The noise into the resonances, the drone's send into them, and their level at room 100. */
const ROOM_NOISE_DB = -12;
const ROOM_DRONE_DB = -24;
const RESONANCE_GAIN = 8;

/**
 * The air's band, 1.8–6.5 kHz: one band-pass at the band's geometric centre, its
 * −3 dB points at the edges. A drift moves it by ±10 %. Then its level at hiss 100.
 */
const AIR_LOW = 1800;
const AIR_HIGH = 6500;
const AIR_CENTRE = Math.sqrt(AIR_LOW * AIR_HIGH);
const AIR_Q = AIR_CENTRE / (AIR_HIGH - AIR_LOW);
const AIR_SWING = 0.1;
const AIR_GAIN = dbToGain(-12);

/** The drone and room's output level, and the air's, from about 0 dBFS to about −23 LUFS. */
const TRIM = dbToGain(-21.6);

/** Glide time constants, in seconds. */
const PITCH_GLIDE = 0.4;
/** The room band-passes follow the pitch more slowly, so their narrow peaks don't zipper. */
const ROOM_PITCH_GLIDE = 1.5;
const GAIN_GLIDE = 0.1;
const TIMBRE_GLIDE = 0.5;
/** A seed change's crossfade, in seconds. */
const SEED_FADE = 2;

/**
 * The seeded signals' channels: stereo pink noise, then a drift for each of the
 * pitch wander, the rate wander, the three resonances and the air's band.
 */
const NOISE_LEFT = 0;
const NOISE_RIGHT = 1;
const WANDER = 2;
const RATE = 3;
const RESONANCE = 4;
const AIR = RESONANCE + RESONANCES.length;
const CHANNELS = AIR + 1;

/** The noise channel that rings each resonance, and its level on the left and right. */
const CENTRE = [0.75, 0.75] as const;
const RESONANCE_NOISE = [NOISE_LEFT, NOISE_RIGHT, NOISE_LEFT] as const;
const RESONANCE_PLACES: readonly (readonly [number, number])[] = [[1, 0.4], [0.4, 1], CENTRE];

/** Each drift's rate (Hz) and octaves, in channel order from `WANDER`. */
const DRIFTS: readonly { rate: number; octaves: number }[] = [
  { rate: 0.05, octaves: 2 },
  { rate: 0.02, octaves: 1 },
  ...RESONANCES.map(() => ({ rate: 0.03, octaves: 1 })),
  { rate: 0.08, octaves: 1 },
];

/** Random streams: the noise, then one per drift, all in one drift node. */
const NOISE_STREAM = 1;
const DRIFT_STREAM = 2;

/** The resonances' level at `room` (0–100). */
function resonanceGain(room: number): number {
  return RESONANCE_GAIN * dbToGain(ROOM_NOISE_DB) * Math.min(1, Math.max(0, room / 100));
}

/** The air's level at `hiss` (0–100). */
function airGain(hiss: number): number {
  return AIR_GAIN * TRIM * Math.min(1, Math.max(0, hiss / 100));
}

/**
 * Builds one variation's seeded signals, merged into `CHANNELS` channels, into
 * `into`.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  absoluteNow: () => number,
  onError: ((error: unknown) => void) | undefined,
): Promise<Disposable> {
  return withAudioScope(async (scope): Promise<Disposable> => {
    const noise = await createNoise(ctx, scope, {
      colour: "pink",
      seed,
      stream: NOISE_STREAM,
      channels: 2,
      startAt: absoluteNow(),
    });
    const drifts = await createDrifts(ctx, scope, {
      seed,
      drifts: DRIFTS.map((drift, i) => ({ ...drift, stream: DRIFT_STREAM + i })),
      startAt: absoluteNow(),
    });
    const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: CHANNELS }));
    const noiseChannels = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
    noise.connect(noiseChannels);
    noiseChannels.connect(merger, 0, NOISE_LEFT);
    noiseChannels.connect(merger, 1, NOISE_RIGHT);
    const driftChannels = scope.add(
      new ChannelSplitterNode(ctx, { numberOfOutputs: DRIFTS.length }),
    );
    drifts.connect(driftChannels);
    DRIFTS.forEach((_, i) => {
      driftChannels.connect(merger, i, WANDER + i);
    });
    merger.connect(into);
    return {
      dispose: () => {
        scope.dispose();
      },
    };
  }, onError);
}

/** A biquad whose params move slowly, so it updates its coefficients once per render quantum. */
function slowBiquad(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: BiquadFilterOptions,
): BiquadFilterNode {
  const filter = scope.add(new BiquadFilterNode(ctx, options));
  filter.frequency.automationRate = "k-rate";
  return filter;
}

/**
 * A delay line whose delay `swing` (a −1..1 signal) moves by ±`depth` around
 * `base`. It holds up to 3 × `base`, so a crossfade that briefly sums two swings
 * (up to √2 × as far) stays in range.
 */
function wanderDelay(
  ctx: BaseAudioContext,
  scope: AudioScope,
  base: number,
  depth: number,
  swing: AudioNode,
  swingOutput: number,
): DelayNode {
  const delay = scope.add(new DelayNode(ctx, { maxDelayTime: 3 * base, delayTime: base }));
  const scaled = scope.add(new GainNode(ctx, { gain: depth }));
  swing.connect(scaled, swingOutput).connect(delay.delayTime);
  return delay;
}

/** The throb's targets at `params`: each one's base value and the LFO's depth on it. */
function throbTargets(params: EngineParams) {
  const depth = throbDepth(params.pulseDepth);
  const cutoff = droneCutoff(params.power, params.pitch);
  // The LFO spans −offset..1 − offset; each target's base adds the offset back.
  const target = (base: number, swing: number) => ({
    base: base + swing * THROB.offset,
    swing,
  });
  return {
    level: target(0, THROB_LEVEL * depth),
    cutoff: target(cutoff, cutoff * THROB_BRIGHTNESS * depth),
    air: target(1, THROB_AIR * depth),
  };
}

export const engineCore = defineSound(engineCoreMeta, {
  // The throb's rate wanders as phase modulation, so its average period stays exactly this.
  loopPeriod: (params) => (throbDepth(params.pulseDepth) > 0 ? 1 / params.pulseRate : undefined),
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let seed = init.seed;

      const seeded = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: CHANNELS }));
      const fader = createCrossfader(ctx, scope, seeded, SEED_FADE);
      const variation = (variationSeed: number) => (into: AudioNode) =>
        buildVariation(ctx, into, variationSeed, absoluteNow, init.onError);
      await fader.swap(variation(seed));

      const p = init.params;
      const start = absoluteNow();
      const throb = throbTargets(p);

      // Drone: the sine is mono, so it is centred and never cancels in mono.
      const sine = createLfo(ctx, scope, { frequency: p.pitch, startAt: start });
      const wave = droneWave();
      const harmonicsLeft = createLfo(ctx, scope, { frequency: p.pitch, wave, startAt: start });
      const harmonicsRight = createLfo(ctx, scope, {
        frequency: p.pitch + DETUNE,
        wave,
        startAt: start,
      });
      const harmonics = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      harmonicsLeft.connect(harmonics, 0, 0);
      harmonicsRight.connect(harmonics, 0, 1);
      const drone = scope.add(new GainNode(ctx, { channelCount: 2, channelCountMode: "explicit" }));
      sine.connect(drone);
      harmonics.connect(drone);
      const wandering = wanderDelay(ctx, scope, WANDER_DELAY, WANDER_SWING, seeded, WANDER);
      drone.connect(wandering);

      const lowpass = slowBiquad(ctx, scope, {
        type: "lowpass",
        frequency: throb.cutoff.base,
        Q: BUTTERWORTH_Q,
      });
      // The swelling band is mono, mixed down from the drone: it swells in the centre.
      const band = slowBiquad(ctx, scope, {
        type: "bandpass",
        frequency: THROB_BAND * p.pitch,
        Q: THROB_Q,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      const swell = scope.add(new GainNode(ctx, { gain: throb.level.base }));
      wandering.connect(lowpass);
      wandering.connect(band).connect(swell);

      // Throb: one pulse LFO, its rate wandering, into the three targets.
      const pulse = createLfo(ctx, scope, { frequency: p.pulseRate, wave: THROB, startAt: start });
      const pulsing = wanderDelay(ctx, scope, RATE_DELAY, RATE_SWING, seeded, RATE);
      pulse.connect(pulsing);
      const toLevel = scope.add(new GainNode(ctx, { gain: throb.level.swing }));
      const toCutoff = scope.add(new GainNode(ctx, { gain: throb.cutoff.swing }));
      const toAir = scope.add(new GainNode(ctx, { gain: throb.air.swing }));
      pulsing.connect(toLevel).connect(swell.gain);
      pulsing.connect(toCutoff).connect(lowpass.frequency);

      // The drone and room, trimmed to the output level.
      const body = scope.add(new GainNode(ctx, { gain: TRIM }));
      lowpass.connect(body);
      swell.connect(body);

      // Room: three narrow resonances, each rung by one channel of the noise and by
      // the drone, drifting in level, and placed left, right and centre. They are
      // mono, which halves their cost; the reverb spreads them. Their inputs are
      // relative to the noise, whose level is folded into `resonance`.
      const droneSend = scope.add(
        new GainNode(ctx, {
          gain: dbToGain(ROOM_DRONE_DB - ROOM_NOISE_DB),
          channelCount: 1,
          channelCountMode: "explicit",
        }),
      );
      lowpass.connect(droneSend);
      swell.connect(droneSend);
      const placed = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      const resonators = RESONANCES.map((ratio, i) => {
        const filter = slowBiquad(ctx, scope, {
          type: "bandpass",
          frequency: ratio * p.pitch,
          Q: RESONANCE_Q,
          channelCount: 1,
          channelCountMode: "explicit",
        });
        seeded.connect(filter, RESONANCE_NOISE[i] ?? NOISE_LEFT);
        droneSend.connect(filter);
        const level = scope.add(new GainNode(ctx, { gain: 1 }));
        const drifting = scope.add(new GainNode(ctx, { gain: RESONANCE_SWING }));
        seeded.connect(drifting, RESONANCE + i).connect(level.gain);
        filter.connect(level);
        // One gain per distinct level, feeding the sides that take it.
        const place = RESONANCE_PLACES[i] ?? CENTRE;
        for (const gain of new Set(place)) {
          const node = gain === 1 ? level : level.connect(scope.add(new GainNode(ctx, { gain })));
          place.forEach((g, side) => {
            if (g === gain) {
              node.connect(placed, 0, side);
            }
          });
        }
        return filter;
      });
      const resonance = scope.add(new GainNode(ctx, { gain: resonanceGain(p.room) }));
      placed.connect(resonance).connect(body);
      body.connect(out);
      const send = createSend(ctx, scope, body, out, "metal", roomSendDb(p.room));

      // Air: band-limited hiss whose band drifts, swelling with the throb.
      const noise = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      seeded.connect(noise, NOISE_LEFT, 0);
      seeded.connect(noise, NOISE_RIGHT, 1);
      const air = slowBiquad(ctx, scope, { type: "bandpass", frequency: AIR_CENTRE, Q: AIR_Q });
      const airDrift = scope.add(new GainNode(ctx, { gain: AIR_CENTRE * AIR_SWING }));
      seeded.connect(airDrift, AIR).connect(air.frequency);
      const hiss = scope.add(new GainNode(ctx, { gain: airGain(p.hiss) }));
      const airSwell = scope.add(new GainNode(ctx, { gain: throb.air.base }));
      pulsing.connect(toAir).connect(airSwell.gain);
      noise.connect(air).connect(hiss).connect(airSwell).connect(out);

      return {
        update(next, when) {
          const t = throbTargets(next);
          glide(sine.frequency, next.pitch, when, PITCH_GLIDE);
          glide(harmonicsLeft.frequency, next.pitch, when, PITCH_GLIDE);
          glide(harmonicsRight.frequency, next.pitch + DETUNE, when, PITCH_GLIDE);
          glide(band.frequency, THROB_BAND * next.pitch, when, PITCH_GLIDE);
          resonators.forEach((filter, i) => {
            glide(filter.frequency, (RESONANCES[i] ?? 1) * next.pitch, when, ROOM_PITCH_GLIDE);
          });
          glide(pulse.frequency, next.pulseRate, when, PITCH_GLIDE);
          glide(lowpass.frequency, t.cutoff.base, when, TIMBRE_GLIDE);
          glide(toCutoff.gain, t.cutoff.swing, when, TIMBRE_GLIDE);
          glide(swell.gain, t.level.base, when, GAIN_GLIDE);
          glide(toLevel.gain, t.level.swing, when, GAIN_GLIDE);
          glide(airSwell.gain, t.air.base, when, GAIN_GLIDE);
          glide(toAir.gain, t.air.swing, when, GAIN_GLIDE);
          glide(resonance.gain, resonanceGain(next.room), when, TIMBRE_GLIDE);
          glide(send.gain, dbToGain(roomSendDb(next.room)), when, GAIN_GLIDE);
          glide(hiss.gain, airGain(next.hiss), when, GAIN_GLIDE);
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
