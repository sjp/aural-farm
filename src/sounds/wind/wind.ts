/**
 * Wind: moving air heard outdoors, or from indoors. All native nodes, on the
 * shared noise and drift sources:
 *
 *   speed:    strength + gustiness × gust + a slow trend. The gust is a drift
 *             through a shaper that flattens its dips into lulls and rounds
 *             its peaks, so gusts are surges, not a wobble. Shapers turn the
 *             speed into the controls below.
 *   body:     stereo pink noise through two broad band-passes that rise with
 *             the speed (each drifting on its own), at a level whose power
 *             rises roughly with the speed squared.
 *   whistle:  a narrow band of the noise, a soft hollow tone whose pitch rises
 *             with the speed (never past 1.6 kHz), coming and going on a drift
 *             and with the gusts.
 *   setting:  what the wind blows past sets the bands, a low-pass and the
 *             whistles: an open field, trees (with a fluttering rustle of
 *             leaves) or a house (muffled, with two moaning whistles and a
 *             little room reverb).
 *
 * The seed picks the noise and the drifts, and a seed change crossfades both
 * to the new variation. A setting change crossfades its graph to the new one;
 * both read the same speed, so the gusts carry on in step through it.
 *
 * Every speed control is a shaper reading the sum of the strength, gusts and
 * trend, and the whistle level rides on the body's, which keeps the node count
 * (and so the cost) down.
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { createDrifts } from "../../audio/drift";
import { dbToGain, glide } from "../../audio/glide";
import { createNoise } from "../../audio/noise";
import { createSend } from "../../audio/reverb";
import { withAudioScope, type AudioScope, type Disposable } from "../../audio/scope";
import { defineSound } from "../types";
import {
  BAND_SWING_CENTS,
  bodyLevelCurve,
  colourCurve,
  flutterCurve,
  GUST_DEPTH,
  gustCurve,
  SETTINGS,
  SPEED_MAX,
  TREND_SWING,
  whistleCurve,
} from "./wind-dsp";
import { windMeta, type WindSetting } from "./wind.meta";

/**
 * The whistle's band-pass Q: about as narrow as two band-passes of Q 18 in
 * series, and its wider skirts are far under the body. Then its make-up gain,
 * to about −14 dB against the body at full whistle and speed 1 (for a whistle
 * at 0 dB). It rides on the body's level, so it is further under the body in
 * lulls and comes up with the gusts.
 */
const WHISTLE_Q = 28;
const WHISTLE_GAIN = dbToGain(7);
/** How far the whistle's level drifts: ±0.4, about ±4 dB. */
const WHISTLE_SWING = 0.4;
/** The leaves: a band of the noise at 3.5 kHz, Q 0.9, peaking about −10 dB against the body. */
const RUSTLE_CENTRE = 3500;
const RUSTLE_Q = 0.9;
const RUSTLE_GAIN = dbToGain(-6);

/** The whole sound's level, to about −23 LUFS at defaults. */
const TRIM = dbToGain(-5.5);

/** Strength, gusts and whistle glide with this time constant, in seconds: wind changes slowly. */
const GLIDE = 1;
/** A seed or setting change's crossfade, in seconds. */
const FADE = 2;

/** The drifts' channels. */
const GUST = 0;
const TREND = 1;
const BAND = [2, 3] as const;
const WHISTLE_DRIFT = 4;
const FLUTTER = 5;

/** The drifts' rates (Hz) and octaves, in channel order. */
const DRIFTS: readonly { rate: number; octaves: number }[] = [
  { rate: 0.07, octaves: 3 },
  { rate: 0.013, octaves: 1 },
  { rate: 0.05, octaves: 1 },
  { rate: 0.031, octaves: 1 },
  { rate: 0.11, octaves: 1 },
  { rate: 9, octaves: 2 },
];

/** Random streams: the noise, then one per drift, all in one drift node. */
const NOISE_STREAM = 1;
const DRIFT_STREAM = 2;

/** Builds `seed`'s stereo pink noise into `into`. */
function buildNoise(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  startAt: number,
  onError: ((error: unknown) => void) | undefined,
): Promise<Disposable> {
  return withAudioScope(async (scope): Promise<Disposable> => {
    const noise = await createNoise(ctx, scope, {
      colour: "pink",
      seed,
      stream: NOISE_STREAM,
      channels: 2,
      startAt,
    });
    noise.connect(into);
    return {
      dispose: () => {
        scope.dispose();
      },
    };
  }, onError);
}

/** Builds `seed`'s drifts, one per channel, into `into`. */
function buildDrifts(
  ctx: BaseAudioContext,
  into: AudioNode,
  seed: number,
  startAt: number,
  onError: ((error: unknown) => void) | undefined,
): Promise<Disposable> {
  return withAudioScope(async (scope): Promise<Disposable> => {
    const drifts = await createDrifts(ctx, scope, {
      seed,
      drifts: DRIFTS.map((drift, i) => ({ ...drift, stream: DRIFT_STREAM + i })),
      startAt,
    });
    drifts.connect(into);
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
  filter.detune.automationRate = "k-rate";
  return filter;
}

/** A mono node for a control signal. */
const mono = { channelCount: 1, channelCountMode: "explicit" } as const;

/** The shared signals each setting's graph reads. */
interface Controls {
  /** The stereo noise, and the drifts, one per output. */
  noise: AudioNode;
  drifts: AudioNode;
  /** The body's level (with the trim). */
  level: AudioNode;
  /** The bands' rise with the speed, and each band's own drift, in cents. */
  rise: AudioNode;
  swings: readonly [AudioNode, AudioNode];
  /** The whistles' rise in cents. */
  bend: AudioNode;
  /** The leaves' flutter. */
  flutter: AudioNode;
}

interface SettingGraph extends Disposable {
  /** Glides the whistles to `whistle` (0–100). */
  setWhistle: (whistle: number, when: number) => void;
}

/** A whistle's gain at `whistle` (0–100) and its own level in dB. */
const whistleGain = (whistle: number, db: number) =>
  ((WHISTLE_GAIN * dbToGain(db)) / TRIM) * (whistle / 100);

/**
 * Builds `setting`'s graph from `controls` into `into` at whistle `whistle`, and
 * adds it to `live` until it is disposed. A house's room reverb goes to `out`.
 */
function buildSetting(
  ctx: BaseAudioContext,
  into: AudioNode,
  out: AudioNode,
  setting: WindSetting,
  whistle: number,
  controls: Controls,
  live: Set<SettingGraph>,
): SettingGraph {
  return withAudioScope((scope): SettingGraph => {
    const spec = SETTINGS[setting];
    const level = scope.add(new GainNode(ctx, { gain: 0 }));
    controls.level.connect(level.gain);

    spec.bands.forEach(({ centre, q }, i) => {
      const band = slowBiquad(ctx, scope, { type: "bandpass", frequency: centre, Q: q });
      controls.noise.connect(band);
      controls.rise.connect(band.detune);
      controls.swings[i]?.connect(band.detune);
      band.connect(level);
    });

    // Each whistle: a narrow band of the noise (mixed to mono), at the whistle's
    // level, drifting about ±4 dB, then at the body's level again, placed a
    // little off-centre.
    const whistles = spec.whistles.map(({ base, db, pan: place }) => {
      const band = slowBiquad(ctx, scope, {
        type: "bandpass",
        frequency: base,
        Q: WHISTLE_Q,
        ...mono,
      });
      controls.noise.connect(band);
      controls.bend.connect(band.detune);
      const gain = whistleGain(whistle, db);
      const steady = scope.add(new GainNode(ctx, { gain, ...mono }));
      const swing = scope.add(new GainNode(ctx, { gain: gain * WHISTLE_SWING, ...mono }));
      controls.drifts.connect(swing, WHISTLE_DRIFT).connect(steady.gain);
      const rising = scope.add(new GainNode(ctx, { gain: 0, ...mono }));
      controls.level.connect(rising.gain);
      const pan = scope.add(new StereoPannerNode(ctx, { pan: place }));
      band.connect(steady).connect(rising).connect(pan).connect(level);
      return { steady, swing, db };
    });

    if (spec.rustle) {
      const rustle = scope.add(
        new BiquadFilterNode(ctx, { type: "bandpass", frequency: RUSTLE_CENTRE, Q: RUSTLE_Q }),
      );
      const flutter = scope.add(new GainNode(ctx, { gain: 0 }));
      controls.flutter.connect(flutter.gain);
      // The noise's channels swapped, so the leaves don't move with the body.
      const split = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
      const swapped = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      controls.noise.connect(split);
      split.connect(swapped, 0, 1);
      split.connect(swapped, 1, 0);
      swapped.connect(rustle).connect(flutter).connect(level);
    }

    if (spec.lowpass === undefined) {
      level.connect(into);
    } else {
      const lowpass = scope.add(
        new BiquadFilterNode(ctx, { type: "lowpass", frequency: spec.lowpass, Q: BUTTERWORTH_Q }),
      );
      level.connect(lowpass).connect(into);
    }
    if (spec.roomDb !== undefined) {
      // From the crossfader's input, so the send fades with the setting.
      createSend(ctx, scope, into, out, "room", spec.roomDb);
    }

    const graph: SettingGraph = {
      setWhistle(next, when) {
        for (const w of whistles) {
          const gain = whistleGain(next, w.db);
          glide(w.steady.gain, gain, when, GLIDE);
          glide(w.swing.gain, gain * WHISTLE_SWING, when, GLIDE);
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
    live.add(graph);
    scope.defer(() => {
      live.delete(graph);
    });
    return graph;
  });
}

/** A wave shaper with `curve`, reading the sum of `inputs` (each a node and its output). */
function shaper(
  ctx: BaseAudioContext,
  scope: AudioScope,
  inputs: readonly (readonly [AudioNode, number])[],
  curve: Float32Array<ArrayBuffer>,
): WaveShaperNode {
  const node = scope.add(new WaveShaperNode(ctx, { curve, ...mono }));
  for (const [input, output] of inputs) {
    input.connect(node, output);
  }
  return node;
}

/** The gusts' gain at `gustiness` (0–100), on the speed ÷ SPEED_MAX. */
const gustGain = (gustiness: number) => (GUST_DEPTH * gustiness) / 100 / SPEED_MAX;

export const wind = defineSound(windMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      const p = init.params;
      let seed = init.seed;
      let setting = p.setting;

      // The noise and the drifts, each crossfaded on a seed change.
      const noise = scope.add(new GainNode(ctx));
      const drifts = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: DRIFTS.length }));
      const noiseFader = createCrossfader(ctx, scope, noise, FADE);
      const driftFader = createCrossfader(ctx, scope, drifts, FADE);
      const reseed = (next: number) =>
        Promise.all([
          noiseFader.swap((into) => buildNoise(ctx, into, next, absoluteNow(), init.onError)),
          driftFader.swap((into) => buildDrifts(ctx, into, next, absoluteNow(), init.onError)),
        ]);
      await reseed(seed);

      // The speed ÷ SPEED_MAX, summed at each shaper's input: strength +
      // gustiness × gust + the slow trend.
      const strength = scope.addSource(
        new ConstantSourceNode(ctx, { offset: p.strength / 100 / SPEED_MAX }),
      );
      strength.start();
      const gusts = scope.add(new GainNode(ctx, { gain: gustGain(p.gustiness), ...mono }));
      shaper(ctx, scope, [[drifts, GUST]], gustCurve()).connect(gusts);
      const trend = scope.add(new GainNode(ctx, { gain: TREND_SWING / SPEED_MAX, ...mono }));
      drifts.connect(trend, TREND);
      const speed: readonly (readonly [AudioNode, number])[] = [
        [strength, 0],
        [gusts, 0],
        [trend, 0],
      ];

      // The controls the speed drives.
      const level = shaper(ctx, scope, speed, bodyLevelCurve(TRIM));
      const rise = shaper(ctx, scope, speed, colourCurve());
      const bend = shaper(ctx, scope, speed, whistleCurve());
      const swing = (channel: number) => {
        const node = scope.add(new GainNode(ctx, { gain: BAND_SWING_CENTS, ...mono }));
        drifts.connect(node, channel);
        return node;
      };
      const swings = [swing(BAND[0]), swing(BAND[1])] as const;
      const flutter = shaper(ctx, scope, [[drifts, FLUTTER]], flutterCurve(RUSTLE_GAIN));

      const controls: Controls = { noise, drifts, level, rise, swings, bend, flutter };
      const live = new Set<SettingGraph>();
      let whistle = p.whistle;
      const settingFader = createCrossfader(ctx, scope, out, FADE);
      const build = (s: WindSetting) => (into: AudioNode) =>
        buildSetting(ctx, into, out, s, whistle, controls, live);
      await settingFader.swap(build(setting));

      return {
        update(next, when) {
          glide(strength.offset, next.strength / 100 / SPEED_MAX, when, GLIDE);
          glide(gusts.gain, gustGain(next.gustiness), when, GLIDE);
          whistle = next.whistle;
          for (const graph of live) {
            graph.setWhistle(whistle, when);
          }
          if (next.setting !== setting) {
            setting = next.setting;
            settingFader.swap(build(setting)).catch((error: unknown) => {
              init.onError?.(error);
            });
          }
          if (next.seed !== seed) {
            seed = next.seed;
            reseed(seed).catch((error: unknown) => {
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
