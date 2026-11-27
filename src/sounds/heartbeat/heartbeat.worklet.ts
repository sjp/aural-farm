/**
 * Heartbeat's worklet module: one processor that runs `HeartbeatKernel` (the
 * beats and the flow of blood for one seed) on the absolute sample index,
 * reading the rate and Flow from k-rate AudioParams. The rate applies from the
 * next beat; the kernel glides Flow.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { MAX_RATE, MIN_RATE } from "./heartbeat.meta";
import {
  HEARTBEAT_CHANNELS,
  HEARTBEAT_PROCESSOR,
  HeartbeatKernel,
  readHeartbeatOptions,
} from "./heartbeat-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class HeartbeatProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Beats a minute, re-anchored at the next beat.
    {
      name: "rate",
      defaultValue: 64,
      minValue: MIN_RATE,
      maxValue: MAX_RATE,
      automationRate: "k-rate",
    },
    // Flow, 0–100: the kernel glides to it.
    { name: "bed", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: HeartbeatKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readHeartbeatOptions(options.processorOptions);
    this.kernel = new HeartbeatKernel(o.seed, sampleRate, o.rate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= HEARTBEAT_CHANNELS) {
      this.kernel.set(parameters.rate[0], parameters.bed[0]);
      this.kernel.render(channels[0], currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(HEARTBEAT_PROCESSOR, HeartbeatProcessor);
