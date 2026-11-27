import { describe, expect, it } from "vitest";
import { commonPeriod, loopCrossfadeSeconds, planExport, snapLoopSeconds } from "./plan";

const RATE = 48000;

describe("planExport", () => {
  it("cuts a clip into 30 s chunks, each overlapping the one before by 50 ms", () => {
    const plan = planExport(75, false);
    expect(plan.frames).toBe(75 * RATE);
    expect(plan.crossfade).toBe(0);
    expect(plan.joined).toBe(75 * RATE);
    expect(plan.chunks.map((c) => [c.from / RATE, c.frames / RATE, c.overlap / RATE])).toEqual([
      [0, 30, 0],
      [29.95, 30.05, 0.05],
      [59.95, 15.05, 0.05],
    ]);
  });

  it("starts each chunk's context 5 s early, with the file starting at absolute time 5 s", () => {
    const plan = planExport(75, false);
    expect(plan.chunks.map((c) => c.preroll)).toEqual([5 * RATE, 5 * RATE, 5 * RATE]);
    const startAts = plan.chunks.map((c) => c.startAt);
    expect(startAts[0]).toBe(0);
    expect(startAts[1]).toBeCloseTo(29.95, 9);
    expect(startAts[2]).toBeCloseTo(59.95, 9);
    // The first kept frame of every chunk stands for its file time + 5 s.
    for (const chunk of plan.chunks) {
      expect(chunk.startAt + chunk.preroll / RATE).toBeCloseTo(chunk.from / RATE + 5, 9);
    }
  });

  it("covers every frame once, apart from the overlaps", () => {
    const plan = planExport(600, false);
    expect(plan.chunks).toHaveLength(20);
    let end = 0;
    for (const chunk of plan.chunks) {
      expect(chunk.from).toBe(end - chunk.overlap);
      end = chunk.from + chunk.frames;
    }
    expect(end).toBe(plan.frames);
  });

  it("folds a remainder under 1 s into the chunk before", () => {
    const plan = planExport(60.5, false);
    expect(plan.chunks.map((c) => (c.from + c.frames) / RATE)).toEqual([30, 60.5]);
  });

  it("plans a single chunk for a short clip", () => {
    expect(planExport(10, false).chunks).toEqual([
      { from: 0, frames: 10 * RATE, overlap: 0, preroll: 5 * RATE, startAt: 0 },
    ]);
  });

  it("adds a loop's tail as a last chunk, after the loop's end", () => {
    const plan = planExport(120, true);
    expect(plan.frames).toBe(120 * RATE);
    expect(plan.crossfade).toBe(5 * RATE);
    expect(plan.joined).toBe(125 * RATE);
    const tail = plan.chunks.at(-1);
    expect(tail).toMatchObject({ from: 119.95 * RATE, frames: 5.05 * RATE, overlap: 0.05 * RATE });
    expect(tail?.startAt).toBeCloseTo(119.95, 9);
  });

  it("works in frames at other rates", () => {
    const plan = planExport(30.5, false, 44100);
    expect(plan.chunks.map((c) => [c.from, c.frames])).toEqual([[0, 1345050]]);
    expect(plan.overlap).toBe(2205);
  });
});

describe("loopCrossfadeSeconds", () => {
  it.each([
    [30, 5],
    [600, 5],
    [12, 2],
  ])("is %d s → %d s", (length, crossfade) => {
    expect(loopCrossfadeSeconds(length)).toBe(crossfade);
  });
});

describe("commonPeriod", () => {
  it("is undefined without periods", () => {
    expect(commonPeriod([])).toBeUndefined();
    expect(commonPeriod([0, Number.NaN, -1])).toBeUndefined();
  });

  it("is the period when the layers agree", () => {
    expect(commonPeriod([1.25, 1.25])).toBe(1.25);
  });

  it("is the longest when the others divide it within 1 %", () => {
    expect(commonPeriod([1.25, 2.5])).toBe(2.5);
    expect(commonPeriod([1.255, 2.5, 0.5])).toBe(2.5);
  });

  it("is undefined when they disagree by more than 1 %", () => {
    expect(commonPeriod([1.25, 1.3])).toBeUndefined();
    expect(commonPeriod([1, 1.5])).toBeUndefined();
  });
});

describe("snapLoopSeconds", () => {
  it("leaves the length alone without a shared period", () => {
    expect(snapLoopSeconds(120, [])).toBe(120);
    expect(snapLoopSeconds(120, [1, 1.5])).toBe(120);
  });

  it("snaps to the nearest whole number of periods", () => {
    expect(snapLoopSeconds(120, [1 / 0.82])).toBeCloseTo(98 / 0.82, 9);
    expect(snapLoopSeconds(30, [1.25, 2.5])).toBe(30);
    expect(snapLoopSeconds(31, [2.5])).toBe(30);
  });

  it("keeps at least one period", () => {
    expect(snapLoopSeconds(1, [3])).toBe(3);
  });
});
