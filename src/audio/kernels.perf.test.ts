import { describe, expect, it } from "vitest";
import { DriftGenerator } from "./drift-dsp";
import { NOISE_COLOURS, NoiseGenerator } from "./noise-dsp";
import { REVERB_KINDS, reverbImpulse } from "./reverb";

/**
 * Times the shared worklet kernels per second of audio, run as a worklet would:
 * one 128-sample render quantum at a time, at 48 kHz, and prints each cost as a
 * percentage of real time (one layer's budget is 0.2–1.5 %, see the README).
 * Also times generating each reverb impulse, which happens once per context.
 */
const SR = 48000;
const QUANTUM = 128;
const SECONDS = 20;

function costOf(renderQuantum: (start: number) => void): number {
  // Warm up, so the JIT has compiled the loop.
  for (let n = 0; n < SR * 2; n += QUANTUM) {
    renderQuantum(n);
  }
  const begin = performance.now();
  for (let n = 0; n < SR * SECONDS; n += QUANTUM) {
    renderQuantum(n);
  }
  const ms = performance.now() - begin;
  return ms / (SECONDS * 1000);
}

const report = (name: string, fraction: number) => {
  console.warn(`${name}: ${(fraction * 100).toFixed(3)} % of real time`);
};

describe("kernel cost", () => {
  it.each(NOISE_COLOURS)("stereo %s noise", (colour) => {
    const gen = new NoiseGenerator(colour, 1, 1, 2, SR);
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    const cost = costOf((n) => {
      gen.render(0, left, n);
      gen.render(1, right, n);
    });
    report(`stereo ${colour} noise`, cost);
    expect(cost).toBeLessThan(0.01);
  });

  it.each([1, 3])("drift with %d octaves", (octaves) => {
    const gen = new DriftGenerator(1, 1, 0.5, octaves, SR);
    const out = new Float32Array(QUANTUM);
    const cost = costOf((n) => {
      gen.render(out, n);
    });
    report(`drift, ${String(octaves)} octaves`, cost);
    expect(cost).toBeLessThan(0.01);
  });
});

describe("reverb impulse generation", () => {
  it.each(REVERB_KINDS)("%s takes a few milliseconds", (kind) => {
    reverbImpulse(kind, SR);
    const begin = performance.now();
    reverbImpulse(kind, SR);
    const ms = performance.now() - begin;
    console.warn(`${kind} impulse: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(50);
  });
});
