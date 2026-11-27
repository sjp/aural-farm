/**
 * Fireplace's worklet module: one processor that runs `FireplaceGenerator`
 * (the roar's noise under its flicker, the band's drift, and the crackles,
 * pops, hisses and shifts) on the absolute sample index, reading the fire's
 * size, crackle and wood from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { FIREPLACE_PROCESSOR, FireplaceGenerator, readFireplaceOptions } from "./fireplace-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class FireplaceProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // The fire's size and crackle, 0–100: rates latch per block, levels per event.
    { name: "size", defaultValue: 55, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "crackle", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // 1 for softwood, 0 for hardwood.
    { name: "softwood", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly generator: FireplaceGenerator;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readFireplaceOptions(options.processorOptions);
    this.generator = new FireplaceGenerator(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    this.generator.set(parameters.size[0], parameters.crackle[0], parameters.softwood[0] >= 0.5);
    this.generator.render(outputs[0] ?? [], currentFrame + this.offset);
    return !this.stopped;
  }
}

registerProcessor(FIREPLACE_PROCESSOR, FireplaceProcessor);
