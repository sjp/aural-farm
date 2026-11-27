/**
 * Drone Pad's worklet module: one processor that runs `DroneKernel` (both
 * groups of voices, their crossfades and the filter, for one key and seed) on
 * the absolute sample index, reading its params from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { DRONE_CHANNELS, DRONE_PROCESSOR, DroneKernel, readDroneOptions } from "./drone-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class DroneProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // The low-pass's cutoff, 0–100: glided on the main thread.
    { name: "brightness", defaultValue: 35, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // The slot period, from the next slot, and the drift depth, sliding there.
    { name: "movement", defaultValue: 40, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: DroneKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readDroneOptions(options.processorOptions);
    this.kernel = new DroneKernel(o.key, o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= DRONE_CHANNELS) {
      this.kernel.set(parameters.brightness[0], parameters.movement[0]);
      this.kernel.render(channels[0], channels[1], currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(DRONE_PROCESSOR, DroneProcessor);
