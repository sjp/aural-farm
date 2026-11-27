import { describe, expect, it } from "vitest";
import {
  bodyLevel,
  bodyLevelCurve,
  brightness,
  colourCents,
  colourCurve,
  flutter,
  flutterCurve,
  gust,
  gustCurve,
  SETTINGS,
  SPEED_MAX,
  WHISTLE_MAX,
  whistleCents,
  whistleCurve,
  whistleFrequency,
} from "./wind-dsp";

const isRising = (values: ArrayLike<number>) =>
  Array.from(values).every((v, i, all) => i === 0 || v >= (all[i - 1] ?? 0));

describe("gust curve", () => {
  const curve = gustCurve();

  it("stays within 0..1", () => {
    expect(Math.min(...curve)).toBe(0);
    expect(Math.max(...curve)).toBeCloseTo(1, 6);
  });

  it("never falls as the drift rises", () => {
    expect(isRising(curve)).toBe(true);
  });

  it.each([-1, -0.8, -0.5, -0.3, -0.2])("is a lull (0) at drift %f", (x) => {
    expect(gust(x)).toBe(0);
  });

  it("rises above −0.2, rounded rather than sharp", () => {
    expect(gust(0)).toBeGreaterThan(0);
    expect(gust(0.4)).toBeLessThan(0.5);
    expect(gust(1)).toBeCloseTo(1, 12);
  });

  it("holds its ends beyond −1..1", () => {
    expect(gust(-3)).toBe(0);
    expect(gust(3)).toBeCloseTo(1, 12);
  });
});

describe("whistle pitch", () => {
  const whistles = Object.entries(SETTINGS).flatMap(([setting, spec]) =>
    spec.whistles.map((w) => [setting, w.base] as const),
  );
  const speeds = [0, 0.3, 0.5, 1, 1.5, 2, 2.5, SPEED_MAX, 10];

  it.each(whistles)("never passes 1.6 kHz in %s (base %f Hz) at any speed", (_, base) => {
    for (const speed of speeds) {
      expect(whistleFrequency(base, speed)).toBeLessThanOrEqual(WHISTLE_MAX + 1e-9);
    }
  });

  it.each(whistles)("rises with the speed in %s (base %f Hz)", (_, base) => {
    expect(whistleFrequency(base, 0)).toBeCloseTo(base, 9);
    const rising = speeds.map((speed) => whistleFrequency(base, speed));
    expect(isRising(rising)).toBe(true);
    expect(whistleFrequency(base, 1)).toBeGreaterThan(base * 1.15);
  });

  it("rises at most 35 %", () => {
    expect(2 ** (whistleCents(SPEED_MAX) / 1200)).toBeLessThanOrEqual(1.35 + 1e-9);
  });
});

describe("speed controls", () => {
  it("puts the body at −24 dB when still and 0 dB at speed 1, and only a little more in a gale", () => {
    expect(20 * Math.log10(bodyLevel(0))).toBeCloseTo(-24, 6);
    expect(bodyLevel(1)).toBeCloseTo(1, 12);
    expect(20 * Math.log10(bodyLevel(SPEED_MAX))).toBeLessThan(3);
  });

  it("brightens with the speed, up to +60 % on the bands", () => {
    expect(brightness(0)).toBe(0);
    expect(brightness(2)).toBe(1);
    expect(2 ** (colourCents(SPEED_MAX) / 1200)).toBeCloseTo(1.6, 9);
  });

  it.each([
    ["body level", bodyLevelCurve(0.5)],
    ["colour", colourCurve()],
    ["whistle", whistleCurve()],
  ] as const)("gives a finite, rising %s curve, still for negative input", (_, curve) => {
    expect(curve.every((v) => Number.isFinite(v))).toBe(true);
    expect(isRising(curve)).toBe(true);
    const middle = (curve.length - 1) / 2;
    expect(curve[0]).toBe(curve[middle]);
  });

  it("reads the speed ÷ SPEED_MAX: the last point is the speed at SPEED_MAX", () => {
    const curve = bodyLevelCurve(1);
    expect(curve.at(-1)).toBeCloseTo(bodyLevel(SPEED_MAX), 6);
  });
});

describe("leaves' flutter", () => {
  it("stays within 0..scale and peaks sharply", () => {
    const curve = flutterCurve(0.5);
    expect(Math.min(...curve)).toBe(0);
    expect(Math.max(...curve)).toBeCloseTo(0.5, 6);
    expect(isRising(curve)).toBe(true);
    // Halfway up the drift's usual range, still well under half the peak.
    expect(flutter(0.4)).toBeLessThan(0.5);
  });
});
