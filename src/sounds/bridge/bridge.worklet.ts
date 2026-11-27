/**
 * Starship Bridge's worklet module: one processor that runs `BridgeKernel`
 * (the room's bed, the consoles, doors and alert, and the engine's drift) on
 * the absolute sample index, reading the console and door rates, the alert's
 * level and the Ventilation from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { BRIDGE_CHANNELS, BRIDGE_PROCESSOR, BridgeKernel, readBridgeOptions } from "./bridge-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class BridgeProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Console phrases a second, latched per second of absolute time.
    { name: "rate", defaultValue: 1 / 6, minValue: 0, maxValue: 10, automationRate: "k-rate" },
    // Doors a second, latched the same way.
    { name: "doors", defaultValue: 0, minValue: 0, maxValue: 10, automationRate: "k-rate" },
    // The alert's level, 0–1.
    { name: "alert", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    // The Ventilation, 0–100.
    { name: "air", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: BridgeKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readBridgeOptions(options.processorOptions);
    this.kernel = new BridgeKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= BRIDGE_CHANNELS) {
      this.kernel.set(
        parameters.rate[0],
        parameters.doors[0],
        parameters.alert[0],
        parameters.air[0],
      );
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(BRIDGE_PROCESSOR, BridgeProcessor);
