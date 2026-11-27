// @vitest-environment happy-dom
import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { act } from "../test/act";
import { useMediaQuery } from "./useMediaQuery";

describe("useMediaQuery", () => {
  it("follows the query's changes", () => {
    let listener: (() => void) | undefined;
    const list = {
      matches: true,
      addEventListener: (_: string, l: () => void) => {
        listener = l;
      },
      removeEventListener: vi.fn<(type: string, l: () => void) => void>(),
    };
    vi.spyOn(window, "matchMedia").mockReturnValue(list as unknown as MediaQueryList);
    const { result, unmount } = renderHook(() => useMediaQuery("(hover: hover)"));
    expect(result.current).toBe(true);
    act(() => {
      list.matches = false;
      listener?.();
    });
    expect(result.current).toBe(false);
    act(() => {
      unmount();
    });
    expect(list.removeEventListener).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
