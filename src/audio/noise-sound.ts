/**
 * The noise colour sounds (white, pink, brown and grey): one implementation that
 * each colour's sound wraps with its own metadata.
 *
 * Per variation (seed), the graph is:
 *
 *   noise (stereo, decorrelated) → shaping filters → splitter
 *     → width matrix → per channel: tilt shelf → level → merger → out
 *
 * and a slow drift per channel moves that channel's tilt and level a little, so
 * the stereo image breathes. A seed change crossfades to a fresh variation.
 *
 * Biquads are the costliest nodes here, so the tone tilt uses one per channel: a
 * high shelf at 1 kHz of twice the tilt, with the level lowered by the tilt. That
 * turns the lows down and the highs up by the same amount around 1 kHz, as a
 * low and a high shelf moving in opposite directions would.
 */
import type { NumberParam, ParamValues, SoundDefinition, SoundMeta } from "../sounds/types";
import { defineSound } from "../sounds/types";
import { BUTTERWORTH_Q, type BiquadSpec } from "./biquad";
import { createCrossfader } from "./crossfade";
import { createDrift } from "./drift";
import { dbToGain, glide } from "./glide";
import { createNoise } from "./noise";
import type { NoiseColour } from "./noise-dsp";
import { withAudioScope, type Disposable } from "./scope";

export type NoiseSoundColour = "white" | "pink" | "brown" | "grey";

/** The params every noise colour has. */
type NoiseSchema = Readonly<Record<"tone" | "width" | "movement" | "seed", NumberParam>>;
type NoiseParams = ParamValues<NoiseSchema>;

/** The shared noise source each colour starts from: grey is shaped pink. */
const SOURCE: Readonly<Record<NoiseSoundColour, NoiseColour>> = {
  white: "white",
  pink: "pink",
  brown: "brown",
  grey: "pink",
};

/**
 * Grey noise's shaping: a gentle approximation of the inverse of the 40-phon
 * equal-loudness contour, applied to pink noise. The ear is least sensitive at
 * the bottom and very top and most sensitive around 3–4 kHz, so the lows get a
 * broad lift, the presence region a dip and the top octave a small lift. The
 * real inverse contour climbs far more steeply below 100 Hz; following it would
 * turn grey into a rumble, so the low shelf stops at +10 dB.
 */
export const GREY_EQ: readonly BiquadSpec[] = [
  { type: "lowshelf", frequency: 150, gain: 10 },
  { type: "peaking", frequency: 3500, gain: -6, Q: 1 },
  { type: "highshelf", frequency: 10000, gain: 4 },
];

/** A high-pass at 30 Hz, below what speakers play and where the master cuts anyway. */
const SUB_CUT: BiquadSpec = { type: "highpass", frequency: 30, Q: BUTTERWORTH_Q };

/**
 * Fixed filters per colour: a low-pass at 12 kHz that keeps white from being
 * piercing; for brown, and for grey ahead of its equal-loudness shaping, a cut
 * below 30 Hz, so the deepest rumble (which the low shelf lifts 10 dB in grey)
 * doesn't eat the headroom.
 */
export const SHAPING: Readonly<Record<NoiseSoundColour, readonly BiquadSpec[]>> = {
  white: [{ type: "lowpass", frequency: 12000, Q: BUTTERWORTH_Q }],
  pink: [],
  brown: [SUB_CUT],
  grey: [SUB_CUT, ...GREY_EQ],
};

/**
 * Each colour's level trim, in dB, from the source's −12 dBFS RMS to about −23
 * LUFS at default params. K-weighting all but ignores the lows, so brown needs
 * far more gain than white for the same loudness.
 */
export const LEVEL_DB: Readonly<Record<NoiseSoundColour, number>> = {
  white: -13.9,
  pink: -13.6,
  brown: -9.5,
  grey: -15.7,
};

/** The tilt's pivot: its shelf's frequency, in Hz. */
export const TILT_PIVOT = 1000;
/** The tilt at tone ±100: how far the lows go down and the highs up, in dB. */
const TILT_RANGE_DB = 6;
/**
 * How far the drift moves the tilt and the level at full movement, in dB. Both
 * together leave the lows where they are and move the highs twice as far, so the
 * drift only needs to move the tilt shelf.
 */
const MOVEMENT_DB = 1.5;
/** The drift's rate (Hz) and octaves. */
const DRIFT_RATE = 0.03;
const DRIFT_OCTAVES = 2;
/** Streams: the noise, then the left and right channels' drifts. */
const NOISE_STREAM = 1;
const DRIFT_STREAM = 2;
/** Time constants: width (a level change) and timbre. */
const GAIN_GLIDE = 0.08;
const TIMBRE_GLIDE = 0.5;
/** A seed change's crossfade, in seconds. */
const SEED_FADE = 2;

/** The tilt for `tone` (−100 to 100): the highs' change in dB, and minus the lows'. */
export function tiltDb(tone: number): number {
  return (tone / 100) * TILT_RANGE_DB;
}

/**
 * The tilt shelf's gain (dB) and the level's (linear, before the trim) for a
 * tilt of `db`.
 */
export function tiltGains(db: number): { shelf: number; level: number } {
  return { shelf: 2 * db, level: dbToGain(-db) };
}

/**
 * The width matrix for `width` (0–100 %): each output channel is `direct` of its
 * own channel plus `cross` of the other. At 100 % the channels pass unchanged; at
 * 0 % both carry the mono sum. Decorrelated channels sum to a mono signal about
 * 3 dB quieter than either, so the matrix is scaled to keep each channel's power
 * constant: direct² + cross² = 1.
 */
export function widthGains(width: number): { direct: number; cross: number } {
  const w = Math.min(1, Math.max(0, width / 100));
  const scale = Math.SQRT2 / Math.sqrt(1 + w * w);
  return { direct: (scale * (1 + w)) / 2, cross: (scale * (1 - w)) / 2 };
}

/** The drift's depth on the tilt shelf's gain, in dB, for `movement` (0–100 %). */
function driftDepth(movement: number): number {
  return 2 * MOVEMENT_DB * Math.min(1, Math.max(0, movement / 100));
}

interface Variation extends Disposable {
  update: (params: NoiseParams, when: number) => void;
}

/**
 * Builds one variation of `colour` into `into`. `absoluteNow` gives the absolute
 * time the context's current time stands for; `params` the latest params.
 */
function buildVariation(
  ctx: BaseAudioContext,
  into: AudioNode,
  colour: NoiseSoundColour,
  seed: number,
  absoluteNow: () => number,
  params: () => NoiseParams,
  onError: ((error: unknown) => void) | undefined,
): Promise<Variation> {
  return withAudioScope(async (scope): Promise<Variation> => {
    const noise = await createNoise(ctx, scope, {
      colour: SOURCE[colour],
      seed,
      stream: NOISE_STREAM,
      channels: 2,
      startAt: absoluteNow(),
    });
    const drifts: AudioNode[] = [];
    for (const channel of [0, 1]) {
      drifts.push(
        await createDrift(ctx, scope, {
          seed,
          stream: DRIFT_STREAM + channel,
          rate: DRIFT_RATE,
          octaves: DRIFT_OCTAVES,
          startAt: absoluteNow(),
        }),
      );
    }

    // Built after the awaits, so a change made meanwhile is already in.
    const p = params();
    let shaped: AudioNode = noise;
    for (const spec of SHAPING[colour]) {
      const filter = scope.add(new BiquadFilterNode(ctx, spec));
      shaped.connect(filter);
      shaped = filter;
    }
    const splitter = scope.add(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
    shaped.connect(splitter);
    const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));

    const trim = dbToGain(LEVEL_DB[colour]);
    const width = widthGains(p.width);
    const tilt = tiltGains(tiltDb(p.tone));
    const depth = driftDepth(p.movement);
    const channels = drifts.map((drift, channel) => {
      const own = scope.add(new GainNode(ctx, { gain: width.direct }));
      const other = scope.add(new GainNode(ctx, { gain: width.cross }));
      splitter.connect(own, channel);
      splitter.connect(other, 1 - channel);
      const shelf = scope.add(
        new BiquadFilterNode(ctx, { type: "highshelf", frequency: TILT_PIVOT, gain: tilt.shelf }),
      );
      // The drift and the glides move the shelf slowly: once per render quantum is
      // plenty, and spares it recomputing its coefficients every sample.
      shelf.gain.automationRate = "k-rate";
      const level = scope.add(new GainNode(ctx, { gain: trim * tilt.level }));
      own.connect(shelf);
      other.connect(shelf);
      shelf.connect(level).connect(merger, 0, channel);

      // The drift brightens and lifts together, darkens and dips together.
      const drifting = scope.add(new GainNode(ctx, { gain: depth }));
      drift.connect(drifting).connect(shelf.gain);
      return { own, other, shelf, level, drifting };
    });
    merger.connect(into);

    return {
      update(next, when) {
        const w = widthGains(next.width);
        const t = tiltGains(tiltDb(next.tone));
        const d = driftDepth(next.movement);
        for (const c of channels) {
          glide(c.own.gain, w.direct, when, GAIN_GLIDE);
          glide(c.other.gain, w.cross, when, GAIN_GLIDE);
          glide(c.shelf.gain, t.shelf, when, TIMBRE_GLIDE);
          glide(c.level.gain, trim * t.level, when, TIMBRE_GLIDE);
          glide(c.drifting.gain, d, when, TIMBRE_GLIDE);
        }
      },
      dispose: () => {
        scope.dispose();
      },
    };
  }, onError);
}

/** A noise colour's sound, from its metadata. */
export function defineNoiseSound(
  meta: SoundMeta<NoiseSchema>,
  colour: NoiseSoundColour,
): SoundDefinition {
  return defineSound(meta, {
    create(ctx, out, init) {
      return withAudioScope(async (scope) => {
        // Absolute time is `startAt` at the context time `create` runs.
        const offset = init.startAt - ctx.currentTime;
        const absoluteNow = () => ctx.currentTime + offset;
        let params = init.params;
        let seed = init.seed;
        const live = new Set<Variation>();
        const fader = createCrossfader(ctx, scope, out, SEED_FADE);
        const variation =
          (variationSeed: number) =>
          async (into: AudioNode): Promise<Disposable> => {
            const built = await buildVariation(
              ctx,
              into,
              colour,
              variationSeed,
              absoluteNow,
              () => params,
              init.onError,
            );
            live.add(built);
            return {
              dispose: () => {
                live.delete(built);
                built.dispose();
              },
            };
          };
        await fader.swap(variation(seed));
        return {
          update(next, when) {
            params = next;
            for (const built of live) {
              built.update(next, when);
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
}
