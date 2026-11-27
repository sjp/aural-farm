import { describe, expect, it } from "vitest";
import { withAudioScope } from "./scope";

/** A node stand-in that logs its clean-up calls into `log`. */
function node(name: string, log: string[]) {
  return {
    disconnect: () => {
      log.push(`disconnect ${name}`);
    },
  } as unknown as AudioNode;
}

function source(name: string, log: string[], started = true) {
  return {
    stop: () => {
      if (!started) {
        throw new Error("not started");
      }
      log.push(`stop ${name}`);
    },
    disconnect: () => {
      log.push(`disconnect ${name}`);
    },
  } as unknown as AudioScheduledSourceNode;
}

/** A worklet node stand-in that can fire `processorerror`. */
function workletNode() {
  const listeners = new Set<(event: Event) => void>();
  const fake = {
    port: {},
    parameters: new Map(),
    addEventListener: (_type: string, fn: (event: Event) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: (event: Event) => void) => {
      listeners.delete(fn);
    },
    disconnect: () => undefined,
    crash: (event: Event) => {
      for (const fn of listeners) {
        fn(event);
      }
    },
  };
  return fake;
}

describe("withAudioScope", () => {
  it("cleans up in reverse order of registration", () => {
    const log: string[] = [];
    const scope = withAudioScope((s) => s);
    scope.add(node("a", log));
    scope.addSource(source("b", log));
    scope.own({
      dispose: () => {
        log.push("own c");
      },
    });
    scope.defer(() => {
      log.push("defer d");
    });
    scope.dispose();
    expect(log).toEqual(["defer d", "own c", "stop b", "disconnect b", "disconnect a"]);
  });

  it("returns what it registers", () => {
    const log: string[] = [];
    const n = node("a", log);
    withAudioScope((scope) => {
      expect(scope.add(n)).toBe(n);
    });
  });

  it("is idempotent", () => {
    const log: string[] = [];
    const scope = withAudioScope((s) => s);
    scope.add(node("a", log));
    scope.dispose();
    scope.dispose();
    expect(log).toEqual(["disconnect a"]);
  });

  it("ignores stopping a source that never started", () => {
    const log: string[] = [];
    const scope = withAudioScope((s) => s);
    scope.addSource(source("a", log, false));
    expect(() => {
      scope.dispose();
    }).not.toThrow();
    expect(log).toEqual(["disconnect a"]);
  });

  it("keeps going when a clean-up throws, then rethrows the first error", () => {
    const log: string[] = [];
    const scope = withAudioScope((s) => s);
    scope.add(node("a", log));
    scope.defer(() => {
      throw new Error("second");
    });
    scope.defer(() => {
      throw new Error("first");
    });
    scope.add(node("b", log));
    expect(() => {
      scope.dispose();
    }).toThrow("first");
    expect(log).toEqual(["disconnect b", "disconnect a"]);
  });

  it("releases what was built when the callback throws, and rethrows", () => {
    const log: string[] = [];
    expect(() =>
      withAudioScope((scope) => {
        scope.add(node("a", log));
        scope.add(node("b", log));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(log).toEqual(["disconnect b", "disconnect a"]);
  });

  it("rethrows the callback's error even when a clean-up also throws", () => {
    expect(() =>
      withAudioScope((scope) => {
        scope.defer(() => {
          throw new Error("clean-up");
        });
        throw new Error("build");
      }),
    ).toThrow("build");
  });

  it("releases what was built when an async callback rejects", async () => {
    const log: string[] = [];
    const result = withAudioScope(async (scope) => {
      scope.add(node("a", log));
      await Promise.resolve();
      throw new Error("late");
    });
    await expect(result).rejects.toThrow("late");
    expect(log).toEqual(["disconnect a"]);
  });

  it("leaves an async callback's result alone when it resolves", async () => {
    const log: string[] = [];
    const scope = await withAudioScope(async (s) => {
      s.add(node("a", log));
      await Promise.resolve();
      return s;
    });
    expect(log).toEqual([]);
    scope.dispose();
    expect(log).toEqual(["disconnect a"]);
  });

  it("releases anything registered after dispose straight away", () => {
    const log: string[] = [];
    const scope = withAudioScope((s) => s);
    scope.dispose();
    scope.add(node("late", log));
    expect(log).toEqual(["disconnect late"]);
  });

  it("reports a worklet node's processorerror", () => {
    const errors: unknown[] = [];
    const worklet = workletNode();
    const scope = withAudioScope(
      (s) => {
        s.add(worklet as unknown as AudioNode);
        return s;
      },
      (error) => {
        errors.push(error);
      },
    );
    const crash = new Error("processor crashed");
    worklet.crash(Object.assign(new Event("processorerror"), { error: crash }));
    worklet.crash(new Event("processorerror"));
    expect(errors[0]).toBe(crash);
    expect(errors[1]).toEqual(new Error("The audio processor crashed"));
    scope.dispose();
    worklet.crash(new Event("processorerror"));
    expect(errors).toHaveLength(2);
  });
});
