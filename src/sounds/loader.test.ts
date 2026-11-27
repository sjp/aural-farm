import { describe, expect, it, vi } from "vitest";
import { createLatest, createSoundLoader, whenIdle } from "./loader";
import type { SoundDefinition } from "./types";

function definition(id: string): SoundDefinition {
  return {
    id,
    name: id,
    description: "",
    categories: ["Tonal"],
    tags: [],
    cost: "very low",
    tint: "#888888",
    params: {},
    create: () => ({ update: () => undefined, dispose: () => undefined }),
  };
}

describe("createSoundLoader", () => {
  it("loads each sound once and caches it", async () => {
    const load = vi.fn<() => Promise<SoundDefinition>>(() => Promise.resolve(definition("a")));
    const loader = createSoundLoader();
    expect(loader.get("a")).toBeUndefined();
    const [first, second] = await Promise.all([
      loader.load({ id: "a", load }),
      loader.load({ id: "a", load }),
    ]);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(loader.get("a")).toBe(first);
  });

  it("forgets a failed load so it can be retried", async () => {
    const load = vi
      .fn<() => Promise<SoundDefinition>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(definition("a"));
    const loader = createSoundLoader();
    await expect(loader.load({ id: "a", load })).rejects.toThrow("offline");
    await expect(loader.load({ id: "a", load })).resolves.toMatchObject({ id: "a" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects a definition whose id doesn't match", async () => {
    const loader = createSoundLoader();
    const entry = { id: "a", load: () => Promise.resolve(definition("b")) };
    await expect(loader.load(entry)).rejects.toThrow('Loaded sound "b" for "a"');
    expect(loader.get("a")).toBeUndefined();
  });

  it("prefetches without surfacing errors", async () => {
    const load = vi.fn<() => Promise<SoundDefinition>>(() => Promise.reject(new Error("x")));
    const loader = createSoundLoader();
    loader.prefetch({ id: "a", load });
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("createLatest", () => {
  it("delivers only the newest result", async () => {
    const latest = createLatest<string>();
    const onLoad = vi.fn<(value: string) => void>();
    const onError = vi.fn<(error: unknown) => void>();
    let resolveOld: (value: string) => void = () => undefined;
    latest.run(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
      onLoad,
      onError,
    );
    latest.run(Promise.resolve("new"), onLoad, onError);
    resolveOld("old");
    await vi.runAllTimersAsync();
    expect(onLoad.mock.calls).toEqual([["new"]]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports the newest error and drops cancelled runs", async () => {
    const latest = createLatest<string>();
    const onLoad = vi.fn<(value: string) => void>();
    const onError = vi.fn<(error: unknown) => void>();
    latest.run(Promise.reject(new Error("bad")), onLoad, onError);
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
    latest.run(Promise.resolve("late"), onLoad, onError);
    latest.cancel();
    await vi.runAllTimersAsync();
    expect(onLoad).not.toHaveBeenCalled();
  });
});

describe("whenIdle", () => {
  it("falls back to a timeout and can be cancelled", () => {
    const fn = vi.fn<() => void>();
    whenIdle(fn);
    const cancel = whenIdle(fn);
    cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
