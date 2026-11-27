/**
 * Ticking Clock's worklet module: one processor that runs `ClockKernel` (one
 * clock's ticks, tocks and hourly chime) on the absolute sample index, reading
 * Tone and the chime from k-rate AudioParams. Tone latches as each beat starts;
 * the kernel glides the chime in and out.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { CLOCK_CHANNELS, CLOCK_PROCESSOR, ClockKernel, readClockOptions } from "./clock-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class ClockProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Tone, 0–100, latched as each beat starts.
    { name: "tone", defaultValue: 35, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // The hourly chime: 0 off, 1 on; the kernel glides to it.
    { name: "chime", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: ClockKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readClockOptions(options.processorOptions);
    this.kernel = new ClockKernel(o.type, o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= CLOCK_CHANNELS) {
      this.kernel.set(parameters.tone[0], parameters.chime[0]);
      this.kernel.render(channels[0], channels[1], currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(CLOCK_PROCESSOR, ClockProcessor);
