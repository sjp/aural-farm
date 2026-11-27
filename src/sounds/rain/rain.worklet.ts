/**
 * Rain's worklet module: one processor that runs `RainGenerator` (the wash's
 * noise and drifts, and the drops) on the absolute sample index, reading the
 * drops' rate, plink chance, level and low-pass from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import { RAIN_PROCESSOR, RainGenerator, readRainOptions } from "./rain-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class RainProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Drops per second on open ground, read once per block.
    { name: "rate", defaultValue: 0, minValue: 0, maxValue: 10_000, automationRate: "k-rate" },
    // The plink chance at full plink factor (0–1), read as each drop starts.
    { name: "bubbles", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    // The drops' gain, read as each drop starts.
    { name: "level", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    // The low-pass over the drops, in Hz.
    {
      name: "cutoff",
      defaultValue: 18_000,
      minValue: 20,
      maxValue: 24_000,
      automationRate: "k-rate",
    },
  ] as const;

  private readonly generator: RainGenerator;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readRainOptions(options.processorOptions);
    this.generator = new RainGenerator(o.seed, o.surface, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    this.generator.set(
      parameters.rate[0],
      parameters.bubbles[0],
      parameters.level[0],
      parameters.cutoff[0],
    );
    this.generator.render(outputs[0] ?? [], currentFrame + this.offset);
    return !this.stopped;
  }
}

registerProcessor(RAIN_PROCESSOR, RainProcessor);
