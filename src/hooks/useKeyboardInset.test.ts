// @vitest-environment happy-dom
import { renderHook } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "../test/act";
import { KEYBOARD_INSET_PROPERTY, keyboardInset, useKeyboardInset } from "./useKeyboardInset";

describe("keyboardInset", () => {
  it.each([
    ["no keyboard", 844, { height: 844, offsetTop: 0, scale: 1 }, 0],
    ["a keyboard", 844, { height: 508, offsetTop: 0, scale: 1 }, 336],
    ["a keyboard with the page scrolled up", 844, { height: 508, offsetTop: 40, scale: 1 }, 296],
    ["a fractional viewport", 844, { height: 507.6, offsetTop: 0, scale: 1 }, 336],
    ["a pinch zoom", 844, { height: 422, offsetTop: 100, scale: 2 }, 0],
    ["a viewport taller than the layout", 800, { height: 844, offsetTop: 0, scale: 1 }, 0],
  ])("is right with %s", (_, layout, viewport, inset) => {
    expect(keyboardInset(layout, viewport)).toBe(inset);
  });
});

describe("useKeyboardInset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("follows the visual viewport into a custom property, and clears it on unmount", () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal("visualViewport", viewport);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    const root = document.documentElement;
    const { unmount } = renderHook(() => {
      useKeyboardInset();
    });
    expect(root.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("0px");
    act(() => {
      viewport.height = 500;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(root.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("344px");
    act(() => {
      viewport.offsetTop = 44;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(root.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("300px");
    act(() => {
      unmount();
    });
    expect(root.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("");
  });

  it("does nothing without a visual viewport", () => {
    vi.stubGlobal("visualViewport", null);
    renderHook(() => {
      useKeyboardInset();
    });
    expect(document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("");
  });
});
