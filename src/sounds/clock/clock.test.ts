import { describe, expect, it } from "vitest";
import { defaults } from "../params";
import { clock, roomSendDb } from "./clock";
import { clockMeta } from "./clock.meta";

const params = (change: Record<string, number | string | boolean> = {}) => ({
  ...defaults(clockMeta.params),
  ...change,
});

describe("clock.loopPeriod", () => {
  it("is a tick and its tock", () => {
    expect(clock.loopPeriod?.(params())).toBeCloseTo(0.9);
    expect(clock.loopPeriod?.(params({ clock: "wall" }))).toBeCloseTo(1.5);
    expect(clock.loopPeriod?.(params({ clock: "grandfather" }))).toBeCloseTo(2);
  });
});

describe("roomSendDb", () => {
  it("runs from −40 dB at 0 to −10 dB at 100", () => {
    expect(roomSendDb(0)).toBe(-40);
    expect(roomSendDb(40)).toBeCloseTo(-28);
    expect(roomSendDb(100)).toBe(-10);
  });
});
