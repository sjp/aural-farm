/**
 * Singing Bowls' worklet module: one processor that runs `BowlsKernel` (the
 * whole set of bowls, and rim singing, for one key and seed) on the absolute
 * sample index, reading its params from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { MAX_BOWLS, MAX_INTERVAL, MIN_INTERVAL } from "./bowls.meta";
import { BOWLS_CHANNELS, BOWLS_PROCESSOR, BowlsKernel, readBowlsOptions } from "./bowls-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class BowlsProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Bowls in the set, latched per strike: a bowl left out rings out.
    { name: "bowls", defaultValue: 3, minValue: 1, maxValue: MAX_BOWLS, automationRate: "k-rate" },
    // The average time between strikes, in seconds: re-anchored at the next strike.
    {
      name: "interval",
      defaultValue: 25,
      minValue: MIN_INTERVAL,
      maxValue: MAX_INTERVAL,
      automationRate: "k-rate",
    },
    // Rim singing, off (0) or on (1): faded in or out over 4 s.
    { name: "rub", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: BowlsKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readBowlsOptions(options.processorOptions);
    this.kernel = new BowlsKernel(o.key, o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= BOWLS_CHANNELS) {
      this.kernel.set(parameters.bowls[0], parameters.interval[0], parameters.rub[0] >= 0.5);
      this.kernel.render(channels[0], channels[1], currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(BOWLS_PROCESSOR, BowlsProcessor);
