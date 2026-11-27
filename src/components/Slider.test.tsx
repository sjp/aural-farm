// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Slider } from "./Slider";
import { TOUCH_SLOP_PX, touchIntent, valueAtX } from "./slider-gesture";

describe("touchIntent", () => {
  it.each([
    [0, 0, "undecided"],
    [TOUCH_SLOP_PX - 1, TOUCH_SLOP_PX - 1, "undecided"],
    [TOUCH_SLOP_PX, 2, "slide"],
    [-20, 5, "slide"],
    [3, TOUCH_SLOP_PX, "scroll"],
    [10, -10, "scroll"],
    [6, -30, "scroll"],
  ] as const)("reads a move of (%d, %d) as %s", (dx, dy, intent) => {
    expect(touchIntent(dx, dy)).toBe(intent);
  });
});

describe("valueAtX", () => {
  const track = { left: 100, width: 228 };
  const range = { min: 0, max: 100, step: 1 };

  it.each([
    [0, 0],
    [114, 0],
    [214, 50],
    [314, 100],
    [400, 100],
    [134, 10],
  ])("puts x=%d at %d", (x, expected) => {
    expect(valueAtX(x, track, range)).toBe(expected);
  });

  it("snaps to the step without floating-point dust", () => {
    expect(valueAtX(44, { left: 0, width: 128 }, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
  });

  it("leaves an 'any' step unsnapped", () => {
    expect(valueAtX(139, track, { min: 0, max: 1000, step: "any" })).toBeCloseTo(125);
  });

  it("puts every x at the minimum on a track no wider than the thumb", () => {
    expect(valueAtX(50, { left: 0, width: 20 }, range)).toBe(0);
  });
});

describe("Slider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A slider over 0–100 whose track runs from x=100 to x=328, so x=214 is 50. */
  function renderSlider(value = 20) {
    const onValue = vi.fn<(value: number) => void>();
    render(
      <Slider
        label="Level"
        position={value / 100}
        min={0}
        max={100}
        step={1}
        value={value}
        onValue={onValue}
      />,
    );
    const input = screen.getByRole<HTMLInputElement>("slider", { name: "Level" });
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      left: 100,
      width: 228,
    } as DOMRect);
    const wrapper = input.parentElement as HTMLElement;
    const capture = vi.fn<(id: number) => void>();
    wrapper.setPointerCapture = capture;
    return { input, wrapper, onValue, capture };
  }

  const touch = { pointerId: 1, pointerType: "touch", button: 0 };

  it("passes the input's own changes on, as numbers", () => {
    const { input, onValue } = renderSlider();
    fireEvent.input(input, { target: { value: "35" } });
    expect(onValue).toHaveBeenCalledWith(35);
  });

  it("slides the value once a touch moves sideways, and follows it", () => {
    const { wrapper, onValue, capture } = renderSlider();
    fireEvent.pointerDown(wrapper, { ...touch, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(wrapper, { ...touch, clientX: 203, clientY: 301 });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.pointerMove(wrapper, { ...touch, clientX: 214, clientY: 302 });
    expect(onValue).toHaveBeenLastCalledWith(50);
    expect(capture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(wrapper, { ...touch, clientX: 314, clientY: 340 });
    expect(onValue).toHaveBeenLastCalledWith(100);
    fireEvent.pointerUp(wrapper, { ...touch, clientX: 314, clientY: 340 });
  });

  it("leaves the value alone while a touch scrolls vertically", () => {
    const { wrapper, onValue } = renderSlider();
    fireEvent.pointerDown(wrapper, { ...touch, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(wrapper, { ...touch, clientX: 202, clientY: 290 });
    fireEvent.pointerMove(wrapper, { ...touch, clientX: 260, clientY: 250 });
    fireEvent.pointerUp(wrapper, { ...touch, clientX: 260, clientY: 250 });
    expect(onValue).not.toHaveBeenCalled();
  });

  it("forgets a touch the browser took for scrolling", () => {
    const { wrapper, onValue } = renderSlider();
    fireEvent.pointerDown(wrapper, { ...touch, clientX: 200, clientY: 300 });
    fireEvent.pointerCancel(wrapper, touch);
    fireEvent.pointerUp(wrapper, { ...touch, clientX: 200, clientY: 300 });
    expect(onValue).not.toHaveBeenCalled();
  });

  it("moves to a tap", () => {
    const { wrapper, input, onValue } = renderSlider();
    fireEvent.pointerDown(wrapper, { ...touch, clientX: 214, clientY: 300 });
    fireEvent.pointerUp(wrapper, { ...touch, clientX: 214, clientY: 300 });
    expect(onValue).toHaveBeenCalledWith(50);
    expect(document.activeElement).toBe(input);
  });

  it("drags at once with a mouse", () => {
    const { wrapper, onValue } = renderSlider();
    fireEvent.pointerDown(wrapper, { pointerId: 2, pointerType: "mouse", button: 0, clientX: 314 });
    expect(onValue).toHaveBeenCalledWith(100);
  });

  it("leaves input that reaches the input itself to it", () => {
    const { input, onValue } = renderSlider();
    fireEvent.pointerDown(input, { ...touch, clientX: 214, clientY: 300 });
    fireEvent.pointerUp(input, { ...touch, clientX: 214, clientY: 300 });
    expect(onValue).not.toHaveBeenCalled();
  });
});
