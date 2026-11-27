import { describe, expect, it } from "vitest";
import type { ParamValues } from "../types";
import { binaural } from "./binaural";
import { binauralMeta } from "./binaural.meta";

type BinauralParams = ParamValues<typeof binauralMeta.params>;

const defaults: BinauralParams = {
  preset: "alpha",
  beat: 10,
  carrier: 200,
  mode: "binaural",
  bed: 20,
  seed: 1,
};

/** Words that would say what the sound does to the listener, rather than what it is. */
const CLAIMS = ["boost", "improve", "heal", "cure", "enhance", "therapy", "entrain", "brainwave"];

describe("Binaural Beats metadata", () => {
  it("hints at headphones", () => {
    expect(binauralMeta.hint).toBe("Use headphones");
  });

  it.each(CLAIMS)("makes no claim: never says %s", (word) => {
    const words = [binauralMeta.description, ...binauralMeta.tags];
    for (const param of Object.values(binauralMeta.params)) {
      words.push(param.label);
      if ("options" in param) {
        words.push(...param.options.map((o) => o.label));
      }
    }
    const text = words.join(" ").toLowerCase();
    expect(text).not.toContain(word);
  });
});

describe("Binaural Beats loop period", () => {
  const period = (params: Partial<BinauralParams>) =>
    binaural.loopPeriod?.({ ...defaults, ...params });

  it("brings both default tones back in phase every 0.2 s (two beats)", () => {
    expect(period({})).toBeCloseTo(0.2, 12);
  });

  it("follows the custom beat only when Custom is picked", () => {
    expect(period({ beat: 6 })).toBeCloseTo(0.2, 12);
    expect(period({ preset: "custom", beat: 6 })).toBeCloseTo(1, 12);
  });

  it("brings the isochronic tone and its pulse back together", () => {
    expect(period({ mode: "isochronic" })).toBeCloseTo(0.1, 12);
    expect(period({ mode: "isochronic", preset: "custom", beat: 7.3 })).toBeCloseTo(10, 12);
  });
});
