/**
 * Smooth random modulation for sounds: the shared drift processor, an audio-rate
 * signal in [−1, 1] to scale with a `GainNode` into any `AudioParam`.
 *
 *   const drift = await createDrift(ctx, scope, {
 *     seed: init.seed, stream: 3, rate: 0.05, octaves: 2, startAt: init.startAt,
 *   });
 *   const depth = scope.add(new GainNode(ctx, { gain: 6 }));   // ±6 cents
 *   drift.connect(depth).connect(osc.detune);
 *
 * A sound with several drifts can run them all in one node, one per channel,
 * with `createDrifts`: each worklet node has a fixed cost, so this is cheaper
 * than a node per drift.
 */
import { DRIFT_PROCESSOR, type DriftOptions, type DriftSpec } from "./drift-dsp";
import type { AudioScope } from "./scope";
import { startWorkletNode } from "./shared-worklet";

interface CreateDriftOptions extends DriftSpec {
  seed: number;
  /** The sound's `init.startAt`: the absolute time the context's current time stands for. */
  startAt: number;
}

interface CreateDriftsOptions {
  seed: number;
  /**
   * One drift per output channel: each with its own stream (give each random
   * source in a sound its own), rate (knots per second of the slowest octave, the
   * motion's rough rate in Hz) and octaves (1–3: each adds faster, shallower
   * motion).
   */
  drifts: readonly DriftSpec[];
  /** The sound's `init.startAt`: the absolute time the context's current time stands for. */
  startAt: number;
}

/**
 * A node with one drift signal in [−1, 1] per channel, in the order given: value
 * noise of absolute time, so it is time-addressable. Split it with a
 * `ChannelSplitterNode`. The node is registered with `scope`.
 */
export async function createDrifts(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: CreateDriftsOptions,
): Promise<AudioNode> {
  const processorOptions: Omit<DriftOptions, "offset"> = {
    seed: options.seed,
    drifts: options.drifts.map(({ stream, rate, octaves }) => ({ stream, rate, octaves })),
  };
  return startWorkletNode(
    ctx,
    scope,
    DRIFT_PROCESSOR,
    options.drifts.length,
    options.startAt,
    processorOptions,
  );
}

/** A mono drift signal: `createDrifts` with a single drift. */
export async function createDrift(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: CreateDriftOptions,
): Promise<AudioNode> {
  const { seed, stream, rate, octaves, startAt } = options;
  return createDrifts(ctx, scope, { seed, drifts: [{ stream, rate, octaves }], startAt });
}
