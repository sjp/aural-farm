import { describe, expect, it } from "vitest";
import {
  createRng,
  HASH_START,
  hash32,
  hashFloat,
  hashStep,
  lowbias32,
  UINT32_SCALE,
  type Rng,
} from "./random";

describe("lowbias32", () => {
  it("gives known values, so hashes are stable across platforms", () => {
    expect([0, 1, 2, 0xffffffff].map((x) => lowbias32(x))).toMatchInlineSnapshot(`
      [
        0,
        1753845952,
        3507691905,
        1734902346,
      ]
    `);
  });

  it("is a bijection on a sample of inputs", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100_000; i++) {
      seen.add(lowbias32(i));
    }
    expect(seen.size).toBe(100_000);
  });
});

describe("hash32", () => {
  it("is deterministic and depends on every argument and their order", () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(1, 2, 4));
    expect(hash32(1, 2, 3)).not.toBe(hash32(3, 2, 1));
    expect(hash32(0)).not.toBe(hash32());
    expect(hash32(0)).not.toBe(hash32(0, 0));
  });

  it("is an unsigned 32-bit integer", () => {
    for (let i = -50; i < 50; i++) {
      const h = hash32(i, 7);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    }
  });

  it("takes arguments modulo 2³², so negative integers work", () => {
    expect(hash32(-1)).toBe(hash32(0xffffffff));
    expect(hash32(2 ** 32 + 5)).toBe(hash32(5));
  });

  it("can be continued one argument at a time", () => {
    expect(hashStep(hash32(4, 5), 6)).toBe(hash32(4, 5, 6));
    expect(hashStep(hashStep(HASH_START, 4), 5)).toBe(hash32(4, 5));
  });
});

describe("hashFloat", () => {
  it("is in [0, 1) with a mean near 0.5", () => {
    let sum = 0;
    let min = 1;
    let max = 0;
    for (let i = 0; i < 100_000; i++) {
      const x = hashFloat(3, 1, i);
      sum += x;
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    expect(sum / 100_000).toBeCloseTo(0.5, 2);
    expect(hashFloat(1, 2)).toBe(hash32(1, 2) * UINT32_SCALE);
  });
});

describe("createRng", () => {
  it("repeats for the same seed and differs between seeds", () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const draws = (rng: Rng) => Array.from({ length: 5 }, rng.next);
    const first = draws(a);
    expect(draws(b)).toEqual(first);
    expect(draws(c)).not.toEqual(first);
  });

  it("gives floats in [0, 1) and ranges and integers within bounds", () => {
    const rng = createRng(1);
    let within = true;
    for (let i = 0; i < 10_000; i++) {
      const x = rng.next();
      const r = rng.range(-3, 5);
      const n = rng.int(6);
      within &&= x >= 0 && x < 1 && r >= -3 && r < 5 && Number.isInteger(n) && n >= 0 && n < 6;
    }
    expect(within).toBe(true);
  });

  it("gives standard normal values", () => {
    const rng = createRng(9);
    let sum = 0;
    let squares = 0;
    const count = 50_000;
    let finite = true;
    for (let i = 0; i < count; i++) {
      const g = rng.gaussian();
      finite &&= Number.isFinite(g);
      sum += g;
      squares += g * g;
    }
    expect(finite).toBe(true);
    expect(sum / count).toBeCloseTo(0, 1);
    expect(squares / count).toBeCloseTo(1, 1);
  });
});
