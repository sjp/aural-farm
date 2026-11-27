/**
 * Coffee Shop's worklet module: one processor that runs `CoffeeShopKernel`
 * (the whole café for one seed) on the absolute sample index, reading its
 * params from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  COFFEE_SHOP_CHANNELS,
  COFFEE_SHOP_PROCESSOR,
  CoffeeShopKernel,
  readCoffeeShopOptions,
} from "./coffee-shop-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class CoffeeShopProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // People present: a change fades those at the end of the list in or out.
    { name: "crowd", defaultValue: 6, minValue: 0, maxValue: 12, automationRate: "k-rate" },
    // Clatter, 0–100: the clinks' and steam's rates, latched per block.
    { name: "clatter", defaultValue: 40, minValue: 0, maxValue: 100, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: CoffeeShopKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readCoffeeShopOptions(options.processorOptions);
    this.kernel = new CoffeeShopKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= COFFEE_SHOP_CHANNELS) {
      this.kernel.set(parameters.crowd[0], parameters.clatter[0]);
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(COFFEE_SHOP_PROCESSOR, CoffeeShopProcessor);
