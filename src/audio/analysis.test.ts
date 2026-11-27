import { describe, expect, it } from "vitest";
import { kWeightedLoudness } from "./analysis";

const RATE = 48000;

/** A sine at `frequency` whose RMS is `rmsDb` dBFS. */
function sine(frequency: number, rmsDb: number, seconds = 2): Float32Array {
  const amplitude = Math.SQRT2 * 10 ** (rmsDb / 20);
  return Float32Array.from(
    { length: seconds * RATE },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE),
  );
}

describe("kWeightedLoudness", () => {
  it("reads a 997 Hz sine at −20 dBFS RMS as about −20 LUFS", () => {
    expect(kWeightedLoudness([sine(997, -20)], RATE, 0.5)).toBeCloseTo(-20, 1);
  });

  it("sums the channels' power", () => {
    const tone = sine(997, -20);
    expect(kWeightedLoudness([tone, tone], RATE, 0.5)).toBeCloseTo(-20 + 10 * Math.log10(2), 1);
  });

  it("weights low frequencies down and high ones up", () => {
    expect(kWeightedLoudness([sine(30, -20)], RATE, 1)).toBeLessThan(-25);
    expect(kWeightedLoudness([sine(4000, -20)], RATE, 0.5)).toBeGreaterThan(-17);
  });

  it("only measures 48 kHz audio", () => {
    expect(() => kWeightedLoudness([sine(997, -20)], 44100)).toThrow("48000");
  });
});
