import { describe, expect, it } from "vitest";
import { defaults } from "../params";
import { heartbeat, muffleCutoff } from "./heartbeat";
import { heartbeatMeta } from "./heartbeat.meta";

const params = (change: Record<string, number> = {}) => ({
  ...defaults(heartbeatMeta.params),
  ...change,
});

describe("heartbeat.loopPeriod", () => {
  it("is one beat", () => {
    expect(heartbeat.loopPeriod?.(params())).toBeCloseTo(60 / 64);
    expect(heartbeat.loopPeriod?.(params({ rate: 50 }))).toBeCloseTo(1.2);
    expect(heartbeat.loopPeriod?.(params({ rate: 90 }))).toBeCloseTo(2 / 3);
  });
});

describe("muffleCutoff", () => {
  it("runs from 1.6 kHz at 0 to 320 Hz at 100, evenly in pitch", () => {
    expect(muffleCutoff(0)).toBeCloseTo(1600);
    expect(muffleCutoff(50)).toBeCloseTo(Math.sqrt(1600 * 320));
    expect(muffleCutoff(100)).toBeCloseTo(320);
    expect(muffleCutoff(150)).toBeCloseTo(320);
  });
});
