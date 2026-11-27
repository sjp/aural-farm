import { describe, expect, it } from "vitest";
import { panLeft, panRight } from "./pan";

describe("equal-power pan", () => {
  it.each([-1, -0.5, 0, 0.3, 1])("keeps the power constant at %d", (pan) => {
    expect(panLeft(pan) ** 2 + panRight(pan) ** 2).toBeCloseTo(1, 12);
  });

  it("is −3 dB in the centre and hard at the ends, clamping beyond them", () => {
    expect(panLeft(0)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(panRight(0)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(panLeft(-1)).toBeCloseTo(1, 12);
    expect(panRight(-1)).toBeCloseTo(0, 12);
    expect(panRight(2)).toBeCloseTo(1, 12);
  });
});
