import { describe, expect, it } from "vitest";
import { FakeAudioContext } from "../test/fake-audio";
import { dbToGain, gainToDb, glide } from "./glide";

describe("glide", () => {
  it("holds the value where it is, then glides from there", () => {
    const ctx = new FakeAudioContext();
    const gain = ctx.createGain();
    glide(gain.gain, 0, 0, 0.1);
    // Interrupt half-way with a new target.
    glide(gain.gain, 2, 0.1, 0.1);
    const atInterrupt = Math.exp(-1);
    expect(gain.gain.valueAt(0.1)).toBeCloseTo(atInterrupt, 6);
    expect(gain.gain.valueAt(0.2)).toBeCloseTo(2 + (atInterrupt - 2) * Math.exp(-1), 6);
    expect(gain.gain.calls.map((c) => c.method)).toEqual([
      "cancelAndHoldAtTime",
      "setTargetAtTime",
      "cancelAndHoldAtTime",
      "setTargetAtTime",
    ]);
    expect(gain.gain.assignments).toEqual([]);
  });

  it("falls back to holding the current value where cancelAndHoldAtTime is missing", () => {
    const ctx = new FakeAudioContext();
    const gain = ctx.createGain();
    Object.defineProperty(gain.gain, "cancelAndHoldAtTime", { value: undefined });
    glide(gain.gain, 0.5, 0, 0.05);
    expect(gain.gain.calls.map((c) => c.method)).toEqual([
      "cancelScheduledValues",
      "setValueAtTime",
      "setTargetAtTime",
    ]);
    expect(gain.gain.valueAt(10)).toBeCloseTo(0.5, 9);
  });
});

describe("dbToGain and gainToDb", () => {
  it("convert both ways", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 12);
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(gainToDb(dbToGain(-37))).toBeCloseTo(-37, 9);
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });
});
