/**
 * Distant City's worklet module: one processor that runs `CityKernel` (the
 * whole city for one seed) on the absolute sample index, reading its params
 * from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { CITY_CHANNELS, CITY_PROCESSOR, CityKernel, readCityOptions } from "./city-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class CityProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // 1 by day, 0 at night: the rumble glides to it, the cars' rate latches per block.
    { name: "day", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    // Traffic and Rumble, 0–100.
    { name: "traffic", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "rumble", defaultValue: 60, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // Far signals per second, latched per block.
    { name: "signals", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: CityKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readCityOptions(options.processorOptions);
    this.kernel = new CityKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= CITY_CHANNELS) {
      this.kernel.set(
        parameters.day[0],
        parameters.traffic[0],
        parameters.rumble[0],
        parameters.signals[0],
      );
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(CITY_PROCESSOR, CityProcessor);
