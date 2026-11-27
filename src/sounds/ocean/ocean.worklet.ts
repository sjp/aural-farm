/**
 * Ocean Waves' worklet module: one processor that runs `OceanGenerator` (the
 * bed's and the water's noise under the waves' envelopes, and the controls the
 * native graph follows) on the absolute sample index, reading the wave period
 * and the wave size and distance from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { OCEAN_PROCESSOR, OceanGenerator, readOceanOptions } from "./ocean-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class OceanProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Seconds between waves on average; a change applies from the next wave.
    { name: "period", defaultValue: 10, minValue: 1, maxValue: 60, automationRate: "k-rate" },
    // Wave size and distance, 0–100, read once per block.
    { name: "size", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "distance", defaultValue: 0, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly generator: OceanGenerator;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readOceanOptions(options.processorOptions);
    this.generator = new OceanGenerator(o.seed, o.shore, o.period, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const start = currentFrame + this.offset;
    this.generator.setPeriod(parameters.period[0], start);
    this.generator.setShape(parameters.size[0], parameters.distance[0]);
    this.generator.render(outputs[0] ?? [], start);
    return !this.stopped;
  }
}

registerProcessor(OCEAN_PROCESSOR, OceanProcessor);
