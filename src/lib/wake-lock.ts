/**
 * Keeps the screen on with the Screen Wake Lock API, for people watching the
 * backdrop. The browser releases the lock whenever the page is hidden, so it is
 * requested again each time the page becomes visible while it is still wanted.
 */

/** The parts of `navigator.wakeLock` used here; tests pass a fake. */
export interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

/** The parts of `document` used here. */
type VisibilitySource = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

interface ScreenWakeLock {
  /** Holds the lock while `wanted` (and the page is visible), or lets it go. */
  set: (wanted: boolean) => void;
  /** Lets the lock go and stops listening. */
  dispose: () => void;
}

export function createScreenWakeLock(
  wakeLock: WakeLockLike,
  doc: VisibilitySource = document,
): ScreenWakeLock {
  let wanted = false;
  let disposed = false;
  let sentinel: WakeLockSentinelLike | undefined;
  let requesting = false;

  const release = () => {
    const held = sentinel;
    sentinel = undefined;
    if (held && !held.released) {
      held.release().catch(() => undefined);
    }
  };

  /** Read afresh: it changes behind TypeScript's back across an await. */
  const isWanted = () => wanted && !disposed;

  const acquire = async () => {
    if (!isWanted() || doc.hidden || sentinel || requesting) {
      return;
    }
    requesting = true;
    let lock: WakeLockSentinelLike;
    try {
      lock = await wakeLock.request("screen");
    } catch {
      // Refused (a battery saver, a policy, or the page hid meanwhile): try again
      // when the page is next shown.
      return;
    } finally {
      requesting = false;
    }
    sentinel = lock;
    lock.addEventListener("release", () => {
      if (sentinel === lock) {
        sentinel = undefined;
      }
    });
    if (!isWanted()) {
      // Turned off while the request was pending.
      release();
    }
  };

  const onVisibility = () => {
    if (!doc.hidden) {
      void acquire();
    }
  };
  doc.addEventListener("visibilitychange", onVisibility);

  return {
    set(next) {
      if (disposed || next === wanted) {
        return;
      }
      wanted = next;
      if (wanted) {
        void acquire();
      } else {
        release();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      wanted = false;
      doc.removeEventListener("visibilitychange", onVisibility);
      release();
    },
  };
}
