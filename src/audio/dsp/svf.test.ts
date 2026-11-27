import { describe, expect, it } from "vitest";
import { createRng } from "../random";
import { Svf, svfCoefficients } from "./svf";

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
    let finite = true;
    for (let i = 0; i < SR; i++) {
      // A new cutoff anywhere from 20 Hz to 20 kHz every 16 samples.
      if (i % 16 === 0) {
        svf.set(20 * 1000 ** rng.next(), q);
      }
      svf.tick(rng.range(-1, 1));
      for (const v of [svf.low, svf.band, svf.high, svf.notch]) {
        finite &&= Number.isFinite(v);
        peak = Math.max(peak, Math.abs(v));
      }
    }
    expect(finite).toBe(true);
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
    let finite = true;
    for (let i = 0; i < SR; i++) {
      svf.tick(i % 100 < 50 ? 1 : -1);
      finite &&= Number.isFinite(svf.low + svf.band + svf.high);
    }
    expect(finite).toBe(true);
  });

  it("forgets its state on reset", () => {
    const svf = new Svf(SR, 500, 2);
    svf.tick(1);
    svf.reset();
    svf.tick(0);
    expect([svf.low, svf.band, svf.high, svf.notch]).toEqual([0, 0, 0, 0]);
  });
});

describe("svfCoefficients", () => {
  it("runs inline to the same outputs as an Svf", () => {
    const svf = new Svf(SR, 700, 0.8);
    const [a1 = 0, a2 = 0, a3 = 0, k = 0] = svfCoefficients(new Float64Array(4), 700, 0.8, SR);
    const rng = createRng(3);
    let ic1 = 0;
    let ic2 = 0;
    for (let i = 0; i < 1000; i++) {
      const x = rng.range(-1, 1);
      svf.tick(x);
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      expect(v2).toBe(svf.low);
      expect(k * v1).toBe(svf.band);
      expect(x - k * v1 - v2).toBe(svf.high);
    }
  });
});
