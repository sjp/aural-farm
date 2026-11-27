/**
 * Distant Thunder's worklet module: one processor that runs `ThunderKernel` on
 * the absolute sample index, reading the mean gap, distance and roll from
 * k-rate AudioParams. Between rumbles it only checks the time.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  readThunderOptions,
  THUNDER_CHANNELS,
  THUNDER_PROCESSOR,
  ThunderKernel,
} from "./thunder-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class ThunderProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // The mean gap between rumbles, in seconds, latched per block.
    { name: "gap", defaultValue: 180, minValue: 1, maxValue: 3600, automationRate: "k-rate" },
    // Distance (0 far, 100 near) and roll, 0–100, latched per rumble.
    { name: "distance", defaultValue: 15, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "roll", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: ThunderKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readThunderOptions(options.processorOptions);
    this.kernel = new ThunderKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const output = outputs[0] ?? [];
    if (output.length >= THUNDER_CHANNELS) {
      this.kernel.set(parameters.gap[0], parameters.distance[0], parameters.roll[0]);
      this.kernel.render(output[0], output[1], currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(THUNDER_PROCESSOR, ThunderProcessor);
