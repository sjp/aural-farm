import { describe, expect, it } from "vitest";
import { minnaertFrequency } from "../../audio/dsp/bubble";
import { createEventBlock, eventsInBlock } from "../../audio/dsp/events";
import {
  densityGain,
  DROP_PEAK_DB,
  dropRate,
  dropsDb,
  MAX_PLINK_FREQUENCY,
  outputCutoff,
  plinkDecay,
  RAIN_CHANNELS,
  RainGenerator,
  RainKernel,
  readRainOptions,
  sendDb,
  SURFACES,
  WARM_UP,
  washCutoff,
  washDb,
  weightLevel,
} from "./rain-dsp";
import { RAIN_SURFACES, type RainSurface } from "./rain.meta";

const SR = 48000;
const QUANTUM = 128;

interface Settings {
  surface?: RainSurface;
  seed?: number;
  intensity?: number;
  distance?: number;
  bubbles?: number;
}

function kernel({
  surface = "ground",
  seed = 1,
  intensity = 45,
  distance = 30,
  bubbles = 40,
}: Settings) {
  const k = new RainKernel(seed, surface, SR);
  k.set(dropRate(intensity, distance), bubbles / 100, 1, outputCutoff(distance));
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: RainKernel, from: number, to: number) {
  const left = new Float32Array(to - from);
  const right = new Float32Array(to - from);
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  for (let n = from; n < to; n += QUANTUM) {
    const length = Math.min(QUANTUM, to - n);
    const [bl, br] =
      length === QUANTUM ? [l, r] : [new Float32Array(length), new Float32Array(length)];
    k.render(bl, br, n);
    left.set(bl, n - from);
    right.set(br, n - from);
  }
  return { left, right };
}

const peak = (...channels: Float32Array[]) =>
  Math.max(...channels.map((c) => c.reduce((p, v) => Math.max(p, Math.abs(v)), 0)));
const maxDifference = (a: Float32Array, b: Float32Array) =>
  a.reduce((m, v, i) => Math.max(m, Math.abs(v - (b[i] ?? 0))), 0);
const allFinite = (c: Float32Array) => c.every((v) => Number.isFinite(v));

describe("param mappings", () => {
  it("gives 15, 120 and 900 drops per second at intensity 0, 50 and 100, halved far away", () => {
    expect(dropRate(0, 0)).toBeCloseTo(15);
    expect(dropRate(50, 0)).toBeCloseTo(120);
    expect(dropRate(100, 0)).toBeCloseTo(900);
    expect(dropRate(100, 100)).toBeCloseTo(450);
    expect(dropRate(25, 0)).toBeCloseTo(Math.sqrt(15 * 120));
  });

  it("raises the wash with intensity, and adds weight only above 50", () => {
    expect(washDb(0)).toBeLessThan(washDb(100));
    expect(weightLevel(50)).toBe(0);
    expect(weightLevel(100)).toBeCloseTo(10 ** (-14 / 20));
  });

  it("brightens the wash with intensity, darkens it with distance, and caps it on a window", () => {
    expect(washCutoff(0, 0, SURFACES.ground)).toBeCloseTo(4000);
    expect(washCutoff(100, 0, SURFACES.ground)).toBeCloseTo(7000);
    expect(washCutoff(0, 100, SURFACES.ground)).toBeCloseTo(1400);
    expect(washCutoff(100, 100, SURFACES.ground)).toBeCloseTo(2200);
    expect(washCutoff(100, 0, SURFACES.window)).toBe(3000);
  });

  it("moves the drops away with distance: quieter, duller, more reverb", () => {
    expect(dropsDb(0)).toBeCloseTo(0);
    expect(dropsDb(100)).toBe(-12);
    expect(outputCutoff(100)).toBeCloseTo(2000);
    expect(outputCutoff(0)).toBeCloseTo(18000);
    expect(sendDb(0)).toBe(-30);
    expect(sendDb(100)).toBe(-16);
  });

  it("thins each drop only above 120 drops per second", () => {
    expect(densityGain(100)).toBe(1);
    expect(densityGain(120 * 16)).toBeCloseTo(0.5);
  });

  it("decays plinks in 8 ms at 1.1 kHz to 2 ms at 4 kHz, faster for smaller bubbles", () => {
    expect(plinkDecay(1100)).toBeCloseTo(0.008);
    expect(plinkDecay(4000)).toBeCloseTo(0.002);
    expect(plinkDecay(2000)).toBeLessThan(plinkDecay(1500));
    // The smallest bubble's resonance is under the plinks' ceiling.
    expect(minnaertFrequency(0.0008)).toBeLessThan(MAX_PLINK_FREQUENCY);
  });

  it("reads processor options, falling back to open ground", () => {
    expect(readRainOptions({ seed: 4.7, surface: "roof", offset: 2 })).toEqual({
      seed: 4,
      surface: "roof",
      offset: 2,
    });
    expect(readRainOptions({ surface: "toString" })).toEqual({
      seed: 0,
      surface: "ground",
      offset: 0,
    });
    expect(readRainOptions(undefined).surface).toBe("ground");
  });
});

describe("drop schedule", () => {
  it.each([0, 45, 100])("averages the drop rate over 1 000 blocks at intensity %d", (intensity) => {
    const rate = dropRate(intensity, 0);
    const block = createEventBlock(4096);
    let total = 0;
    for (let b = 0; b < 1000; b++) {
      total += eventsInBlock(1, 10, b, rate, block);
    }
    expect(Math.abs(total / 1000 - rate) / rate).toBeLessThan(0.05);
  });
});

describe("RainKernel", () => {
  it("gives the same output for the same seed, params and start, and another for another seed", () => {
    const a = render(kernel({}), 0, SR);
    const b = render(kernel({}), 0, SR);
    const c = render(kernel({ seed: 2 }), 0, SR);
    expect(a.left).toEqual(b.left);
    expect(a.right).toEqual(b.right);
    expect(maxDifference(a.left, c.left)).toBeGreaterThan(1e-3);
  });

  it.each([
    ["light", 20],
    ["heavy", 90],
  ])(
    "renders 0–4 s in one go and in two chunks split at 1.37 s alike, tails across the seam included (%s)",
    (_, intensity) => {
      const settings = { intensity, distance: 0, bubbles: 100 };
      const seam = Math.round(1.37 * SR);
      const whole = render(kernel(settings), 0, 4 * SR);
      const first = render(kernel(settings), 0, seam);
      const second = render(kernel(settings), seam, 4 * SR);
      const left = new Float32Array(4 * SR);
      left.set(first.left);
      left.set(second.left, seam);
      const right = new Float32Array(4 * SR);
      right.set(first.right);
      right.set(second.right, seam);
      // Equal but for float rounding: voices may be summed in another order.
      expect(maxDifference(whole.left, left)).toBeLessThan(1e-6);
      expect(maxDifference(whole.right, right)).toBeLessThan(1e-6);
      // Something is sounding across the seam.
      expect(
        peak(second.left.subarray(0, SR / 1000), second.right.subarray(0, SR / 1000)),
      ).toBeGreaterThan(1e-4);
    },
  );

  it("picks up drops that started before its first sample, from any start", () => {
    const start = 10 * SR + 777;
    const late = render(kernel({ intensity: 90 }), start, start + SR / 2);
    const early = render(kernel({ intensity: 90 }), start - SR, start + SR / 2);
    expect(maxDifference(early.left.subarray(SR), late.left)).toBeLessThan(1e-6);
    expect(WARM_UP).toBeLessThan(1);
  });

  it("keeps a block's rate until the block ends", () => {
    const steady = kernel({ intensity: 20 });
    const changed = kernel({ intensity: 20 });
    const a = render(steady, 0, SR / 2);
    const b = render(changed, 0, SR / 2);
    expect(b.left).toEqual(a.left);
    changed.set(dropRate(100, 0), 0.4, 1, outputCutoff(30));
    const restOfBlock = [render(steady, SR / 2, SR), render(changed, SR / 2, SR)];
    expect(restOfBlock[1]?.left).toEqual(restOfBlock[0]?.left);
    const nextBlock = [render(steady, SR, 2 * SR), render(changed, SR, 2 * SR)];
    expect(
      maxDifference(
        nextBlock[0]?.left ?? new Float32Array(),
        nextBlock[1]?.left ?? new Float32Array(),
      ),
    ).toBeGreaterThan(1e-3);
  });

  it("lets the drops already sounding ring out when their level drops to 0", () => {
    const k = kernel({ intensity: 100, distance: 0 });
    render(k, 0, SR);
    k.set(dropRate(100, 0), 0.4, 0, outputCutoff(0));
    const after = render(k, SR, SR + WARM_UP * SR);
    expect(peak(after.left.subarray(0, SR / 1000))).toBeGreaterThan(1e-4);
    const tail = after.left.subarray(after.left.length - SR / 100);
    expect(peak(tail)).toBeLessThan(1e-6);
  });

  it("is silent without drops", () => {
    const k = new RainKernel(1, "ground", SR);
    k.set(0, 1, 1, outputCutoff(0));
    expect(peak(render(k, 0, SR).left)).toBe(0);
  });

  it.each(
    RAIN_SURFACES.flatMap(({ value }) => [
      [value, 0],
      [value, 100],
    ]),
  )(
    "stays finite and under −3 dBFS on %s at intensity %d, close, every drop plinking",
    (surface, intensity) => {
      const { left, right } = render(
        kernel({ surface, intensity, distance: 0, bubbles: 100 }),
        0,
        10 * SR,
      );
      expect(allFinite(left) && allFinite(right)).toBe(true);
      expect(peak(left, right)).toBeLessThan(10 ** (-3 / 20));
      expect(peak(left, right)).toBeGreaterThan(10 ** ((DROP_PEAK_DB - 30) / 20));
    },
  );

  it("works at 44.1 kHz", () => {
    const k = new RainKernel(1, "roof", 44100);
    k.set(dropRate(60, 0), 0.5, 1, outputCutoff(0));
    const left = new Float32Array(44100);
    const right = new Float32Array(44100);
    k.render(left, right, 0);
    expect(allFinite(left)).toBe(true);
    expect(peak(left, right)).toBeGreaterThan(0);
  });
});

describe("RainGenerator", () => {
  it("fills the noise, drops and drift channels, finite and bounded", () => {
    const g = new RainGenerator(3, "leaves", SR);
    g.set(dropRate(45, 30), 0.4, 1, outputCutoff(30));
    const channels = Array.from({ length: RAIN_CHANNELS }, () => new Float32Array(QUANTUM));
    for (let n = 0; n < SR; n += QUANTUM) {
      g.render(channels, n);
    }
    for (const channel of channels) {
      expect(allFinite(channel)).toBe(true);
      expect(peak(channel)).toBeGreaterThan(0);
      expect(peak(channel)).toBeLessThanOrEqual(1);
    }
  });

  it("is the same from an absolute start whenever it begins, once the noise settles", () => {
    const a = new RainGenerator(1, "ground", SR);
    const b = new RainGenerator(1, "ground", SR);
    a.set(dropRate(45, 30), 0.4, 1, outputCutoff(30));
    b.set(dropRate(45, 30), 0.4, 1, outputCutoff(30));
    const early = Array.from({ length: RAIN_CHANNELS }, () => new Float32Array(QUANTUM));
    const late = Array.from({ length: RAIN_CHANNELS }, () => new Float32Array(QUANTUM));
    for (let n = 0; n <= SR; n += QUANTUM) {
      a.render(early, n);
    }
    b.render(late, SR);
    for (let c = 2; c < RAIN_CHANNELS; c++) {
      expect(
        maxDifference(early[c] ?? new Float32Array(), late[c] ?? new Float32Array()),
      ).toBeLessThan(1e-6);
    }
  });
});
