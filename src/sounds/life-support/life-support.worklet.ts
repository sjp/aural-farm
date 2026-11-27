/**
 * Life Support's worklet module: one processor that runs `LifeSupportKernel`
 * (the air, the surge, the valves and the pump's drift) on the absolute
 * sample index, reading Air flow and the valves' rate from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  LIFE_SUPPORT_CHANNELS,
  LIFE_SUPPORT_PROCESSOR,
  LifeSupportKernel,
  readLifeSupportOptions,
} from "./life-support-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class LifeSupportProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Air flow, 0–100.
    { name: "flow", defaultValue: 60, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // Valve releases a second, latched each second of absolute time.
    { name: "rate", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: LifeSupportKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readLifeSupportOptions(options.processorOptions);
    this.kernel = new LifeSupportKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= LIFE_SUPPORT_CHANNELS) {
      this.kernel.set(parameters.flow[0], parameters.rate[0]);
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(LIFE_SUPPORT_PROCESSOR, LifeSupportProcessor);
