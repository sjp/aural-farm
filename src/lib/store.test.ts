import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store";

describe("createStore", () => {
  it("notifies subscribers of changes only", () => {
    const store = createStore(1);
    const listener = vi.fn<() => void>();
    const unsubscribe = store.subscribe(listener);
    store.set(1);
    expect(listener).not.toHaveBeenCalled();
    store.set(2);
    expect(store.get()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
