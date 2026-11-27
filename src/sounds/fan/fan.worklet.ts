/**
 * Fan's worklet module: one processor that runs `FanKernel` (the air of one
 * kind of fan) on the absolute sample index, reading Speed, Tone and how far
 * it oscillates from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { FAN_CHANNELS, FAN_PROCESSOR, FanKernel, readFanOptions } from "./fan-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class FanProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Speed and Tone, each 0–100.
    { name: "speed", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "tone", defaultValue: 40, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // How far the fan oscillates: 0 still, 1 the full sweep.
    { name: "oscillate", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: FanKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readFanOptions(options.processorOptions);
    this.kernel = new FanKernel(o.type, o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= FAN_CHANNELS) {
      this.kernel.set(parameters.speed[0], parameters.tone[0], parameters.oscillate[0]);
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(FAN_PROCESSOR, FanProcessor);
