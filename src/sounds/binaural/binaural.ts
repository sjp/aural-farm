/**
 * Binaural Beats: two pure, steady tones a few hertz apart, one in each ear,
 * heard as one tone with a slow pulse at their difference, over an optional
 * soft bed of pink noise. The isochronic mode instead plays one tone in both
 * ears and swells its level at the beat rate, which works on speakers too.
 *
 * The tones are native oscillators, phase-aligned to absolute time (`createLfo`
 * at audio rate), so the output at a given time depends only on that time and
 * the params. Left and right stay apart all the way out: the binaural tones
 * meet only in a channel merger, with no panning and no reverb. Summed to mono
 * they beat at the beat rate, as two close tones do.
 *
 * A change of Tone or beat glides the frequencies (their phases then no longer
 * follow absolute time, which only matters to a fresh render, and that starts
 * aligned). A change of mode crossfades the tones over 2 s; a seed change
 * crossfades the bed, the only seeded part.
 */
import { BUTTERWORTH_Q } from "../../audio/biquad";
import { createCrossfader } from "../../audio/crossfade";
import { glide } from "../../audio/glide";
import { createLfo } from "../../audio/lfo";
import { createNoise } from "../../audio/noise";
import { withAudioScope, type Disposable } from "../../audio/scope";
import { defineSound, type ParamValues } from "../types";
import {
  bedGain,
  beatOf,
  isochronicLevel,
  pulseGain,
  TONE_LEVEL,
  toneFrequencies,
  wholePeriod,
} from "./binaural-dsp";
import { binauralMeta, type BinauralMode } from "./binaural.meta";

type BinauralParams = ParamValues<typeof binauralMeta.params>;

/** Glide time constants, in seconds: frequencies, and the bed's level. */
const FREQUENCY_GLIDE = 0.5;
const BED_GLIDE = 0.1;
/** Crossfades, in seconds: a change of mode, and of seed. */
const MODE_FADE = 2;
const SEED_FADE = 2;
/**
 * The bed's band, in Hz: a low-pass for softness, with nothing hissing above
 * it, and a high-pass to keep pink noise's deepest rumble out of the headroom.
 */
const BED_LOWPASS = 4000;
const BED_HIGHPASS = 50;

interface Tones extends Disposable {
  update: (params: BinauralParams, when: number) => void;
}

/** Two tones, `beat` apart, one per ear, each only in its own channel. */
function buildBinaural(
  ctx: BaseAudioContext,
  into: AudioNode,
  params: BinauralParams,
  startAt: number,
): Tones {
  return withAudioScope((scope): Tones => {
    const { left, right } = toneFrequencies(params.carrier, beatOf(params.preset, params.beat));
    const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    merger.connect(into);
    const tone = (frequency: number, channel: number) => {
      const osc = createLfo(ctx, scope, { frequency, startAt });
      const level = scope.add(new GainNode(ctx, { gain: TONE_LEVEL }));
      osc.connect(level).connect(merger, 0, channel);
      return osc;
    };
    const leftTone = tone(left, 0);
    const rightTone = tone(right, 1);
    return {
      update(next, when) {
        const f = toneFrequencies(next.carrier, beatOf(next.preset, next.beat));
        glide(leftTone.frequency, f.left, when, FREQUENCY_GLIDE);
        glide(rightTone.frequency, f.right, when, FREQUENCY_GLIDE);
      },
      dispose: () => {
        scope.dispose();
      },
    };
  });
}

/** One tone in both ears, its level swelling at the beat rate. */
function buildIsochronic(
  ctx: BaseAudioContext,
  into: AudioNode,
  params: BinauralParams,
  startAt: number,
): Tones {
  return withAudioScope((scope): Tones => {
    const merger = scope.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    merger.connect(into);
    const osc = createLfo(ctx, scope, { frequency: params.carrier, startAt });
    const { wave, base } = pulseGain();
    const pulse = scope.add(new GainNode(ctx, { gain: base }));
    const rate = createLfo(ctx, scope, {
      frequency: beatOf(params.preset, params.beat),
      wave,
      startAt,
    });
    rate.connect(pulse.gain);
    const level = scope.add(new GainNode(ctx, { gain: isochronicLevel() }));
    osc.connect(pulse).connect(level);
    level.connect(merger, 0, 0);
    level.connect(merger, 0, 1);
    return {
      update(next, when) {
        glide(osc.frequency, next.carrier, when, FREQUENCY_GLIDE);
        glide(rate.frequency, beatOf(next.preset, next.beat), when, FREQUENCY_GLIDE);
      },
      dispose: () => {
        scope.dispose();
      },
    };
  });
}

const BUILDERS: Readonly<Record<BinauralMode, typeof buildBinaural>> = {
  binaural: buildBinaural,
  isochronic: buildIsochronic,
};

export const binaural = defineSound(binauralMeta, {
  create(ctx, out, init) {
    return withAudioScope(async (scope) => {
      // Absolute time is `startAt` at the context time `create` runs.
      const offset = init.startAt - ctx.currentTime;
      const absoluteNow = () => ctx.currentTime + offset;
      let params = init.params;

      // The tones, crossfading on a change of mode.
      const live = new Set<Tones>();
      const tones = createCrossfader(ctx, scope, out, MODE_FADE);
      const build = (mode: BinauralMode) => (into: AudioNode) => {
        const graph = BUILDERS[mode](ctx, into, params, absoluteNow());
        live.add(graph);
        return {
          dispose: () => {
            live.delete(graph);
            graph.dispose();
          },
        };
      };
      let mode = params.mode;
      await tones.swap(build(mode));

      // The bed: stereo pink noise, band-passed, crossfading on a seed change.
      const bed = scope.add(new GainNode(ctx, { gain: bedGain(params.bed) }));
      bed.connect(out);
      const lowpass = scope.add(
        new BiquadFilterNode(ctx, { type: "lowpass", frequency: BED_LOWPASS, Q: BUTTERWORTH_Q }),
      );
      const highpass = scope.add(
        new BiquadFilterNode(ctx, { type: "highpass", frequency: BED_HIGHPASS, Q: BUTTERWORTH_Q }),
      );
      lowpass.connect(highpass).connect(bed);
      const noise = (seed: number) => (into: AudioNode) =>
        withAudioScope(async (bedScope) => {
          const source = await createNoise(ctx, bedScope, {
            colour: "pink",
            seed,
            stream: 1,
            channels: 2,
            startAt: absoluteNow(),
          });
          source.connect(into);
          return {
            dispose: () => {
              bedScope.dispose();
            },
          };
        }, init.onError);
      const beds = createCrossfader(ctx, scope, lowpass, SEED_FADE);
      let seed = init.seed;
      await beds.swap(noise(seed));

      return {
        update(next, when) {
          params = next;
          glide(bed.gain, bedGain(next.bed), when, BED_GLIDE);
          for (const graph of live) {
            graph.update(next, when);
          }
          if (next.mode !== mode) {
            mode = next.mode;
            tones.swap(build(mode)).catch((error: unknown) => {
              init.onError?.(error);
            });
          }
          if (next.seed !== seed) {
            seed = next.seed;
            beds.swap(noise(seed)).catch((error: unknown) => {
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
  loopPeriod: (params) => {
    const beat = beatOf(params.preset, params.beat);
    if (params.mode === "isochronic") {
      return wholePeriod([params.carrier, beat]);
    }
    const { left, right } = toneFrequencies(params.carrier, beat);
    return wholePeriod([left, right]);
  },
});
