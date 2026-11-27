import { describe, expect, it } from "vitest";
import { hash32 } from "../random";
import {
  BLOCK_SECONDS,
  type EventBlock,
  blockOf,
  createEventBlock,
  eventHash,
  eventsInBlock,
  offsetInBlock,
} from "./events";

const offsetsOf = (block: EventBlock) => Array.from(block.offsets.subarray(0, block.count));

describe("eventsInBlock", () => {
  it("gives the same events for the same block, whatever was asked before", () => {
    const a = createEventBlock(64);
    const b = createEventBlock(64);
    eventsInBlock(1, 2, 7, 10, a);
    const first = offsetsOf(a);
    for (let block = 0; block < 7; block++) {
      eventsInBlock(1, 2, block, 10, b);
    }
    eventsInBlock(1, 2, 7, 10, b);
    expect(offsetsOf(b)).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("differs between seeds, streams and blocks", () => {
    const block = createEventBlock(64);
    const of = (seed: number, stream: number, index: number) => {
      eventsInBlock(seed, stream, index, 20, block);
      return offsetsOf(block);
    };
    const base = of(1, 1, 1);
    expect(of(2, 1, 1)).not.toEqual(base);
    expect(of(1, 2, 1)).not.toEqual(base);
    expect(of(1, 1, 2)).not.toEqual(base);
  });

  it.each([0.5, 3, 40, 900])("keeps offsets sorted and within the block at %d/s", (rate) => {
    const block = createEventBlock(4096);
    for (let index = -20; index < 200; index++) {
      eventsInBlock(3, 1, index, rate, block);
      const offsets = offsetsOf(block);
      expect(offsets).toEqual(offsets.toSorted((x, y) => x - y));
      expect(offsets.every((t) => t >= 0 && t < 1)).toBe(true);
    }
  });

  it.each([0.2, 2, 15, 120, 900])("averages %d events a second over 10 000 blocks", (rate) => {
    const block = createEventBlock(4096);
    const blocks = 10_000;
    let sum = 0;
    let squares = 0;
    for (let index = 0; index < blocks; index++) {
      const count = eventsInBlock(5, 1, index, rate, block);
      sum += count;
      squares += count * count;
    }
    const mean = sum / blocks;
    // The mean of 10 000 Poisson counts has a standard deviation of sqrt(rate / 10 000).
    expect(Math.abs(mean - rate)).toBeLessThan(4 * Math.sqrt(rate / blocks));
    // A Poisson count's variance equals its mean.
    const variance = squares / blocks - mean * mean;
    expect(variance / rate).toBeGreaterThan(0.9);
    expect(variance / rate).toBeLessThan(1.1);
  });

  it("spreads events evenly through the block", () => {
    const block = createEventBlock(256);
    const bins = Array.from({ length: 10 }, () => 0);
    for (let index = 0; index < 2000; index++) {
      eventsInBlock(8, 1, index, 50, block);
      for (const t of offsetsOf(block)) {
        bins[Math.floor(t * 10)]++;
      }
    }
    const total = bins.reduce((a, b) => a + b, 0);
    for (const count of bins) {
      expect(Math.abs(count / total - 0.1)).toBeLessThan(0.01);
    }
  });

  it.each([0, -3, Number.NaN])("gives no events at a rate of %d", (rate) => {
    const block = createEventBlock(8);
    expect(eventsInBlock(1, 1, 1, rate, block)).toBe(0);
    expect(block.count).toBe(0);
  });

  it("stops at the block's capacity", () => {
    const block = createEventBlock(5);
    expect(eventsInBlock(1, 1, 1, 500, block)).toBe(5);
    expect(offsetsOf(block)).toEqual(offsetsOf(block).toSorted((x, y) => x - y));
  });
});

describe("eventHash", () => {
  it("depends on each coordinate and nothing else", () => {
    const h = eventHash(1, 2, 3, 4);
    expect(eventHash(1, 2, 3, 4)).toBe(h);
    expect(
      new Set([h, eventHash(9, 2, 3, 4), eventHash(1, 9, 3, 4), eventHash(1, 2, 9, 4)]).size,
    ).toBe(4);
    expect(eventHash(1, 2, 3, 5)).not.toBe(h);
    // Different from a plain hash of the same coordinates, which a sound may use itself.
    expect(h).not.toBe(hash32(1, 2, 3, 4));
  });
});

describe("blockOf and offsetInBlock", () => {
  it.each([44100, 48000])("split absolute samples into whole seconds at %d Hz", (sampleRate) => {
    expect(blockOf(0, sampleRate)).toBe(0);
    expect(blockOf(sampleRate - 1, sampleRate)).toBe(0);
    expect(blockOf(sampleRate * BLOCK_SECONDS, sampleRate)).toBe(1);
    expect(blockOf(-1, sampleRate)).toBe(-1);
    expect(offsetInBlock(sampleRate * 3 + sampleRate / 2, sampleRate)).toBeCloseTo(0.5, 12);
    expect(offsetInBlock(-sampleRate / 4, sampleRate)).toBeCloseTo(0.75, 12);
  });
});
