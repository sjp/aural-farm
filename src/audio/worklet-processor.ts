/**
 * The base class of the app's AudioWorklet processors, shared by the shared
 * module (`audio.worklet.ts`) and the sounds' own worklet modules. Import it
 * only from a `*.worklet.ts` module: it extends `AudioWorkletProcessor`, which
 * exists only in `AudioWorkletGlobalScope`.
 *
 * A processor keeps running until its node is disposed, which posts
 * `STOP_MESSAGE` on its port (`startProcessor` arranges that); then `stopped` is
 * true, `process` returns false and the browser can collect it.
 */
import { STOP_MESSAGE } from "./worklet-protocol";

// AudioWorkletGlobalScope, which TypeScript's DOM types don't describe.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** A processor that stops when its node posts `STOP_MESSAGE`. */
export class StoppableProcessor extends AudioWorkletProcessor {
  protected stopped = false;

  constructor() {
    super();
    this.port.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data === STOP_MESSAGE) {
        this.stopped = true;
      }
    });
    this.port.start();
  }
}
