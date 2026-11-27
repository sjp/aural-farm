/**
 * Stand-ins for the hidden `<audio>` element the engine can play its output
 * through, and for `navigator.mediaSession`.
 */
import type { MediaOutputElement } from "../audio/output";
import type { MediaSessionLike } from "../lib/media-session";

export class FakeMediaElement implements MediaOutputElement {
  srcObject: MediaProvider | null = null;
  paused = true;
  /** Whether `play()` may start; when not, it rejects with NotAllowedError, as browsers do. */
  allowed = true;
  /** Every `play` and `pause` call, in order. */
  readonly calls: ("play" | "pause")[] = [];
  private readonly listeners = new Set<() => void>();

  play(): Promise<void> {
    this.calls.push("play");
    if (!this.allowed) {
      return Promise.reject(new DOMException("play() needs a user gesture", "NotAllowedError"));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.calls.push("pause");
    this.stop();
  }

  /** Pauses as the system or a lock-screen control does, without going through the app. */
  pauseFromOutside(): void {
    this.stop();
  }

  addEventListener(_type: "pause", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "pause", listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** How many `pause` listeners are attached. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Pauses and, like a browser, fires `pause` from a later task rather than synchronously. */
  private stop(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    queueMicrotask(() => {
      for (const listener of Array.from(this.listeners)) {
        listener();
      }
    });
  }
}

/** A fake `navigator.mediaSession` that records its handlers, and knows no `seekto`. */
export function fakeMediaSession() {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const session: MediaSessionLike = {
    metadata: null,
    playbackState: "none",
    setActionHandler(action, handler) {
      if (action === "seekto") {
        throw new TypeError("seekto isn't supported");
      }
      handlers.set(action, handler);
    },
  };
  return { session, handlers };
}
