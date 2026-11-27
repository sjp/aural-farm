import { describe, expect, it } from "vitest";
import { spaceSendDb } from "./chimes";

describe("spaceSendDb", () => {
  it("runs from −16 dB at 0 to −4 dB at 100", () => {
    expect(spaceSendDb(0)).toBe(-16);
    expect(spaceSendDb(50)).toBeCloseTo(-10);
    expect(spaceSendDb(100)).toBeCloseTo(-4);
    expect(spaceSendDb(200)).toBeCloseTo(-4);
  });
});
