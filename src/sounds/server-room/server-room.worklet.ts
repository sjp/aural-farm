/**
 * Server Room's worklet module: one processor that runs `ServerRoomKernel`
 * (the whole room for one seed) on the absolute sample index, reading its
 * params from k-rate AudioParams.
 */
import { StoppableProcessor } from "../../audio/worklet-processor";
import {
  readServerRoomOptions,
  SERVER_ROOM_CHANNELS,
  SERVER_ROOM_PROCESSOR,
  ServerRoomKernel,
} from "./server-room-dsp";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(
  name: string,
  processor: (new (options: AudioWorkletNodeOptions) => StoppableProcessor) & {
    parameterDescriptors: readonly object[];
  },
): void;

class ServerRoomProcessor extends StoppableProcessor {
  static readonly parameterDescriptors = [
    // Airflow, Cooling and Whine, each 0–100.
    { name: "airflow", defaultValue: 60, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "hvac", defaultValue: 45, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    { name: "whine", defaultValue: 15, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    // Racks, 1–12; the kernel fades each in and out.
    { name: "racks", defaultValue: 6, minValue: 1, maxValue: 12, automationRate: "k-rate" },
    // Disk ticks: 0 off, 1 on, latched as each tick starts.
    { name: "disks", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  ] as const;

  private readonly kernel: ServerRoomKernel;
  private readonly offset: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const o = readServerRoomOptions(options.processorOptions);
    this.kernel = new ServerRoomKernel(o.seed, sampleRate);
    this.offset = Math.round(o.offset * sampleRate);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const channels = outputs[0] ?? [];
    if (channels.length >= SERVER_ROOM_CHANNELS) {
      this.kernel.set(
        parameters.airflow[0],
        parameters.racks[0],
        parameters.hvac[0],
        parameters.whine[0],
        parameters.disks[0],
      );
      this.kernel.render(channels, currentFrame + this.offset);
    }
    return !this.stopped;
  }
}

registerProcessor(SERVER_ROOM_PROCESSOR, ServerRoomProcessor);
