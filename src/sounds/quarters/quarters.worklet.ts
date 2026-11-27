/**
 * Crew Quarters' worklet module: one processor that runs `QuartersKernel`
 * (the ventilation and hull, and the engine's drifts) on the absolute sample
 * index, reading Ventilation, Hull and Warmth from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  QUARTERS_CHANNELS,
  QUARTERS_PROCESSOR,
  QuartersKernel,
  readQuartersOptions,
} from "./quarters-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class QuartersProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Ventilation, Hull and Warmth, each 0–100.
    { name: "air", defaultValue: 60, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "hull", defaultValue: 40, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "warmth", defaultValue: 60, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: QuartersKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readQuartersOptions(options.processorOptions);
    this.kernel = new QuartersKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= QUARTERS_CHANNELS) {
      this.kernel.set(parameters.air[0], parameters.hull[0], parameters.warmth[0]);
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(QUARTERS_PROCESSOR, QuartersProcessor);
