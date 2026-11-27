import { describe, expect, it } from "vitest";
import {
  biquadCoefficients,
  BUTTERWORTH_Q,
  filterSamples,
  responseDb,
  type BiquadSpec,
} from "./biquad";

const RATE = 48000;

function gainAt(spec: BiquadSpec, frequency: number): number {
  return responseDb(biquadCoefficients(spec, RATE), frequency, RATE);
}

describe("biquad response", () => {
  it.each([
    ["lowshelf", 10, 1, 10],
    ["lowshelf", 10, 20000, 0],
    ["highshelf", 4, 1, 0],
    ["highshelf", 4, 23000, 4],
  ] as const)("a %s of %s dB reads %s Hz → %s dB", (type, gain, frequency, expected) => {
    expect(gainAt({ type, frequency: 1000, gain }, frequency)).toBeCloseTo(expected, 1);
  });

  it("puts a shelf's half gain at its frequency", () => {
    expect(gainAt({ type: "lowshelf", frequency: 150, gain: 10 }, 150)).toBeCloseTo(5, 6);
    expect(gainAt({ type: "highshelf", frequency: 4000, gain: -6 }, 4000)).toBeCloseTo(-3, 6);
  });

  it("puts a peak's full gain at its frequency", () => {
    expect(gainAt({ type: "peaking", frequency: 3500, gain: -6, Q: 1 }, 3500)).toBeCloseTo(-6, 6);
    expect(gainAt({ type: "peaking", frequency: 3500, gain: -6, Q: 1 }, 50)).toBeCloseTo(0, 1);
  });

  it.each(["lowpass", "highpass"] as const)(
    "makes a Butterworth %s −3 dB at its cutoff",
    (type) => {
      expect(gainAt({ type, frequency: 1000, Q: BUTTERWORTH_Q }, 1000)).toBeCloseTo(-3.01, 2);
    },
  );

  it("passes and stops the right ends", () => {
    expect(gainAt({ type: "lowpass", frequency: 12000, Q: BUTTERWORTH_Q }, 100)).toBeCloseTo(0, 3);
    expect(gainAt({ type: "highpass", frequency: 30, Q: BUTTERWORTH_Q }, 10)).toBeLessThan(-18);
  });
});

describe("filterSamples", () => {
  it("starts from rest with b0, and settles at the DC gain", () => {
    const c = biquadCoefficients({ type: "lowpass", frequency: 1000, Q: BUTTERWORTH_Q }, RATE);
    const impulse = new Float32Array(4);
    impulse[0] = 1;
    expect(filterSamples(c, impulse)[0]).toBeCloseTo(c.b0, 6);
    const step = filterSamples(c, new Float32Array(4800).fill(1));
    expect(step.at(-1)).toBeCloseTo(1, 5);
  });
});
