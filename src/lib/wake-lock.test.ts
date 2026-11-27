// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createScreenWakeLock, type WakeLockLike, type WakeLockSentinelLike } from "./wake-lock";

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private readonly listeners: (() => void)[] = [];

  release(): Promise<void> {
    this.drop();
    return Promise.resolve();
  }

  addEventListener(_type: "release", listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Releases the lock as the browser does when the page is hidden. */
  drop(): void {
    if (!this.released) {
      this.released = true;
      for (const listener of this.listeners) {
        listener();
      }
    }
  }
}

function fakeWakeLock() {
  const sentinels: FakeSentinel[] = [];
  let refuse = false;
  const wakeLock: WakeLockLike = {
    request: () => {
      if (refuse) {
        return Promise.reject(new DOMException("Not allowed", "NotAllowedError"));
      }
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return Promise.resolve(sentinel);
    },
  };
  return {
    wakeLock,
    sentinels,
    held: () => sentinels.filter((s) => !s.released).length,
    setRefuse: (value: boolean) => {
      refuse = value;
    },
  };
}

let hidden: MockInstance<() => boolean>;
const flush = () => vi.advanceTimersByTimeAsync(0);

function setHidden(value: boolean) {
  hidden.mockReturnValue(value);
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});

afterEach(() => {
  hidden.mockRestore();
});

describe("createScreenWakeLock", () => {
  it("acquires the lock when wanted and releases it when not", async () => {
    const fake = fakeWakeLock();
    const lock = createScreenWakeLock(fake.wakeLock);
    await flush();
    expect(fake.sentinels).toHaveLength(0);
    lock.set(true);
    await flush();
    expect(fake.held()).toBe(1);
    lock.set(false);
    await flush();
    expect(fake.held()).toBe(0);
    lock.dispose();
  });

  it("re-acquires the lock when the page is shown again", async () => {
    const fake = fakeWakeLock();
    const lock = createScreenWakeLock(fake.wakeLock);
    lock.set(true);
    await flush();
    setHidden(true);
    fake.sentinels[0]?.drop();
    await flush();
    expect(fake.held()).toBe(0);
    setHidden(false);
    await flush();
    expect(fake.sentinels).toHaveLength(2);
    expect(fake.held()).toBe(1);
    lock.dispose();
  });

  it("doesn't request a lock while the page is hidden", async () => {
    const fake = fakeWakeLock();
    hidden.mockReturnValue(true);
    const lock = createScreenWakeLock(fake.wakeLock);
    lock.set(true);
    await flush();
    expect(fake.sentinels).toHaveLength(0);
    setHidden(false);
    await flush();
    expect(fake.held()).toBe(1);
    lock.dispose();
  });

  it("doesn't re-acquire on visibility once it is no longer wanted", async () => {
    const fake = fakeWakeLock();
    const lock = createScreenWakeLock(fake.wakeLock);
    lock.set(true);
    await flush();
    lock.set(false);
    setHidden(true);
    setHidden(false);
    await flush();
    expect(fake.sentinels).toHaveLength(1);
    expect(fake.held()).toBe(0);
    lock.dispose();
  });

  it("releases a lock that arrives after it was turned off", async () => {
    const fake = fakeWakeLock();
    const lock = createScreenWakeLock(fake.wakeLock);
    lock.set(true);
    lock.set(false);
    await flush();
    expect(fake.sentinels).toHaveLength(1);
    expect(fake.held()).toBe(0);
    lock.dispose();
  });

  it("survives a refused request and tries again when the page is shown", async () => {
    const fake = fakeWakeLock();
    fake.setRefuse(true);
    const lock = createScreenWakeLock(fake.wakeLock);
    lock.set(true);
    await flush();
    expect(fake.held()).toBe(0);
    fake.setRefuse(false);
    setHidden(true);
    setHidden(false);
    await flush();
    expect(fake.held()).toBe(1);
    lock.dispose();
  });

  it("releases the lock and stops listening on dispose", async () => {
    const fake = fakeWakeLock();
    const lock = createScreenWakeLock(fake.wakeLock);
    lock.set(true);
    await flush();
    lock.dispose();
    expect(fake.held()).toBe(0);
    setHidden(true);
    setHidden(false);
    await flush();
    expect(fake.sentinels).toHaveLength(1);
  });
});
