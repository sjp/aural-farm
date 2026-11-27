import { describe, expect, it } from "vitest";
import { defaults } from "../params";
import { train } from "./train";
import { trainMeta } from "./train.meta";

const params = (change: Record<string, number | string> = {}) => ({
  ...defaults(trainMeta.params),
  ...change,
});

describe("train.loopPeriod", () => {
  it("is the time between rail joints", () => {
    expect(train.loopPeriod?.(params({ speed: 90 }))).toBeCloseTo(18.3 / 25);
    expect(train.loopPeriod?.(params({ speed: 160 }))).toBeCloseTo(18.3 / (160 / 3.6));
  });

  it("is undefined on welded track or with no clacks", () => {
    expect(train.loopPeriod?.(params({ track: "welded" }))).toBeUndefined();
    expect(train.loopPeriod?.(params({ clacks: 0 }))).toBeUndefined();
  });
});
