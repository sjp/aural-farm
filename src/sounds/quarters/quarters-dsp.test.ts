import { describe, expect, it } from "vitest";
import { DriftGenerator } from "../../audio/drift-dsp";
import {
  AIR_FLOOR_DB,
  airGain,
  BED_LEFT,
  BED_RIGHT,
  CUTOFF_AIRY,
  CUTOFF_DARK,
  guard,
  HULL_RANGES,
  hullFrequencies,
  HUM,
  HUM_DRIFT_OCTAVES,
  HUM_HARMONICS,
  HUM_LEVEL,
  HUM_SINE,
  HUM_STEP_DB,
  HUM_UNDER_VENT_DB,
  HUM_WANDER,
  HUM_WANDER_DRIFT_RATE,
  HUM_WANDER_STREAM,
  humGain,
  humRms,
  humRolloff,
  humWave,
  QUARTERS_CHANNELS,
  QuartersKernel,
  readQuartersOptions,
  VENT_DB,
  ventCutoff,
  WANDER_SWING,
} from "./quarters-dsp";

const SR = 48000;
const QUANTUM = 128;

const db = (x: number) => 20 * Math.log10(x);

interface Settings {
  seed?: number;
  air?: number;
  hull?: number;
  warmth?: number;
  sampleRate?: number;
}

function kernel({ seed = 1, air = 60, hull = 40, warmth = 60, sampleRate = SR }: Settings = {}) {
  const k = new QuartersKernel(seed, sampleRate);
  k.set(air, hull, warmth);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: QuartersKernel, from: number, to: number): Float32Array[] {
  const out = Array.from({ length: QUARTERS_CHANNELS }, () => new Float32Array(to - from));
  const quantum = Array.from({ length: QUARTERS_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    k.render(quantum, n);
    quantum.forEach((b, c) => {
      out[c]?.set(b.subarray(0, Math.min(QUANTUM, to - n)), n - from);
    });
  }
  return out;
}

const rms = (x: Float32Array, from = 0) => {
  let sum = 0;
  for (let i = from; i < x.length; i++) {
    sum += (x[i] ?? 0) ** 2;
  }
  return Math.sqrt(sum / (x.length - from));
};

const peakOf = (x: Float32Array) => x.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0);

describe("hull frequencies", () => {
  const SEEDS = [0, 1, 2, 3, 17, 99, 512, 999];

  it("are the same for the same seed", () => {
    expect(hullFrequencies(7)).toEqual(hullFrequencies(7));
  });

  it("differ for different seeds", () => {
    const sets = new Set(SEEDS.map((seed) => hullFrequencies(seed).join(",")));
    expect(sets.size).toBe(SEEDS.length);
  });

  it.each(SEEDS)("seed %i picks one frequency inside each range", (seed) => {
    const frequencies = hullFrequencies(seed);
    expect(frequencies).toHaveLength(HULL_RANGES.length);
    HULL_RANGES.forEach(([low, high], i) => {
      expect(frequencies[i]).toBeGreaterThanOrEqual(low);
      expect(frequencies[i]).toBeLessThan(high);
    });
  });
});

describe("engine hum", () => {
  it("has harmonics 1–5, each 4 dB under the last, plus a sine on the fundamental", () => {
    const { real, imag } = humWave();
    expect(imag).toHaveLength(HUM_HARMONICS + 1);
    expect(real.every((r) => r === 0)).toBe(true);
    for (let k = 1; k <= HUM_HARMONICS; k++) {
      const level = (imag[k] ?? 0) / humRolloff(HUM * k);
      const expected = 10 ** ((HUM_STEP_DB * (k - 1)) / 20) + (k === 1 ? HUM_SINE : 0);
      expect(level).toBeCloseTo(expected, 10);
    }
  });

  it("rolls off steeply through the hull, but harmonics 4 and 5 still carry", () => {
    expect(db(humRolloff(HUM))).toBeGreaterThan(-1);
    expect(db(humRolloff(4 * HUM))).toBeLessThan(-6);
    expect(db(humRolloff(5 * HUM))).toBeLessThan(-10);
    const { imag } = humWave();
    // Against the fundamental, harmonics 4 and 5 are faint but well above silence.
    expect(db((imag[5] ?? 0) / (imag[1] ?? 1))).toBeGreaterThan(-40);
  });

  it("is off at 0 and 10 dB under the ventilation's full level at 100", () => {
    expect(humGain(0)).toBe(0);
    expect(db(humGain(100) * humRms())).toBeCloseTo(VENT_DB + HUM_UNDER_VENT_DB, 6);
  });

  it.each([1, 2, 3, 17, 999])(
    "seed %i wanders by no more than 2 cents over a long listen",
    (seed) => {
      const drift = new DriftGenerator(
        seed,
        HUM_WANDER_STREAM,
        HUM_WANDER_DRIFT_RATE,
        HUM_DRIFT_OCTAVES,
        SR,
      );
      let slope = 0;
      for (let t = 0; t < 20000; t += 1) {
        slope = Math.max(slope, Math.abs(drift.valueAtTime(t + 0.5) - drift.valueAtTime(t - 0.5)));
      }
      const cents = 1200 * Math.log2(1 + slope * WANDER_SWING);
      expect(cents).toBeLessThanOrEqual(2);
    },
  );
});

describe("param mappings", () => {
  it("darkens the vent from 700 Hz at Warmth 0 to 220 Hz at 100", () => {
    expect(ventCutoff(0)).toBeCloseTo(CUTOFF_AIRY, 9);
    expect(ventCutoff(100)).toBeCloseTo(CUTOFF_DARK, 9);
    expect(ventCutoff(50)).toBeCloseTo(Math.sqrt(CUTOFF_AIRY * CUTOFF_DARK), 9);
  });

  it("keeps the vent 18 dB down at Ventilation 0, never silent", () => {
    expect(airGain(100)).toBe(1);
    expect(db(airGain(0))).toBeCloseTo(AIR_FLOOR_DB, 9);
    expect(db(airGain(50))).toBeCloseTo(AIR_FLOOR_DB / 2, 9);
  });
});

describe("kernel", () => {
  const seconds = (s: number) => Math.round(s * SR);

  it("is the same for the same seed and differs for another", () => {
    const a = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const b = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const c = render(kernel({ seed: 5 }), 0, seconds(0.5));
    expect(a).toEqual(b);
    expect(a[BED_LEFT]).not.toEqual(c[BED_LEFT]);
  });

  it("is the same rendered afresh from a later sample, once its filters settle", () => {
    const from = seconds(3);
    const whole = render(kernel(), 0, seconds(5));
    const later = render(kernel(), from, seconds(5));
    const settle = seconds(1);
    for (const channel of [BED_LEFT, BED_RIGHT, HUM_LEVEL, HUM_WANDER]) {
      const a = whole[channel]?.subarray(from + settle) ?? new Float32Array();
      const b = later[channel]?.subarray(settle) ?? new Float32Array();
      const difference = a.map((v, i) => v - (b[i] ?? 0));
      expect(db(rms(difference) / rms(a))).toBeLessThan(-40);
    }
  });

  it("keeps its channels apart: decorrelated sides", () => {
    const [left = new Float32Array(), right = new Float32Array()] = render(
      kernel({ hull: 0 }),
      0,
      seconds(4),
    );
    let lr = 0;
    for (let i = 0; i < left.length; i++) {
      lr += (left[i] ?? 0) * (right[i] ?? 0);
    }
    const correlation = lr / (rms(left) * rms(right) * left.length);
    expect(Math.abs(correlation)).toBeLessThan(0.15);
  });

  it("sits near its level at the defaults", () => {
    const out = render(kernel(), 0, seconds(8));
    const level = db(rms(out[BED_LEFT] ?? new Float32Array(), seconds(0.5)));
    // The vent at Ventilation 60 and its pink band, with the hull at 40 under them.
    expect(level).toBeGreaterThan(VENT_DB - 8);
    expect(level).toBeLessThan(VENT_DB - 4);
  });

  it.each([0, 100])("keeps its level within 1.5 dB at Warmth %i", (warmth) => {
    const at = (w: number) =>
      db(
        rms(
          render(kernel({ warmth: w, hull: 0 }), 0, seconds(8))[BED_LEFT] ?? new Float32Array(),
          seconds(0.5),
        ),
      );
    expect(Math.abs(at(warmth) - at(60))).toBeLessThan(1.5);
  });

  it.each([
    { air: 100, hull: 100, warmth: 0 },
    { air: 100, hull: 100, warmth: 100 },
    { air: 0, hull: 0, warmth: 0 },
  ])("stays finite and bounded at Ventilation $air, Hull $hull, Warmth $warmth", (settings) => {
    const out = render(kernel(settings), 0, seconds(6));
    for (const channel of out) {
      expect(channel.every((v) => Number.isFinite(v))).toBe(true);
    }
    expect(peakOf(out[BED_LEFT] ?? new Float32Array())).toBeLessThan(0.65);
    expect(peakOf(out[BED_RIGHT] ?? new Float32Array())).toBeLessThan(0.65);
  });

  it("drifts the hum's level and pitch within ±1", () => {
    const out = render(kernel(), 0, seconds(2));
    for (const channel of [HUM_LEVEL, HUM_WANDER]) {
      expect(peakOf(out[channel] ?? new Float32Array())).toBeLessThanOrEqual(1);
    }
  });

  it("follows the same params to the same level at 44.1 and 48 kHz", () => {
    const level = (sampleRate: number) =>
      db(
        rms(
          render(kernel({ sampleRate }), 0, Math.round(8 * sampleRate))[BED_LEFT] ??
            new Float32Array(),
          Math.round(0.5 * sampleRate),
        ),
      );
    expect(Math.abs(level(44100) - level(48000))).toBeLessThan(0.5);
  });
});

describe("guard", () => {
  it("leaves the bed alone below its knee", () => {
    for (const x of [0, 0.1, -0.3, 0.44]) {
      expect(guard(x)).toBe(x);
    }
  });

  it("bends the rarest peaks smoothly, never past 4.5 dB under full scale", () => {
    let last = guard(0.4);
    for (let x = 0.4; x <= 4; x += 0.01) {
      const y = guard(x);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(10 ** (-4.5 / 20));
      expect(guard(-x)).toBe(-y);
      last = y;
    }
  });
});

describe("options", () => {
  it("reads the seed and offset, with safe defaults", () => {
    expect(readQuartersOptions({ seed: 12.7, offset: 3.5 })).toEqual({ seed: 12, offset: 3.5 });
    expect(readQuartersOptions(undefined)).toEqual({ seed: 0, offset: 0 });
    expect(readQuartersOptions({ seed: "x", offset: Number.NaN })).toEqual({ seed: 0, offset: 0 });
  });
});
