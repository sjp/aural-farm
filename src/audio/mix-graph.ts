/**
 * The parts of a mix's audio graph that the live engine and offline renders
 * share, so both play a mix the same way: the volume curve, a layer's params as
 * its sound takes them, and the master chain.
 *
 *   master level → mute → fade → high-pass 25 Hz → limiter → trim −1 dB → output
 */
import type { Layer } from "../mixes/mix";
import { coerce } from "../sounds/params";
import type { ParamValues, SoundDefinition } from "../sounds/types";

const HIGHPASS_HZ = 25;
const HIGHPASS_Q = 0.7;
const TRIM_DB = -1;

/** A perceptual volume curve: 0–100 to a gain of 0–1. */
export const volumeGain = (volume: number) => (volume / 100) ** 2;

/** A layer's gain: its volume, or 0 while muted. */
export const layerGain = (layer: Layer) => (layer.muted ? 0 : volumeGain(layer.volume));

/** The layer's params, coerced against the sound's own schema. */
export function soundParams(definition: SoundDefinition, values: ParamValues): ParamValues {
  const params: ParamValues = {};
  for (const [key, def] of Object.entries(definition.params)) {
    params[key] = coerce(def, values[key]);
  }
  return params;
}

/** A sound's seed: its `seed` param, or 0 for a sound without one. */
export const seedOf = (params: ParamValues) => (typeof params.seed === "number" ? params.seed : 0);

export interface MasterChain {
  /** Where layers and reverb returns connect: the master volume. */
  level: GainNode;
  /** Muting everything. */
  mute: GainNode;
  /** Play and pause fades. */
  fade: GainNode;
  /** The safety limiter, for reading its gain reduction. */
  limiter: DynamicsCompressorNode;
  /** The chain's last node, to connect to the speakers or a render's destination. */
  output: GainNode;
}

/**
 * Builds the master chain in `ctx`, with every gain at 1 and nothing connected to
 * its output. The limiter is a safety net: default mixes should hardly touch it.
 */
export function createMasterChain(ctx: BaseAudioContext): MasterChain {
  const level = ctx.createGain();
  const mute = ctx.createGain();
  const fade = ctx.createGain();
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = HIGHPASS_HZ;
  highpass.Q.value = HIGHPASS_Q;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const output = ctx.createGain();
  output.gain.value = 10 ** (TRIM_DB / 20);
  level.connect(mute).connect(fade).connect(highpass).connect(limiter).connect(output);
  return { level, mute, fade, limiter, output };
}
