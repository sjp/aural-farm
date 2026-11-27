import { describe, expect, it } from "vitest";
import { defaults } from "../params";
import { engineCore } from "./engine-core";
import { engineCoreMeta } from "./engine-core.meta";

const params = (change: Record<string, number> = {}) => ({
  ...defaults(engineCoreMeta.params),
  ...change,
});

describe("engineCore.loopPeriod", () => {
  it("is the throb's period", () => {
    expect(engineCore.loopPeriod?.(params({ pulseRate: 0.8 }))).toBeCloseTo(1.25);
    expect(engineCore.loopPeriod?.(params({ pulseRate: 1.6 }))).toBeCloseTo(0.625);
  });

  it("is undefined without a throb", () => {
    expect(engineCore.loopPeriod?.(params({ pulseDepth: 0 }))).toBeUndefined();
  });
});
