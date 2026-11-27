/**
 * Airplane Cabin's worklet module: one processor that runs `AirplaneKernel`
 * (the rumble, the vent, the chime and the engines' wander) on the absolute
 * sample index, reading the seat's low-pass, Air vent and the chime rate from
 * k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  AIRPLANE_CHANNELS,
  AIRPLANE_PROCESSOR,
  AirplaneKernel,
  readAirplaneOptions,
} from "./airplane-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class AirplaneProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // The rumble's low-pass, as a multiple of its own: the seat.
    { name: "lowpass", defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: "k-rate" },
    // Air vent, 0–100.
    { name: "vent", defaultValue: 35, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // Chimes per second, latched as each block of absolute time begins.
    { name: "chime", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: AirplaneKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readAirplaneOptions(options.processorOptions);
    this.kernel = new AirplaneKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= AIRPLANE_CHANNELS) {
      this.kernel.set(parameters.lowpass[0], parameters.vent[0], parameters.chime[0]);
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(AIRPLANE_PROCESSOR, AirplaneProcessor);
