/**
 * Birdsong's worklet module: one processor that runs `BirdsongGenerator` (the
 * birds, dry and to the reverb, over the air) on the absolute sample index,
 * reading the time of day, Activity and Distance from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  BIRDSONG_CHANNELS,
  BIRDSONG_PROCESSOR,
  BirdsongGenerator,
  readBirdsongOptions,
} from "./birdsong-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class BirdsongProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // The time of day: 0 dawn chorus, 1 morning, 2 daytime. Latched per phrase.
    { name: "time", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
    // The Activity, 0–100. Latched per phrase.
    { name: "density", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // The Distance, 0–100. Latched per syllable.
    { name: "distance", defaultValue: 40, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly generator: BirdsongGenerator;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readBirdsongOptions(options.processorOptions);
    this.generator = new BirdsongGenerator(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= BIRDSONG_CHANNELS) {
      const [dryLeft, dryRight, wetLeft, wetRight] = channels;
      this.generator.set(parameters.time[0], parameters.density[0], parameters.distance[0]);
      this.generator.render(dryLeft, dryRight, wetLeft, wetRight, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(BIRDSONG_PROCESSOR, BirdsongProcessor);
