/**
 * Noise sources for sounds: the shared noise processor from the shared worklet
 * module, loaded once per context.
 *
 *   const noise = await createNoise(ctx, scope, {
 *     colour: "pink", seed: init.seed, stream: 1, channels: 2, startAt: init.startAt,
 *   });
 *   noise.connect(filter);
 */
import type { AudioScope } from "./scope";
import { NOISE_PROCESSOR, type NoiseColour, type NoiseOptions } from "./noise-dsp";
import { startWorkletNode } from "./shared-worklet";

interface CreateNoiseOptions {
  colour: NoiseColour;
  seed: number;
  /** This source's stream: give each noise in a sound its own. */
  stream: number;
  /** 1 (mono) or 2 (decorrelated stereo). */
  channels: 1 | 2;
  /** The sound's `init.startAt`: the absolute time the context's current time stands for. */
  startAt: number;
}

/**
 * A noise source at −12 dBFS RMS whatever its colour. Sample n is a hash of the
 * seed, stream, channel and absolute sample index, so the noise is
 * time-addressable. The node is registered with `scope`.
 */
export async function createNoise(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: CreateNoiseOptions,
): Promise<AudioNode> {
  const processorOptions: Omit<NoiseOptions, "offset"> = {
    colour: options.colour,
    seed: options.seed,
    stream: options.stream,
    channels: options.channels,
  };
  return startWorkletNode(
    ctx,
    scope,
    NOISE_PROCESSOR,
    options.channels,
    options.startAt,
    processorOptions,
  );
}
