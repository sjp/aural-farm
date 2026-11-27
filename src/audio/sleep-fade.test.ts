import { describe, expect, it } from "vitest";
import { gainToDb } from "./glide";
import { curveValue, SLEEP_FADE_FLOOR_DB, sleepFadeCurve } from "./sleep-fade";

describe("sleepFadeCurve", () => {
  const curve = sleepFadeCurve();

  it("starts at full level and ends in silence", () => {
    expect(curve[0]).toBe(1);
    expect(curve.at(-1)).toBe(0);
    expect(curve.at(-2)).toBeCloseTo(10 ** (SLEEP_FADE_FLOOR_DB / 20), 6);
  });

  it("falls by the same number of decibels at every step", () => {
    const steps = curve.length - 2;
    for (const i of [1, Math.floor(steps / 3), Math.floor(steps / 2), steps]) {
      expect(gainToDb(curve[i] ?? 0)).toBeCloseTo((SLEEP_FADE_FLOOR_DB * i) / steps, 3);
    }
  });

  it("never rises", () => {
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeLessThan(curve[i - 1] ?? 0);
    }
  });
});

describe("curveValue", () => {
  const curve = [1, 0.5, 0];

  it.each([
    [-1, 1],
    [10, 1],
    [12.5, 0.75],
    [15, 0.5],
    [17.5, 0.25],
    [20, 0],
    [30, 0],
  ])("reads %s s into a curve set at 10 s for 10 s as %s", (t, value) => {
    expect(curveValue(curve, 10, 10, t)).toBeCloseTo(value);
  });

  it("is about −30 dB halfway through the sleep fade", () => {
    expect(gainToDb(curveValue(sleepFadeCurve(), 0, 100, 50))).toBeCloseTo(-30, 0);
  });
});
