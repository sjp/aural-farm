/**
 * Nodes running a processor from the shared worklet module (`audio.worklet.ts`),
 * which registers the noise and drift processors and loads once per context.
 */
// Vite's `?worker&url` suffix gives the bundled module's URL as the default export.
// oxlint-disable-next-line import/default
import audioWorkletUrl from "./audio.worklet.ts?worker&url";
import type { AudioScope } from "./scope";
import { startProcessor } from "./worklets";

/**
 * Loads the shared module into `ctx`, then makes a source node (no inputs) running
 * `processor` with `channels` output channels, registered with `scope`: see
 * `startProcessor`.
 */
export async function startWorkletNode(
  ctx: BaseAudioContext,
  scope: AudioScope,
  processor: string,
  channels: number,
  startAt: number,
  processorOptions: object,
): Promise<AudioWorkletNode> {
  return startProcessor(ctx, scope, audioWorkletUrl, processor, {
    channels,
    startAt,
    processorOptions,
  });
}
