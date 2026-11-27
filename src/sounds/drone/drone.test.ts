import { describe, expect, it } from "vitest";
import { spaceSendDb } from "./drone";

describe("spaceSendDb", () => {
  it("runs from −18 dB at 0 to −2 dB at 100", () => {
    expect(spaceSendDb(0)).toBe(-18);
    expect(spaceSendDb(50)).toBeCloseTo(-10);
    expect(spaceSendDb(100)).toBeCloseTo(-2);
    expect(spaceSendDb(200)).toBeCloseTo(-2);
  });
});
