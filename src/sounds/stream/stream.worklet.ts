/**
 * Stream's worklet module: one processor that runs `StreamGenerator` (the
 * rush's noise under its swell, and the bubbles) on the absolute sample index,
 * reading the flow, size and the bubbles' level from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { readStreamOptions, STREAM_PROCESSOR, StreamGenerator } from "./stream-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class StreamProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // The flow, 0–100: the clusters' rate latches per block, the bubbles' gain per bubble.
    { name: "flow", defaultValue: 45, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // The size, 0–100, read as each bubble starts.
    { name: "size", defaultValue: 30, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // The bubbles' gain, read as each bubble starts.
    { name: "level", defaultValue: 1, minValue: 0, maxValue: 4, automationRate: "k-rate" },
  ] as const;

  private readonly generator: StreamGenerator;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readStreamOptions(options.processorOptions);
    this.generator = new StreamGenerator(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    this.generator.set(parameters.flow[0], parameters.size[0], parameters.level[0]);
    this.generator.render(outputs[0] ?? [], currentFrame + this.offset);
    return !this.stopped;
  }
}

registerProcessor(STREAM_PROCESSOR, StreamProcessor);
