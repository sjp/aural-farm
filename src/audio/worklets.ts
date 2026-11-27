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
 */

/** Each context's modules, by URL. A context loads a module once, however many sounds use it. */
const loaded = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

/**
 * Adds the worklet module at `url` to `ctx`, once per context. A failed load is
 * forgotten, so the next call tries again.
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
  const loading = ctx.audioWorklet.addModule(url).catch((error: unknown) => {
    modules.delete(url);
    throw error;
  });
  modules.set(url, loading);
  return loading;
}
