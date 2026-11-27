import { afterEach, beforeEach, vi } from "vitest";

/**
 * Every test runs on fake timers whose clock starts at the configured instant
 * (`fakeTimers.now` in vite.config.ts), so nothing depends on when or how fast
 * the tests run. Drive waits with `vi.advanceTimersByTime*`.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  // Component tests render into a DOM; unmount them before the timers go real,
  // so their effects' clean-ups clear fake timers.
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/preact");
    cleanup();
  }
  vi.useRealTimers();
});

/**
 * @testing-library's `waitFor` advances fake timers itself, but only when it finds
 * a global `jest` with `advanceTimersByTime`. Point that at Vitest's.
 */
Object.assign(globalThis, {
  jest: {
    advanceTimersByTime: (ms: number) => {
      vi.advanceTimersByTime(ms);
    },
  },
});
