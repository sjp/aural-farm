/**
 * Night Insects' worklet module: one processor that runs `InsectsGenerator`
 * (the crickets, the katydids and the chorus over its bed) on the absolute
 * sample index, reading the count, warmth, distance and the katydids' level
 * from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  INSECTS_CHANNELS,
  INSECTS_PROCESSOR,
  InsectsGenerator,
  readInsectsOptions,
} from "./insects-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class InsectsProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // How many crickets sing, 1–12: each fades in or out over a second.
    { name: "count", defaultValue: 5, minValue: 0, maxValue: 12, automationRate: "k-rate" },
    // The warmth in °C, latched per chirp.
    { name: "warmth", defaultValue: 20, minValue: 12, maxValue: 28, automationRate: "k-rate" },
    // The distance, 0–100: latched per chirp and rasp, followed by the chorus.
    { name: "distance", defaultValue: 40, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // The katydids' level, 0–1.
    { name: "katydids", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly generator: InsectsGenerator;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readInsectsOptions(options.processorOptions);
    this.generator = new InsectsGenerator(o.seed, o.warmth, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= INSECTS_CHANNELS) {
      const [left, right] = channels;
      this.generator.set(
        parameters.count[0],
        parameters.warmth[0],
        parameters.distance[0],
        parameters.katydids[0],
      );
      this.generator.render(left, right, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(INSECTS_PROCESSOR, InsectsProcessor);
