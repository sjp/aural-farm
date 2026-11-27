/**
 * Loading AudioWorklet modules. A worklet module is imported with Vite's
 * `?worker&url` suffix, which bundles it (and the pure DSP it imports) into one
 * self-contained, same-origin script and gives its URL:
 *
 *   import audioWorkletUrl from "./audio.worklet.ts?worker&url";
 *   await loadWorklet(ctx, audioWorkletUrl);
 *
 * Worklet modules and the `*-dsp.ts` kernels they import run in
 * `AudioWorkletGlobalScope`, which has no DOM: lint keeps DOM globals out of them.
 *
 * Most sounds need only the shared module's noise and drift (`createNoise`,
 * `createDrift`). A sound with a processor of its own (random events, say) has
 * its own `<id>.worklet.ts`, whose processors extend `StoppableProcessor`, and
 * starts them with `startProcessor`.
 */
import type { AudioScope } from "./scope";
import { STOP_MESSAGE } from "./worklet-protocol";

/** Each context's modules, by URL. A context loads a module once, however many sounds use it. */
const loaded = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

/**
 * Adds the worklet module at `url` to `ctx`, once per context. A failed load is
 * forgotten, so the next call tries again. Rejects with an explanation on an
 * insecure page, where the browser leaves out `audioWorklet`.
 */
export function loadWorklet(ctx: BaseAudioContext, url: string): Promise<void> {
  let modules = loaded.get(ctx);
  if (!modules) {
    modules = new Map();
    loaded.set(ctx, modules);
  }
  const cached = modules.get(url);
  if (cached) {
    return cached;
  }
  // Browsers only offer AudioWorklet on secure pages: https, or localhost.
  // The DOM types promise `audioWorklet`, but insecure pages leave it out.
  const worklet = ctx.audioWorklet as AudioWorklet | undefined;
  if (worklet === undefined) {
    return Promise.reject(
      new Error(
        "this browser only allows it on secure pages; open the app over https or localhost",
      ),
    );
  }
  const loading = worklet.addModule(url).catch((error: unknown) => {
    modules.delete(url);
    throw error;
  });
  modules.set(url, loading);
  return loading;
}

interface ProcessorOptions {
  /** Output channels. */
  channels: number;
  /** The sound's `init.startAt`: the absolute time the context's current time stands for. */
  startAt: number;
  /** Passed to the processor's constructor, with `offset` added. */
  processorOptions: object;
  /** Initial values of the processor's own AudioParams, by name. */
  parameterData?: Record<string, number>;
}

/**
 * Loads the worklet module at `moduleUrl` into `ctx`, then makes a source node
 * (no inputs) running `processor`, registered with `scope`: on dispose it is
 * disconnected and its processor told to stop (`STOP_MESSAGE`).
 *
 * The processor gets the offset from context time to absolute time in
 * `processorOptions.offset`, so a sound rendered in an offline context from
 * `startAt` produces the same samples as a live one at that time: its absolute
 * sample is `currentFrame + round(offset × sampleRate)`.
 */
export async function startProcessor(
  ctx: BaseAudioContext,
  scope: AudioScope,
  moduleUrl: string,
  processor: string,
  options: ProcessorOptions,
): Promise<AudioWorkletNode> {
  await loadWorklet(ctx, moduleUrl);
  const node = scope.add(
    new AudioWorkletNode(ctx, processor, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [options.channels],
      processorOptions: { ...options.processorOptions, offset: options.startAt - ctx.currentTime },
      ...(options.parameterData ? { parameterData: options.parameterData } : {}),
    }),
  );
  scope.defer(() => {
    // A MessagePort, not a window: it takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    node.port.postMessage(STOP_MESSAGE);
  });
  return node;
}
