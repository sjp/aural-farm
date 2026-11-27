import { describe, expect, it } from "vitest";
import { VoicePool, type PoolVoice } from "./voices";

interface TestVoice extends PoolVoice {
  id: number;
  level: number;
}

const makePool = (size: number) => new VoicePool<TestVoice>(size, (i) => ({ id: i, level: 0 }));

describe("VoicePool", () => {
  it("makes every voice up front and hands out idle ones first", () => {
    const pool = makePool(3);
    expect(pool.size).toBe(3);
    const a = pool.allocate();
    const b = pool.allocate();
    expect(a).not.toBe(b);
    expect(pool.active).toBe(2);
    expect(pool.live.slice(0, pool.active)).toEqual([a, b]);
  });

  it("steals the quietest voice when full", () => {
    const pool = makePool(3);
    const voices = [pool.allocate(), pool.allocate(), pool.allocate()];
    voices.forEach((v, i) => {
      v.level = [0.5, 0.1, -0.8][i] ?? 0;
    });
    expect(pool.allocate()).toBe(voices[1]);
    expect(pool.active).toBe(3);
  });

  it("releases a voice so it can be reused, keeping the active ones together", () => {
    const pool = makePool(3);
    const [a, b, c] = [pool.allocate(), pool.allocate(), pool.allocate()];
    pool.release(0);
    expect(pool.active).toBe(2);
    expect(new Set(pool.live.slice(0, 2))).toEqual(new Set([b, c]));
    expect(pool.allocate()).toBe(a);
  });

  it("ignores a release outside the active voices", () => {
    const pool = makePool(2);
    pool.allocate();
    pool.release(1);
    pool.release(-1);
    expect(pool.active).toBe(1);
  });

  it("allows releasing while iterating backwards", () => {
    const pool = makePool(4);
    for (let i = 0; i < 4; i++) {
      pool.allocate().level = i;
    }
    for (let i = pool.active - 1; i >= 0; i--) {
      if ((pool.live[i]?.level ?? 0) % 2 === 0) {
        pool.release(i);
      }
    }
    expect(
      pool.live
        .slice(0, pool.active)
        .map((v) => v.level)
        .toSorted((x, y) => x - y),
    ).toEqual([1, 3]);
  });

  it("refuses to allocate from an empty pool", () => {
    expect(() => makePool(0).allocate()).toThrow(RangeError);
  });
});
