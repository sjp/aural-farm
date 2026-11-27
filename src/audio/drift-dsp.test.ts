import { describe, expect, it } from "vitest";
import {
  DriftGenerator,
  MAX_DRIFT_CHANNELS,
  MAX_DRIFT_OCTAVES,
  readDriftOptions,
} from "./drift-dsp";

const SR = 48000;

function render(gen: DriftGenerator, start: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 128) {
    gen.render(out.subarray(i, Math.min(i + 128, length)), start + i);
  }
  return out;
}

describe("DriftGenerator", () => {
  it("is deterministic per seed and stream", () => {
    const a = render(new DriftGenerator(1, 1, 0.5, 2, SR), 0, SR);
    expect(render(new DriftGenerator(1, 1, 0.5, 2, SR), 0, SR)).toEqual(a);
    expect(render(new DriftGenerator(2, 1, 0.5, 2, SR), 0, SR)).not.toEqual(a);
    expect(render(new DriftGenerator(1, 2, 0.5, 2, SR), 0, SR)).not.toEqual(a);
  });

  it("is time-addressable: a render from block k matches a render from 0 exactly", () => {
    const whole = render(new DriftGenerator(3, 1, 2, 3, SR), 0, 4 * SR);
    // Not on the drift's grid, nor on a render quantum.
    const k = 12345;
    const late = render(new DriftGenerator(3, 1, 2, 3, SR), k, 4 * SR - k);
    expect(late).toEqual(whole.subarray(k));
  });

  it("follows the exact curve closely between grid points", () => {
    const gen = new DriftGenerator(4, 1, 5, 3, SR);
    for (let n = 0; n < SR; n += 37) {
      expect(Math.abs(gen.valueAt(n) - gen.valueAtTime(n / SR))).toBeLessThan(1e-3);
    }
  });

  it.each([1, 2, 3])("stays in [−1, 1] and uses most of it with %d octaves", (octaves) => {
    const gen = new DriftGenerator(5, 1, 20, octaves, SR);
    let lo = 0;
    let hi = 0;
    let finite = true;
    for (let n = -SR * 50; n < SR * 50; n += 16) {
      const v = gen.valueAt(n);
      finite &&= Number.isFinite(v);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(finite).toBe(true);
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(1);
  });

  it("moves smoothly: no jumps between samples", () => {
    const out = render(new DriftGenerator(6, 1, 3, 3, SR), 0, 2 * SR);
    let biggest = 0;
    for (let i = 1; i < out.length; i++) {
      biggest = Math.max(biggest, Math.abs((out[i] ?? 0) - (out[i - 1] ?? 0)));
    }
    expect(biggest).toBeLessThan(0.01);
  });

  it("moves at roughly its rate", () => {
    // Zero crossings of a slow drift: about one per knot or two.
    const gen = new DriftGenerator(7, 1, 1, 1, SR);
    let crossings = 0;
    let previous = gen.valueAt(0);
    for (let n = 64; n < SR * 200; n += 64) {
      const v = gen.valueAt(n);
      if (Math.sign(v) !== Math.sign(previous)) {
        crossings++;
      }
      previous = v;
    }
    expect(crossings / 200).toBeGreaterThan(0.3);
    expect(crossings / 200).toBeLessThan(1.5);
  });
});

describe("readDriftOptions", () => {
  it("reads valid options", () => {
    expect(
      readDriftOptions({
        seed: 2,
        drifts: [
          { stream: 3, rate: 0.05, octaves: 2 },
          { stream: 4, rate: 0.02, octaves: 1 },
        ],
        offset: -5,
      }),
    ).toEqual({
      seed: 2,
      drifts: [
        { stream: 3, rate: 0.05, octaves: 2 },
        { stream: 4, rate: 0.02, octaves: 1 },
      ],
      offset: -5,
    });
  });

  it("clamps and falls back", () => {
    expect(readDriftOptions({ drifts: [{ rate: -1, octaves: 9 }] })).toEqual({
      seed: 0,
      drifts: [{ stream: 0, rate: 1e-6, octaves: MAX_DRIFT_OCTAVES }],
      offset: 0,
    });
    expect(readDriftOptions(undefined).drifts).toEqual([{ stream: 0, rate: 0.1, octaves: 1 }]);
    expect(readDriftOptions({ drifts: [] }).drifts).toHaveLength(1);
  });

  it("runs at most MAX_DRIFT_CHANNELS drifts", () => {
    const drifts = Array.from({ length: MAX_DRIFT_CHANNELS + 3 }, (_, stream) => ({
      stream,
      rate: 0.1,
      octaves: 1,
    }));
    expect(readDriftOptions({ drifts }).drifts).toHaveLength(MAX_DRIFT_CHANNELS);
  });
});
