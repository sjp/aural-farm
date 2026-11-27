/**
 * The shared AudioWorklet module: it registers the noise and drift processors,
 * so a context loads it once (`loadWorklet`) and most sounds need no worklet of
 * their own. Each processor is a thin wrapper that runs a kernel from a
 * `-dsp.ts` module on the absolute sample index.
 *
 * Each processor keeps running until its node is disposed (see `StoppableProcessor`).
 */
import { DRIFT_PROCESSOR, DriftGenerator, readDriftOptions } from "./drift-dsp";
import { NOISE_PROCESSOR, NoiseGenerator, readNoiseOptions } from "./noise-dsp";
import { StoppableProcessor } from "./worklet-processor";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => StoppableProcessor,
): void;

class NoiseProcessor extends StoppableProcessor {
  private readonly generator: NoiseGenerator;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readNoiseOptions(options.processorOptions);
    this.generator = new NoiseGenerator(o.colour, o.seed, o.stream, o.channels, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0] ?? [];
    const start = currentFrame + this.offset;
    for (let c = 0; c < output.length; c++) {
      this.generator.render(c, output[c], start);
    }
    return !this.stopped;
  }
}

/** Runs one drift per output channel. */
class DriftProcessor extends StoppableProcessor {
  private readonly generators: DriftGenerator[];
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readDriftOptions(options.processorOptions);
    this.generators = o.drifts.map(
      (d) => new DriftGenerator(o.seed, d.stream, d.rate, d.octaves, sampleRate),
    );
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0] ?? [];
    const start = currentFrame + this.offset;
    const channels = Math.min(output.length, this.generators.length);
    for (let c = 0; c < channels; c++) {
      this.generators[c]?.render(output[c], start);
    }
    return !this.stopped;
  }
}

registerProcessor(NOISE_PROCESSOR, NoiseProcessor);
registerProcessor(DRIFT_PROCESSOR, DriftProcessor);
