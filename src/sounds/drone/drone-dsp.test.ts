import { describe, expect, it } from "vitest";
import { bandEnergyDb } from "../../audio/analysis";
import {
  CUTOFF_RANGE,
  crossfadeGains,
  cutoffFor,
  DroneKernel,
  EVEN_DB,
  FADE_SHARE,
  FASTEST_PERIOD,
  HARMONICS,
  harmonicLevel,
  noteFrequency,
  NOTES,
  readDroneOptions,
  sawTable,
  SIDE_CENTS,
  slotPeriod,
  slotVoicing,
  SLOWEST_PERIOD,
  VOICINGS,
  WANDER_CENTS,
} from "./drone-dsp";
import type { DroneKey } from "./drone.meta";

const SR = 48000;
const QUANTUM = 128;
const KEYS: readonly DroneKey[] = ["c", "cs", "d", "eb", "e", "f", "fs", "g", "ab", "a", "bb", "b"];

const peakOf = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

interface Settings {
  key?: DroneKey;
  seed?: number;
  brightness?: number;
  movement?: number;
  sampleRate?: number;
}

/** Renders `seconds` from absolute second `from` with `kernel`, a quantum at a time. */
function renderWith(
  kernel: DroneKernel,
  seconds: number,
  from: number,
  sampleRate = SR,
): [Float32Array, Float32Array] {
  const length = Math.round(seconds * sampleRate);
  const start = Math.round(from * sampleRate);
  const out: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  const left = new Float32Array(QUANTUM);
  const right = new Float32Array(QUANTUM);
  for (let done = 0; done < length; done += QUANTUM) {
    kernel.render(left, right, start + done);
    out[0].set(left.subarray(0, length - done), done);
    out[1].set(right.subarray(0, length - done), done);
  }
  return out;
}

function kernelFor({
  key = "d",
  seed = 1,
  brightness = 35,
  movement = 40,
  sampleRate = SR,
}: Settings = {}): DroneKernel {
  const kernel = new DroneKernel(key, seed, sampleRate);
  kernel.set(brightness, movement);
  return kernel;
}

/** Renders `seconds` from absolute second `from` with a fresh kernel. */
function render(seconds: number, settings: Settings = {}, from = 0): [Float32Array, Float32Array] {
  return renderWith(kernelFor(settings), seconds, from, settings.sampleRate);
}

describe("voicing table", () => {
  it("has five voicings of five rising notes", () => {
    expect(VOICINGS).toHaveLength(5);
    for (const voicing of VOICINGS) {
      expect(voicing).toHaveLength(NOTES);
      for (let i = 1; i < voicing.length; i++) {
        expect(voicing[i]).toBeGreaterThan(voicing[i - 1] ?? 0);
      }
    }
  });

  it.each(KEYS)("%s: every note lies between 40 Hz and 1.2 kHz", (key) => {
    for (let v = 0; v < VOICINGS.length; v++) {
      for (let note = 0; note < NOTES; note++) {
        const f = noteFrequency(key, v, note);
        expect(f).toBeGreaterThan(40);
        expect(f).toBeLessThan(1200);
      }
    }
  });

  it.each(KEYS)("%s: the saw's top harmonic stays below 20 kHz, detuned and wandering", (key) => {
    const widest = 2 ** ((SIDE_CENTS + WANDER_CENTS) / 1200);
    for (let v = 0; v < VOICINGS.length; v++) {
      for (let note = 0; note < NOTES; note++) {
        expect(noteFrequency(key, v, note) * widest * HARMONICS).toBeLessThan(20000);
      }
    }
  });

  it("roots D on D2", () => {
    expect(noteFrequency("d", 0, 0)).toBeCloseTo(73.42, 1);
    expect(noteFrequency("c", 2, 0)).toBeCloseTo(49, 0);
  });
});

describe("saw", () => {
  /** The amplitude of harmonic `h` in the table, by a DFT over one cycle. */
  function harmonic(table: Float32Array, h: number): number {
    const size = table.length - 1;
    let re = 0;
    let im = 0;
    for (let m = 0; m < size; m++) {
      const angle = (2 * Math.PI * h * m) / size;
      re += (table[m] ?? 0) * Math.cos(angle);
      im += (table[m] ?? 0) * Math.sin(angle);
    }
    return (2 * Math.hypot(re, im)) / size;
  }

  it("falls as 1/n, the even harmonics 2 dB lower, and stops at 24", () => {
    const table = sawTable();
    const fundamental = harmonic(table, 1);
    for (let h = 2; h <= HARMONICS; h++) {
      expect(harmonic(table, h) / fundamental).toBeCloseTo(harmonicLevel(h), 4);
    }
    expect(harmonic(table, HARMONICS + 1)).toBeLessThan(1e-5);
    expect(harmonicLevel(2) / harmonicLevel(3)).toBeCloseTo((3 / 2) * 10 ** (EVEN_DB / 20), 6);
  });

  it("has unit RMS and wraps round", () => {
    const table = sawTable();
    const size = table.length - 1;
    let power = 0;
    for (let m = 0; m < size; m++) {
      power += (table[m] ?? 0) ** 2;
    }
    expect(Math.sqrt(power / size)).toBeCloseTo(1, 4);
    expect(table[size]).toBeCloseTo(table[0], 5);
  });
});

describe("slots", () => {
  it("run from 120 s at Movement 0 to 30 s at 100", () => {
    expect(slotPeriod(0)).toBeCloseTo(SLOWEST_PERIOD);
    expect(slotPeriod(100)).toBeCloseTo(FASTEST_PERIOD);
    expect(slotPeriod(40)).toBeGreaterThan(60);
    expect(slotPeriod(40)).toBeLessThan(75);
    expect(slotPeriod(-5)).toBeCloseTo(SLOWEST_PERIOD);
    expect(slotPeriod(Number.NaN)).toBeCloseTo(SLOWEST_PERIOD);
  });

  it.each([1, 2, 3, 17, 999])(
    "seed %i: each slot's voicing is a pure function of seed and n",
    (seed) => {
      const first = Array.from({ length: 60 }, (_, n) => slotVoicing(seed, n - 10));
      // In any order, so nothing carries over from one call to the next.
      const again = Array.from({ length: 60 }, (_, n) => slotVoicing(seed, 49 - n)).toReversed();
      expect(again).toEqual(first);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: no voicing plays twice running", (seed) => {
    for (let n = -50; n < 500; n++) {
      expect(slotVoicing(seed, n)).not.toBe(slotVoicing(seed, n - 1));
    }
  });

  it("plays every voicing once in each cycle of five", () => {
    for (let cycle = -2; cycle < 50; cycle++) {
      const voicings = Array.from({ length: 5 }, (_, i) => slotVoicing(3, 5 * cycle + i));
      expect(voicings.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("orders the voicings differently for each seed", () => {
    const order = (seed: number) => Array.from({ length: 20 }, (_, n) => slotVoicing(seed, n));
    expect(order(1)).not.toEqual(order(2));
  });
});

describe("crossfade", () => {
  it("is equal-power everywhere", () => {
    for (let x = -0.1; x <= 1.1; x += 0.01) {
      const [incoming, outgoing] = crossfadeGains(x);
      expect(incoming ** 2 + outgoing ** 2).toBeCloseTo(1, 9);
    }
    expect(crossfadeGains(0)).toEqual([0, 1]);
    expect(crossfadeGains(1)).toEqual([1, 0]);
    expect(crossfadeGains(0.5)[0]).toBeCloseTo(Math.SQRT1_2);
  });

  it("is equal-power in the kernel, fading over the first third of each slot", () => {
    const kernel = kernelFor({ movement: 100 });
    renderWith(kernel, 1, 0);
    for (let t = 0; t < FASTEST_PERIOD; t += 0.5) {
      const [a, b] = kernel.groupGains(t);
      expect(a ** 2 + b ** 2).toBeCloseTo(1, 9);
    }
    // Slot 0 plays on group A, fading in over 10 s, then holding.
    expect(kernel.groupGains(0)).toEqual([0, 1]);
    expect(kernel.groupGains(FASTEST_PERIOD * FADE_SHARE)).toEqual([1, 0]);
    expect(kernel.groupGains(25)).toEqual([1, 0]);
  });
});

describe("filter", () => {
  it("runs from 350 Hz at Brightness 0 to 3.2 kHz at 100, log-mapped", () => {
    expect(cutoffFor(0)).toBeCloseTo(CUTOFF_RANGE[0]);
    expect(cutoffFor(100)).toBeCloseTo(CUTOFF_RANGE[1]);
    expect(cutoffFor(50)).toBeCloseTo(Math.sqrt(CUTOFF_RANGE[0] * CUTOFF_RANGE[1]));
    expect(cutoffFor(Number.NaN)).toBeCloseTo(CUTOFF_RANGE[0]);
  });

  it("lets more through as Brightness rises", () => {
    const highs = (brightness: number) => {
      const [left] = render(4, { brightness }, 10);
      return bandEnergyDb(left, SR, 1500, 8000) - bandEnergyDb(left, SR, 0, SR / 2);
    };
    expect(highs(100) - highs(0)).toBeGreaterThan(20);
  });
});

describe("options", () => {
  it("reads the key, seed and offset, falling back to safe defaults", () => {
    expect(readDroneOptions({ key: "fs", seed: 7.6, offset: 3 })).toEqual({
      key: "fs",
      seed: 7,
      offset: 3,
    });
    expect(readDroneOptions({ key: "h", seed: "x" })).toEqual({ key: "d", seed: 0, offset: 0 });
    expect(readDroneOptions(undefined)).toEqual({ key: "d", seed: 0, offset: 0 });
  });
});

describe("kernel", () => {
  it("is deterministic per seed, and differs between seeds", () => {
    const [a] = render(2, { seed: 4 }, 30);
    const [b] = render(2, { seed: 4 }, 30);
    const [c] = render(2, { seed: 5 }, 30);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it.each([
    { brightness: 0, movement: 0 },
    { brightness: 100, movement: 0 },
    { brightness: 100, movement: 100 },
    { brightness: 0, movement: 100 },
  ])("stays finite and well under full scale at %o, through a crossfade", (params) => {
    for (const key of ["c", "b"] as const) {
      // Through slot 0's crossfade from the slot before.
      const [left, right] = render(12, { key, ...params }, 0);
      expect(left.every((x) => Number.isFinite(x)) && right.every((x) => Number.isFinite(x))).toBe(
        true,
      );
      expect(Math.max(peakOf(left), peakOf(right))).toBeLessThan(0.5);
      expect(peakOf(left)).toBeGreaterThan(0.01);
    }
  });

  it("renders the same from any start, once its filter has settled", () => {
    const whole = render(8, {}, 60);
    const later = render(4, {}, 64);
    const offset = 4 * SR;
    // A few milliseconds in, the fresh render's filter has settled.
    let worst = 0;
    for (let i = SR / 50; i < later[0].length; i++) {
      worst = Math.max(worst, Math.abs(later[0][i] - whole[0][offset + i]));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("sounds the same at 44.1 kHz as at 48 kHz", () => {
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
    const [at48] = render(4, {}, 40);
    const [at44] = render(4, { sampleRate: 44100 }, 40);
    expect(20 * Math.log10(rms(at44) / rms(at48))).toBeCloseTo(0, 0);
  });

  it("changes a group's chord only while that group is silent", () => {
    const kernel = kernelFor({ movement: 100 });
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    // Each group's gain as the quantum in which it took a new chord began.
    const gainsAtChanges: number[] = [];
    for (let start = 0; start < 200 * SR; start += QUANTUM) {
      const before = kernel.state.voicings;
      // The gains as the quantum begins, before any slot starting within it.
      const gains = kernel.groupGains(start / SR);
      kernel.render(left, right, start);
      const after = kernel.state.voicings;
      for (const g of [0, 1] as const) {
        if (start > 0 && after[g] !== before[g]) {
          gainsAtChanges.push(gains[g]);
        }
      }
    }
    // A chord change every 30 s, each on a silent group.
    expect(gainsAtChanges.length).toBeGreaterThanOrEqual(5);
    expect(gainsAtChanges.every((g) => g === 0)).toBe(true);
  });

  it("brings the next change forward when Movement rises, never into a crossfade", () => {
    // Movement 0: slots of 120 s, slot 0's crossfade over its first 40 s.
    const kernel = kernelFor({ movement: 0 });
    renderWith(kernel, 1, 50);
    expect(kernel.state.slot).toBe(0);
    // At 50 s, in the hold, Movement 100 asks for 30 s slots: the change comes at once.
    kernel.set(35, 100);
    renderWith(kernel, 1, 51);
    expect(kernel.state.slot).toBe(1);
    // Then every 30 s.
    renderWith(kernel, 30, 52);
    expect(kernel.state.slot).toBe(2);
  });

  it("lets a crossfade under way finish before the next change", () => {
    const kernel = kernelFor({ movement: 0 });
    renderWith(kernel, 1, 10);
    kernel.set(35, 100);
    // Slot 0's crossfade runs to 40 s at the old pace, and the next change waits for it.
    const [left] = renderWith(kernel, 29, 11);
    expect(kernel.state.slot).toBe(0);
    expect(kernel.groupGains(39.9)[0]).toBeLessThan(1);
    renderWith(kernel, 1, 40);
    expect(kernel.state.slot).toBe(1);
    // No jump in level as the change applies.
    let worst = 0;
    for (let i = 1; i < left.length; i++) {
      worst = Math.max(worst, Math.abs((left[i] ?? 0) - (left[i - 1] ?? 0)));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it("keeps the next change's time when Movement falls", () => {
    const kernel = kernelFor({ movement: 100 });
    renderWith(kernel, 1, 15);
    kernel.set(35, 0);
    renderWith(kernel, 15, 16);
    // Slot 1 still starts at 30 s; then the 120 s period applies.
    expect(kernel.state.slot).toBe(1);
    renderWith(kernel, 100, 31);
    expect(kernel.state.slot).toBe(1);
    renderWith(kernel, 20, 131);
    expect(kernel.state.slot).toBe(2);
  });
});
