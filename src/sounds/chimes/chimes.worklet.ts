/**
 * Wind Chimes' worklet module: one processor that runs `ChimesKernel` (the
 * whole set of tubes for one tuning and seed) on the absolute sample index,
 * reading its params from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { MAX_TUBES, MIN_TUBES } from "./chimes.meta";
import { CHIMES_CHANNELS, CHIMES_PROCESSOR, ChimesKernel, readChimesOptions } from "./chimes-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class ChimesProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Tubes in the set, latched per strike: a tube left out rings out.
    {
      name: "tubes",
      defaultValue: 5,
      minValue: MIN_TUBES,
      maxValue: MAX_TUBES,
      automationRate: "k-rate",
    },
    // Wind, 0–100: how often the gusts strike, latched per strike.
    { name: "wind", defaultValue: 35, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: ChimesKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readChimesOptions(options.processorOptions);
    this.kernel = new ChimesKernel(o.tuning, o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= CHIMES_CHANNELS) {
      this.kernel.set(parameters.tubes[0], parameters.wind[0]);
      this.kernel.render(channels[0], channels[1], currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(CHIMES_PROCESSOR, ChimesProcessor);
