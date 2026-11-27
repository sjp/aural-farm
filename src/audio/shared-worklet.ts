/**
 * Nodes running a processor from the shared worklet module (`audio.worklet.ts`),
 * which registers the noise and drift processors and loads once per context.
 */
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import audioWorkletUrl from "./audio.worklet.ts?worker&url";
import type { AudioScope } from "./scope";
import { STOP_MESSAGE } from "./worklet-protocol";
import { loadWorklet } from "./worklets";

/**
 * Loads the shared module into `ctx`, then makes a source node (no inputs) running
 * `processor` with `channels` output channels, registered with `scope`: on dispose
 * it is disconnected and its processor told to stop.
 *
 * `startAt` is the absolute time that the context's current time stands for (a
 * sound's `init.startAt`). The processor gets the offset from context time to
 * absolute time in `processorOptions.offset`, so a sound rendered in an offline
 * context from `startAt` produces the same samples as a live one at that time.
 */
export async function startWorkletNode(
  ctx: BaseAudioContext,
  scope: AudioScope,
  processor: string,
  channels: number,
  startAt: number,
  processorOptions: object,
): Promise<AudioWorkletNode> {
  await loadWorklet(ctx, audioWorkletUrl);
  const node = scope.add(
    new AudioWorkletNode(ctx, processor, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: { ...processorOptions, offset: startAt - ctx.currentTime },
    }),
  );
  scope.defer(() => {
    // A MessagePort, not a window: it takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    node.port.postMessage(STOP_MESSAGE);
  });
  return node;
}
