// @vitest-environment happy-dom
import { renderHook } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { createStore } from "../lib/store";
import { act } from "../test/act";
import { useExternalStore } from "./useExternalStore";

describe("useExternalStore", () => {
  it("re-renders when the store changes", () => {
    const store = createStore(1);
    const { result } = renderHook(() => useExternalStore(store.subscribe, store.get));
    expect(result.current).toBe(1);
    act(() => {
      store.set(2);
    });
    expect(result.current).toBe(2);
  });

  it("catches a change made between render and subscribe", () => {
    const store = createStore("a");
    const { result } = renderHook(() => {
      const value = useExternalStore(store.subscribe, store.get);
      if (value === "a") {
        store.set("b");
      }
      return value;
    });
    expect(result.current).toBe("b");
  });
});
