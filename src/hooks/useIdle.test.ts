// @vitest-environment happy-dom
import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { act } from "../test/act";
import { useIdle, useTouchPointer } from "./useIdle";

describe("useIdle", () => {
  it("turns idle after the delay", () => {
    const { result } = renderHook(() => useIdle(3000));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it.each(["pointermove", "pointerdown", "keydown", "wheel", "touchstart"])(
    "wakes on %s and restarts the delay",
    (type) => {
      const { result } = renderHook(() => useIdle(3000));
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current).toBe(true);
      act(() => {
        window.dispatchEvent(new Event(type));
      });
      expect(result.current).toBe(false);
      act(() => {
        vi.advanceTimersByTime(2000);
        window.dispatchEvent(new Event(type));
        vi.advanceTimersByTime(2000);
      });
      expect(result.current).toBe(false);
    },
  );

  it("counts a scroll inside the page as activity", () => {
    const { result } = renderHook(() => useIdle(3000));
    const scroller = document.createElement("div");
    document.body.append(scroller);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(result.current).toBe(false);
    scroller.remove();
  });

  it("stops listening when unmounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useIdle(3000));
    act(() => {
      unmount();
    });
    const removed = remove.mock.calls.map(([type]) => type);
    expect(removed).toEqual(
      expect.arrayContaining([
        "pointermove",
        "pointerdown",
        "keydown",
        "wheel",
        "touchstart",
        "scroll",
      ]),
    );
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
  });
});

describe("useTouchPointer", () => {
  it("follows the last pointer's type", () => {
    const { result } = renderHook(() => useTouchPointer());
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
    });
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse" }));
    });
    expect(result.current).toBe(false);
  });
});
