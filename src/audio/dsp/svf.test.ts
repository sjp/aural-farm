import { describe, expect, it } from "vitest";
import { createRng } from "../random";
import { Svf } from "./svf";

const SR = 48000;

/** The steady-state amplitude of `output` for a sine at `frequency`. */
function gainAt(
  frequency: number,
  cutoff: number,
  q: number,
  output: "low" | "band" | "high" | "notch",
) {
  const svf = new Svf(SR, cutoff, q);
  let peak = 0;
  const n = SR / 2;
  for (let i = 0; i < n; i++) {
    svf.tick(Math.sin((2 * Math.PI * frequency * i) / SR));
    if (i > n / 2) {
      peak = Math.max(peak, Math.abs(svf[output]));
    }
  }
  return peak;
}

describe("Svf", () => {
  it("has the expected responses at a Butterworth Q", () => {
    expect(gainAt(50, 1000, Math.SQRT1_2, "low")).toBeCloseTo(1, 2);
    expect(gainAt(1000, 1000, Math.SQRT1_2, "low")).toBeCloseTo(Math.SQRT1_2, 2);
    expect(gainAt(10000, 1000, Math.SQRT1_2, "low")).toBeLessThan(0.02);
    expect(gainAt(10000, 1000, Math.SQRT1_2, "high")).toBeCloseTo(1, 1);
    expect(gainAt(50, 1000, Math.SQRT1_2, "high")).toBeLessThan(0.01);
    expect(gainAt(1000, 1000, 4, "band")).toBeCloseTo(1, 2);
    expect(gainAt(1000, 1000, 4, "notch")).toBeLessThan(0.01);
    expect(gainAt(100, 1000, 4, "notch")).toBeCloseTo(1, 1);
  });

  it.each([0.5, 2, 20])("stays stable and bounded under fast random sweeps at Q %d", (q) => {
    const svf = new Svf(SR);
    const rng = createRng(1);
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      // A new cutoff anywhere from 20 Hz to 20 kHz every 16 samples.
      if (i % 16 === 0) {
        svf.set(20 * 1000 ** rng.next(), q);
      }
      svf.tick(rng.range(-1, 1));
      for (const v of [svf.low, svf.band, svf.high, svf.notch]) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
    }
    expect(peak).toBeLessThan(10 * q + 10);
  });

  it.each([
    [20, 0.5],
    [20, 20],
    [20000, 0.5],
    [20000, 20],
    [0, 0],
    [1e6, 1e6],
  ])("stays finite at cutoff %d Hz and Q %d", (cutoff, q) => {
    const svf = new Svf(SR, cutoff, q);
    for (let i = 0; i < SR; i++) {
      svf.tick(i % 100 < 50 ? 1 : -1);
      expect(Number.isFinite(svf.low + svf.band + svf.high)).toBe(true);
    }
  });

  it("forgets its state on reset", () => {
    const svf = new Svf(SR, 500, 2);
    svf.tick(1);
    svf.reset();
    svf.tick(0);
    expect([svf.low, svf.band, svf.high, svf.notch]).toEqual([0, 0, 0, 0]);
  });
});
