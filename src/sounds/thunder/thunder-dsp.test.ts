import { describe, expect, it } from "vitest";
import { Svf } from "../../audio/dsp/svf";
import { hash32 } from "../../audio/random";
import {
  candidateRate,
  CRACK_DISTANCE,
  crackDb,
  firstRumbleTime,
  guard,
  MAX_LENGTH,
  MEAN_GAPS,
  PEAK_LIMIT_DB,
  PRESENCE_DB,
  presenceCentre,
  readThunderOptions,
  RumbleSchedule,
  RumbleShape,
  rumbleCutoff,
  sendDb,
  SPACING,
  ThunderKernel,
} from "./thunder-dsp";
import type { ThunderOften } from "./thunder.meta";

const SR = 48000;
const QUANTUM = 128;
const OFTEN = Object.keys(MEAN_GAPS) as ThunderOften[];

interface Settings {
  seed?: number;
  often?: ThunderOften;
  distance?: number;
  roll?: number;
  sampleRate?: number;
}

function kernel({
  seed = 1,
  often = "sometimes",
  distance = 15,
  roll = 50,
  sampleRate = SR,
}: Settings) {
  const k = new ThunderKernel(seed, sampleRate);
  k.set(MEAN_GAPS[often], distance, roll);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: ThunderKernel, from: number, to: number) {
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

const peakOf = (x: Float32Array, from = 0, to = x.length) => {
  let peak = 0;
  for (let i = from; i < to; i++) {
    peak = Math.max(peak, Math.abs(x[i] ?? 0));
  }
  return peak;
};

const db = (gain: number) => 20 * Math.log10(gain);

/** Every rumble start (absolute seconds) in blocks `from` to `to`. */
function rumbleStarts(seed: number, gap: number, from: number, to: number): number[] {
  const schedule = new RumbleSchedule(seed);
  const starts: number[] = [];
  for (let b = from; b < to; b++) {
    schedule.load(b, gap);
    for (let i = 0; i < schedule.count; i++) {
      starts.push(b + (schedule.offsets[i] ?? 0));
    }
  }
  return starts;
}

describe("schedule", () => {
  it("is the same for a seed and differs between seeds", () => {
    const a = rumbleStarts(1, MEAN_GAPS.storm, 0, 3000);
    expect(rumbleStarts(1, MEAN_GAPS.storm, 0, 3000)).toEqual(a);
    expect(rumbleStarts(2, MEAN_GAPS.storm, 0, 3000)).not.toEqual(a);
  });

  it.each(OFTEN)("keeps the mean gap near its target when %s", (often) => {
    const gap = MEAN_GAPS[often];
    const starts = rumbleStarts(1, gap, 0, 100_000);
    const mean = ((starts.at(-1) ?? 0) - (starts[0] ?? 0)) / (starts.length - 1);
    expect(Math.abs(mean / gap - 1)).toBeLessThan(0.1);
  });

  it.each(OFTEN)("never starts two rumbles within the spacing when %s", (often) => {
    const gap = MEAN_GAPS[often];
    const starts = rumbleStarts(3, gap, 0, 100_000);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(SPACING * gap);
    }
  });

  it.each([1, 2, 3, 999])("starts with one rumble 1.5–2.5 s in at seed %d", (seed) => {
    const first = firstRumbleTime(seed);
    expect(first).toBeGreaterThanOrEqual(1.5);
    expect(first).toBeLessThan(2.5);
    const starts = rumbleStarts(seed, MEAN_GAPS.storm, -5, 60);
    expect(starts[0]).toBeCloseTo(first, 9);
    expect((starts[1] ?? Infinity) - first).toBeGreaterThanOrEqual(SPACING * MEAN_GAPS.storm);
  });

  it("has no candidates for no gap", () => {
    expect(candidateRate(0)).toBe(0);
  });
});

describe("rumble shapes", () => {
  const hashes = Array.from({ length: 300 }, (_, i) => hash32(7, i));

  /** The envelope of the whole output: the rumble with its presence, and the crack, in power. */
  function envelope(shape: RumbleShape, t: number): number {
    shape.at(t);
    const presence = 10 ** (PRESENCE_DB / 10);
    return Math.sqrt((1 + presence) * shape.rumbleLevel ** 2 + shape.crackLevel ** 2);
  }

  it.each([
    [0, 2, 3],
    [50, 3, 6],
    [100, 5, 8],
  ])("at roll %d has %d to %d sub-rolls", (roll, fewest, most) => {
    const shape = new RumbleShape();
    const counts = new Set<number>();
    for (const hash of hashes) {
      shape.build(hash, 15, roll);
      counts.add(shape.count);
    }
    expect(Math.min(...counts)).toBe(fewest);
    expect(Math.max(...counts)).toBe(most);
  });

  it.each([0, 50, 100])("never lasts longer than the look-back at roll %d", (roll) => {
    const shape = new RumbleShape();
    for (const hash of hashes) {
      shape.build(hash, 0, roll);
      expect(shape.length).toBeLessThanOrEqual(MAX_LENGTH);
      shape.at(shape.length - 1e-6);
      expect(shape.rumbleLevel).toBeLessThan(1e-3 * shape.peak);
    }
  });

  it("grows longer and rolls more with roll", () => {
    const shape = new RumbleShape();
    const mean = (roll: number) =>
      hashes.reduce((sum, hash) => {
        shape.build(hash, 15, roll);
        return sum + shape.length;
      }, 0) / hashes.length;
    expect(mean(100)).toBeGreaterThan(mean(0) + 3);
  });

  it.each([0, 59, 60, 100])("swells in gently at distance %d", (distance) => {
    const shape = new RumbleShape();
    for (const hash of hashes) {
      shape.build(hash, distance, 50);
      const step = 0.001;
      let peak = 0;
      for (let t = 0; t < shape.length; t += step) {
        peak = Math.max(peak, envelope(shape, t));
      }
      let quiet = Number.NaN;
      let loud = Number.NaN;
      for (let t = 0; Number.isNaN(loud); t += step) {
        const e = envelope(shape, t);
        if (Number.isNaN(quiet) && e >= peak * 0.01) {
          quiet = t;
        }
        if (e >= peak * 0.5) {
          loud = t;
        }
      }
      expect(loud - quiet).toBeGreaterThanOrEqual(0.15);
    }
  });

  it.each([0, 30, 59])("has no crack at distance %d", (distance) => {
    const shape = new RumbleShape();
    for (const hash of hashes.slice(0, 20)) {
      shape.build(hash, distance, 50);
      expect(shape.crack).toBe(0);
    }
  });

  it("has a crack from distance 60, louder nearer", () => {
    const shape = new RumbleShape();
    shape.build(hashes[0] ?? 0, CRACK_DISTANCE, 50);
    const at60 = shape.crack / shape.peak;
    shape.build(hashes[0] ?? 0, 100, 50);
    const at100 = shape.crack / shape.peak;
    expect(db(at60)).toBeCloseTo(-14, 6);
    expect(db(at100)).toBeCloseTo(-6, 6);
    expect(crackDb(59)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("brightens nearer", () => {
    expect(rumbleCutoff(0)).toBeCloseTo(70, 6);
    expect(rumbleCutoff(100)).toBeCloseTo(180, 6);
    expect(presenceCentre(0)).toBeCloseTo(160, 6);
    expect(presenceCentre(100)).toBeCloseTo(450, 6);
    expect(sendDb(0)).toBe(-14);
    expect(sendDb(100)).toBe(-22);
  });
});

describe("guard", () => {
  it("leaves quiet samples alone and never passes its ceiling", () => {
    expect(guard(0.3)).toBe(0.3);
    expect(guard(-0.3)).toBe(-0.3);
    const ceiling = 10 ** (PEAK_LIMIT_DB / 20);
    let previous = 0;
    for (let x = 0; x < 10; x += 0.01) {
      const y = guard(x);
      expect(y).toBeLessThanOrEqual(ceiling);
      expect(y).toBeGreaterThanOrEqual(previous);
      expect(guard(-x)).toBe(-y);
      previous = y;
    }
  });
});

describe("kernel", () => {
  it("is silent before the first rumble, then rumbles", () => {
    const first = firstRumbleTime(1);
    const { left, right } = render(kernel({}), 0, 8 * SR);
    const start = Math.floor(first * SR);
    expect(peakOf(left, 0, start)).toBe(0);
    expect(peakOf(right, 0, start)).toBe(0);
    expect(peakOf(left, start)).toBeGreaterThan(0.01);
  });

  it("renders the same for a seed, and differently for another", () => {
    const a = render(kernel({ seed: 4 }), 0, 4 * SR);
    expect(render(kernel({ seed: 4 }), 0, 4 * SR)).toEqual(a);
    expect(render(kernel({ seed: 5 }), 0, 4 * SR).left).not.toEqual(a.left);
  });

  it("renders a rumble crossing a chunk seam the same in one chunk and in two", () => {
    const seam = Math.floor((firstRumbleTime(1) + 3) * SR);
    const end = seam + 4 * SR;
    const whole = render(kernel({}), 0, end);
    render(kernel({}), 0, seam);
    const late = render(kernel({}), seam, end);
    const signal = peakOf(whole.left, seam, end);
    expect(signal).toBeGreaterThan(0.01);
    let worst = 0;
    for (let i = 0; i < end - seam; i++) {
      worst = Math.max(
        worst,
        Math.abs((whole.left[seam + i] ?? 0) - (late.left[i] ?? 0)),
        Math.abs((whole.right[seam + i] ?? 0) - (late.right[i] ?? 0)),
      );
    }
    expect(db(worst / signal)).toBeLessThan(-80);
  });

  it("latches distance and roll per rumble", () => {
    const first = firstRumbleTime(2);
    const change = Math.floor((first + 1) * SR);
    const end = change + 3 * SR;
    const steady = render(kernel({ seed: 2 }), 0, end);
    const k = kernel({ seed: 2 });
    const before = render(k, 0, change);
    k.set(MEAN_GAPS.sometimes, 100, 100);
    const after = render(k, change, end);
    expect(before.left).toEqual(steady.left.subarray(0, change));
    expect(after.left).toEqual(steady.left.subarray(change));
  });

  it.each([0, 30, 59])(
    "keeps the band above 600 Hz quiet at a rumble's start at distance %d",
    (distance) => {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const start = Math.floor(firstRumbleTime(seed) * SR);
        const { left, right } = render(kernel({ seed, distance }), 0, start + 12 * SR);
        const peak = Math.max(peakOf(left), peakOf(right));
        for (const channel of [left, right]) {
          const highpass = [new Svf(SR, 600), new Svf(SR, 600)];
          let high = 0;
          for (let i = start; i < start + 0.2 * SR; i++) {
            let x = channel[i] ?? 0;
            for (const svf of highpass) {
              svf.tick(x);
              x = svf.high;
            }
            high = Math.max(high, Math.abs(x));
          }
          expect(db(high / peak)).toBeLessThan(-18);
        }
      }
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "stays finite and under −6 dBFS over 25 storm rumbles at distance 100 (seed %d)",
    (seed) => {
      const k = kernel({ seed, often: "storm", distance: 100 });
      const ceiling = 10 ** (PEAK_LIMIT_DB / 20);
      const seconds = 25 * MEAN_GAPS.storm;
      const chunk = 10 * SR;
      let finite = true;
      let peak = 0;
      for (let n = 0; n < seconds * SR; n += chunk) {
        const { left, right } = render(k, n, n + chunk);
        for (const channel of [left, right]) {
          finite &&= channel.every((v) => Number.isFinite(v));
          peak = Math.max(peak, peakOf(channel));
        }
      }
      expect(finite).toBe(true);
      expect(rumbleStarts(seed, MEAN_GAPS.storm, 0, seconds).length).toBeGreaterThanOrEqual(20);
      // The output is single precision.
      expect(peak).toBeLessThanOrEqual(Math.fround(ceiling));
    },
  );

  it("keeps its level at 44.1 kHz", () => {
    const power = (sampleRate: number) => {
      const { left, right } = render(kernel({ seed: 3, sampleRate }), 0, 20 * sampleRate);
      let sum = 0;
      for (const channel of [left, right]) {
        for (const v of channel) {
          sum += v * v;
        }
      }
      return 10 * Math.log10(sum / (20 * sampleRate));
    };
    expect(Math.abs(power(44100) - power(SR))).toBeLessThan(1);
  });
});

describe("options", () => {
  it("falls back to safe defaults", () => {
    expect(readThunderOptions(undefined)).toEqual({ seed: 0, offset: 0 });
    expect(readThunderOptions({ seed: 4.7, offset: 2 })).toEqual({ seed: 4, offset: 2 });
  });
});
