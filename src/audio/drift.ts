/**
 * Smooth random modulation for sounds: the shared drift processor, an audio-rate
 * signal in [−1, 1] to scale with a `GainNode` into any `AudioParam`.
 *
 *   const drift = await createDrift(ctx, scope, {
 *     seed: init.seed, stream: 3, rate: 0.05, octaves: 2, startAt: init.startAt,
 *   });
 *   const depth = scope.add(new GainNode(ctx, { gain: 6 }));   // ±6 cents
 *   drift.connect(depth).connect(osc.detune);
 */
import { DRIFT_PROCESSOR, type DriftOptions } from "./drift-dsp";
import type { AudioScope } from "./scope";
import { startWorkletNode } from "./shared-worklet";

interface CreateDriftOptions {
  seed: number;
  /** This drift's stream: give each random source in a sound its own. */
  stream: number;
  /** Knots per second of the slowest octave; the motion's rough rate in Hz. */
  rate: number;
  /** 1–3: each adds faster, shallower motion. */
  octaves: number;
  /** The sound's `init.startAt`: the absolute time the context's current time stands for. */
  startAt: number;
}

/**
 * A mono drift signal in [−1, 1]: value noise of absolute time, so it is
 * time-addressable. The node is registered with `scope`.
 */
export async function createDrift(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: CreateDriftOptions,
): Promise<AudioNode> {
  const processorOptions: Omit<DriftOptions, "offset"> = {
    seed: options.seed,
    stream: options.stream,
    rate: options.rate,
    octaves: options.octaves,
  };
  return startWorkletNode(ctx, scope, DRIFT_PROCESSOR, 1, options.startAt, processorOptions);
}
