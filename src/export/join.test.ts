import { describe, expect, it } from "vitest";
import { ChunkJoiner, equalGain, equalPower, LoopHead } from "./join";
import { planExport } from "./plan";

const RATE = 1000;

/** A stereo sine at `hz`, frames `from` to `from + length` of an endless one. */
function sine(from: number, length: number, hz = 3.7): Float32Array[] {
  return [0, 1].map((c) =>
    Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * hz * (from + i)) / RATE + c)),
  );
}

const concat = (blocks: readonly Float32Array[][], channel: number) => {
  const parts = blocks.map((b) => b[channel] ?? new Float32Array(0));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe("crossfade curves", () => {
  it.each([0, 0.1, 0.25, 0.5, 0.9, 1])("equal gain sums to 1 at %d", (t) => {
    const [out, into] = equalGain(t);
    expect(out + into).toBeCloseTo(1, 12);
  });

  it.each([0, 0.1, 0.25, 0.5, 0.9, 1])("equal power keeps the power at %d", (t) => {
    const [out, into] = equalPower(t);
    expect(out ** 2 + into ** 2).toBeCloseTo(1, 12);
  });

  it("runs from all outgoing to all incoming", () => {
    expect(equalGain(0)).toEqual([1, 0]);
    expect(equalPower(0)).toEqual([1, 0]);
    expect(equalGain(1)[1]).toBeCloseTo(1, 12);
    expect(equalPower(1)[1]).toBeCloseTo(1, 12);
    expect(equalPower(0.5)[0]).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe("ChunkJoiner", () => {
  it("joins chunks of a continuous sine into the same sine, with no discontinuity", () => {
    const plan = planExport(70, false, RATE);
    const joiner = new ChunkJoiner(plan.overlap);
    const blocks = plan.chunks.map((chunk) => joiner.push(sine(chunk.from, chunk.frames)));
    blocks.push(joiner.finish());
    for (const channel of [0, 1]) {
      const joined = concat(blocks, channel);
      const expected = sine(0, plan.frames)[channel];
      expect(joined).toHaveLength(plan.frames);
      let worst = 0;
      joined.forEach((v, i) => {
        worst = Math.max(worst, Math.abs(v - (expected[i] ?? 0)));
      });
      expect(worst).toBeLessThan(1e-6);
    }
  });

  it("crossfades smoothly from one chunk to the next when they differ", () => {
    const joiner = new ChunkJoiner(10);
    const ones = [new Float32Array(30).fill(1)];
    const zeros = [new Float32Array(30)];
    const first = joiner.push(ones);
    const second = joiner.push(zeros);
    expect(first[0]).toHaveLength(20);
    const fade = Array.from(second[0]?.subarray(0, 10) ?? []);
    expect(fade[0]).toBeGreaterThan(0.95);
    expect(fade.at(-1)).toBeLessThan(0.05);
    for (let i = 1; i < fade.length; i++) {
      expect(fade[i]).toBeLessThan(fade[i - 1] ?? 0);
    }
    expect(joiner.finish()[0]).toHaveLength(10);
  });

  it("refuses a chunk shorter than its overlap", () => {
    const joiner = new ChunkJoiner(10);
    joiner.push([new Float32Array(30)]);
    expect(() => joiner.push([new Float32Array(5)])).toThrow(RangeError);
  });
});

describe("LoopHead", () => {
  const length = 400;
  const crossfade = 100;
  /** A signal that keeps changing: a sine with a slow sweep, so no two stretches match. */
  const signal = Float32Array.from(
    { length: length + crossfade },
    (_, i) => Math.sin(i * 0.05 + i * i * 1e-4) * (1 + i / 1000),
  );

  function loop(blockSize: number): Float32Array {
    const head = new LoopHead([signal.slice(length)]);
    const out = signal.slice(0, length);
    for (let at = 0; at < length; at += blockSize) {
      const block = out.subarray(at, Math.min(length, at + blockSize));
      head.apply([block], at);
    }
    return out;
  }

  it("starts on the frame that followed the loop's last frame", () => {
    const out = loop(64);
    expect(out[0]).toBe(signal[length]);
    expect(out[length - 1]).toBe(signal[length - 1]);
  });

  it("repeats seamlessly: each frame across the loop point follows on from the one before", () => {
    const out = loop(64);
    const twice = [...out, ...out];
    const steps = twice.slice(1).map((v, i) => Math.abs(v - (twice[i] ?? 0)));
    const worst = Math.max(...steps);
    // The step at the loop point is no bigger than the signal's own steps.
    const own = Math.max(
      ...Array.from(signal.subarray(1), (v, i) => Math.abs(v - (signal[i] ?? 0))),
    );
    expect(Math.abs((twice[length] ?? 0) - (twice[length - 1] ?? 0))).toBeLessThanOrEqual(own);
    expect(worst).toBeLessThan(own * 1.5);
  });

  it("leaves the frames after the crossfade alone, whatever the block size", () => {
    const a = loop(7);
    const b = loop(1000);
    expect(a).toEqual(b);
    expect(a.subarray(crossfade)).toEqual(signal.subarray(crossfade, length));
  });

  it("mixes head and tail with equal power", () => {
    const out = loop(400);
    const n = crossfade / 2;
    const [fadeOut, fadeIn] = equalPower(n / crossfade);
    expect(out[n]).toBeCloseTo((signal[length + n] ?? 0) * fadeOut + (signal[n] ?? 0) * fadeIn, 6);
  });
});
