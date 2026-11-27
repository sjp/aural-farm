import { describe, expect, it } from "vitest";
import { Phasor, PolyBlepSaw, sine, SINE_TABLE_SIZE, sineTable } from "./osc";

describe("sine", () => {
  it("matches Math.sin closely at any phase", () => {
    for (let i = -1000; i < 1000; i++) {
      const phase = i * 0.01237;
      expect(Math.abs(sine(phase) - Math.sin(2 * Math.PI * phase))).toBeLessThan(1e-6);
    }
  });

  it("builds one shared table", () => {
    expect(sineTable()).toBe(sineTable());
    expect(sineTable()).toHaveLength(SINE_TABLE_SIZE + 1);
  });
});

describe("Phasor", () => {
  it("advances by frequency / sample rate and wraps into [0, 1)", () => {
    const p = new Phasor(1000, 300, 0.5);
    const phases = Array.from({ length: 5 }, () => p.next());
    [0.5, 0.8, 0.1, 0.4, 0.7].forEach((expected, i) => {
      expect(phases[i]).toBeCloseTo(expected, 12);
    });
    p.setFrequency(-100);
    p.next();
    expect(p.phase).toBeGreaterThanOrEqual(0);
    expect(p.phase).toBeLessThan(1);
  });
});

describe("PolyBlepSaw", () => {
  it("stays within [−1, 1], has no DC and is smoothed at the reset", () => {
    const sr = 48000;
    const saw = new PolyBlepSaw(sr, 1000);
    const out = Array.from({ length: sr }, () => saw.next());
    expect(Math.max(...out.map((v) => Math.abs(v)))).toBeLessThanOrEqual(1);
    expect(Math.abs(out.reduce((a, b) => a + b, 0) / out.length)).toBeLessThan(0.01);
    // A naive saw jumps by 2 at each reset; the PolyBLEP one by much less.
    let biggest = 0;
    for (let i = 1; i < out.length; i++) {
      biggest = Math.max(biggest, Math.abs((out[i] ?? 0) - (out[i - 1] ?? 0)));
    }
    expect(biggest).toBeLessThan(1.2);
  });
});
