import { describe, expect, it } from "vitest";
import { spaceSendDb } from "./bowls";

describe("spaceSendDb", () => {
  it("runs from −14 dB at 0 to −3 dB at 100", () => {
    expect(spaceSendDb(0)).toBe(-14);
    expect(spaceSendDb(50)).toBeCloseTo(-8.5);
    expect(spaceSendDb(100)).toBeCloseTo(-3);
    expect(spaceSendDb(200)).toBeCloseTo(-3);
  });
});
