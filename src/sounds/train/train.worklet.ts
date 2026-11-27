/**
 * Train Carriage's worklet module: one processor that runs `TrainKernel` (the
 * rumble, the clacks, thumps and rattles, and the sway) on the absolute sample
 * index, reading Speed, the track, Clacks and the rattles' rate from k-rate
 * AudioParams. The kernel glides the speed and crossfades the track itself.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { readTrainOptions, TRAIN_CHANNELS, TRAIN_PROCESSOR, TrainKernel } from "./train-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class TrainProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Speed, in km/h: the kernel glides to it.
    { name: "speed", defaultValue: 90, minValue: 40, maxValue: 160, automationRate: "k-rate" },
    // The track: 0 jointed, 1 welded; the kernel crossfades to it.
    { name: "track", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    // Clacks, 0–100, latched as each clack strikes.
    { name: "clacks", defaultValue: 55, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // Rattles over points per second, latched as each block of absolute time begins.
    { name: "points", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: TrainKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readTrainOptions(options.processorOptions);
    this.kernel = new TrainKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= TRAIN_CHANNELS) {
      this.kernel.set(
        parameters.speed[0],
        parameters.track[0],
        parameters.clacks[0],
        parameters.points[0],
      );
      this.kernel.render(channels[0], channels[1], currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(TRAIN_PROCESSOR, TrainProcessor);
