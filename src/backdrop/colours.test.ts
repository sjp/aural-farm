import { describe, expect, it } from "vitest";
import type { Layer, Mix } from "../mixes/mix";
import {
  MAX_POOLS,
  MIN_POOLS,
  NEUTRAL,
  parseHex,
  poolColours,
  tintWeights,
  type Rgb,
} from "./colours";

const RED = "#ff0000";
const BLUE = "#0000ff";

/** Matches a colour to 6 decimals. */
const near = (expected: Rgb): unknown[] => expected.map((v): unknown => expect.closeTo(v, 6));

const shining = (pools: ReturnType<typeof poolColours>) => pools.filter((p) => p.strength > 0);

describe("parseHex", () => {
  it("reads #rrggbb into 0–1", () => {
    expect(parseHex("#ff8000")).toEqual(near([1, 128 / 255, 0]));
    expect(parseHex("#4F7FD8")).toEqual(near([0x4f / 255, 0x7f / 255, 0xd8 / 255]));
  });

  it("reads anything else as black", () => {
    expect(parseHex("red")).toEqual([0, 0, 0]);
    expect(parseHex("#fff")).toEqual([0, 0, 0]);
  });
});

describe("tintWeights", () => {
  const layer = (id: string, volume = 100, muted = false): Layer => ({
    id,
    volume,
    muted,
    params: {},
  });
  const tints = new Map([
    ["a", RED],
    ["b", BLUE],
  ]);
  const mix = (...layers: Layer[]): Mix => ({ master: 100, layers });

  it("weights each tint by the layer's volume curve, and a muted layer by 0", () => {
    expect(
      tintWeights(mix(layer("a", 50), layer("b", 100, true)), tints, new Set(), false),
    ).toEqual([
      { tint: RED, gain: 0.25 },
      { tint: BLUE, gain: 0 },
    ]);
  });

  it("silences the layers a solo leaves out, and everything while muted", () => {
    const both = mix(layer("a"), layer("b"));
    expect(tintWeights(both, tints, new Set(["b"]), false).map((w) => w.gain)).toEqual([0, 1]);
    expect(tintWeights(both, tints, new Set(["gone"]), false).map((w) => w.gain)).toEqual([1, 1]);
    expect(tintWeights(both, tints, new Set(), true).map((w) => w.gain)).toEqual([0, 0]);
  });

  it("skips layers whose sound has no tint", () => {
    expect(tintWeights(mix(layer("x"), layer("a")), tints, new Set(), false)).toEqual([
      { tint: RED, gain: 1 },
    ]);
  });
});

describe("poolColours", () => {
  it("always gives MAX_POOLS pools", () => {
    for (let n = 0; n <= 8; n++) {
      const layers = Array.from({ length: n }, (_, i) => ({
        tint: `#${String(i + 1).repeat(6)}`,
        gain: 1,
      }));
      expect(poolColours(layers)).toHaveLength(MAX_POOLS);
    }
  });

  it("shows MIN_POOLS neutral pools for an empty or silent mix", () => {
    for (const layers of [[], [{ tint: RED, gain: 0 }]]) {
      const pools = poolColours(layers);
      expect(shining(pools)).toHaveLength(MIN_POOLS);
      for (const pool of shining(pools)) {
        expect(pool.colour).toEqual(NEUTRAL);
        expect(pool.strength).toBe(1);
      }
    }
  });

  it("fills MIN_POOLS pools from one tint", () => {
    const pools = shining(poolColours([{ tint: RED, gain: 1 }]));
    expect(pools).toHaveLength(MIN_POOLS);
    for (const pool of pools) {
      expect(pool.colour).toEqual(near([1, 0, 0]));
      expect(pool.strength).toBe(1);
    }
  });

  it("gives the louder of two tints the spare pool, in mix order", () => {
    const pools = shining(
      poolColours([
        { tint: RED, gain: 0.3 },
        { tint: BLUE, gain: 1 },
      ]),
    );
    expect(pools.map((p) => p.colour)).toEqual([
      [1, 0, 0],
      [0, 0, 1],
      [0, 0, 1],
    ]);
  });

  it("makes a quieter layer's pool weaker, down to 40 %", () => {
    const pools = shining(
      poolColours([
        { tint: RED, gain: 1 },
        { tint: BLUE, gain: 0.5 },
        { tint: "#00ff00", gain: 0.0001 },
      ]),
    );
    expect(pools.map((p) => p.strength)).toEqual([1, 0.7, expect.closeTo(0.40006, 4)]);
  });

  it("blends a quiet mix towards neutral", () => {
    const [pool] = poolColours([{ tint: RED, gain: 0.125 }]);
    expect(pool.colour).toEqual(near([(NEUTRAL[0] + 1) / 2, NEUTRAL[1] / 2, NEUTRAL[2] / 2]));
  });

  it("gives up to five tints a pool each", () => {
    const tints = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff"];
    const pools = poolColours(tints.map((tint) => ({ tint, gain: 1 })));
    expect(pools.map((p) => p.colour)).toEqual(tints.map((tint) => parseHex(tint)));
  });

  it("merges the closest tints past five layers, weighted by gain", () => {
    const pools = poolColours([
      { tint: "#ff0000", gain: 1 },
      { tint: "#00ff00", gain: 1 },
      { tint: "#0000ff", gain: 1 },
      { tint: "#ffff00", gain: 1 },
      { tint: "#00ffff", gain: 1 },
      // Close to red: it merges into red's pool, a quarter of the way to it.
      { tint: "#f00000", gain: 1 / 3 },
      // Close to blue.
      { tint: "#0000f0", gain: 1 },
    ]);
    expect(pools).toHaveLength(MAX_POOLS);
    expect(pools[0].colour).toEqual(near([0.75 + (0xf0 / 255) * 0.25, 0, 0]));
    expect(pools[2].colour).toEqual(near([0, 0, (1 + 0xf0 / 255) / 2]));
    expect(pools[2].strength).toBe(1);
    expect(pools[1].strength).toBeCloseTo(0.4 + 0.6 / 2);
  });
});
