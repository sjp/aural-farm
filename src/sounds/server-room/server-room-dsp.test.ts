import { describe, expect, it } from "vitest";
import { DriftGenerator } from "../../audio/drift-dsp";
import {
  AIR_DB,
  airGain,
  AIRFLOW_RANGE_DB,
  BURST_RATE,
  compressorFrequency,
  fanVoice,
  fanVoices,
  hvacShare,
  PAN_REACH,
  readServerRoomOptions,
  SERVER_ROOM_CHANNELS,
  ServerRoomKernel,
  tickGap,
  ticksInBurst,
  WANDER_CENTS,
  wanderDelay,
  WHINE_DB,
  WHINE_LIMIT,
  whineDb,
  whineTones,
} from "./server-room-dsp";
import { MAX_RACKS } from "./server-room.meta";

const SR = 48000;
const QUANTUM = 128;

const db = (x: number) => 20 * Math.log10(x);
const seconds = (s: number, sampleRate = SR) => Math.round(s * sampleRate);
const rms = (a: Float32Array, from = 0) => {
  let sum = 0;
  for (let i = from; i < a.length; i++) {
    sum += (a[i] ?? 0) ** 2;
  }
  return Math.sqrt(sum / (a.length - from));
};
const peakOf = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

interface Settings {
  seed?: number;
  airflow?: number;
  racks?: number;
  hvac?: number;
  whine?: number;
  disks?: number;
  sampleRate?: number;
}

function kernel({
  seed = 1,
  airflow = 60,
  racks = 6,
  hvac = 45,
  whine = 15,
  disks = 0,
  sampleRate = SR,
}: Settings = {}) {
  const k = new ServerRoomKernel(seed, sampleRate);
  k.set(airflow, racks, hvac, whine, disks);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: ServerRoomKernel, from: number, to: number): Float32Array[] {
  const out = Array.from({ length: SERVER_ROOM_CHANNELS }, () => new Float32Array(to - from));
  const quantum = Array.from({ length: SERVER_ROOM_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    k.render(quantum, n);
    quantum.forEach((b, c) => {
      out[c]?.set(b.subarray(0, Math.min(QUANTUM, to - n)), n - from);
    });
  }
  return out;
}

/** The difference between two renders, in dB against the first. */
function differenceDb(a: Float32Array, b: Float32Array): number {
  return db(rms(a.map((v, i) => v - (b[i] ?? 0))) / rms(a));
}

describe("fan voices", () => {
  it.each([1, 2, 77, 999])("are the same each time for seed %i", (seed) => {
    expect(fanVoices(seed)).toEqual(fanVoices(seed));
    expect(fanVoices(seed)).not.toEqual(fanVoices(seed + 1));
  });

  it("builds each rack from its index alone, so a rack is the same at any count", () => {
    const voices = fanVoices(5);
    expect(voices).toHaveLength(MAX_RACKS);
    for (const [i, v] of voices.entries()) {
      expect(fanVoice(5, i)).toEqual(v);
    }
  });

  it.each([1, 3, 42, 500, 999])("keeps seed %i's fans in range", (seed) => {
    for (const [i, v] of fanVoices(seed).entries()) {
      expect(v.frequency).toBeGreaterThanOrEqual(290);
      expect(v.frequency).toBeLessThanOrEqual(430);
      // Every third rack has a small fan too.
      const inRange = v.small >= 1300 && v.small <= 2100;
      expect(i % 3 === 0 ? inRange : v.small === 0).toBe(true);
      expect(v.wanderRate).toBeGreaterThanOrEqual(0.02);
      expect(v.wanderRate).toBeLessThanOrEqual(0.05);
      expect(Math.abs(v.pan)).toBeLessThanOrEqual(PAN_REACH);
    }
  });

  it.each([1, 3, 42, 500])("spreads seed %i's pans across the aisle at any count", (seed) => {
    const voices = fanVoices(seed);
    const pans = voices.map((v) => v.pan);
    expect(Math.min(...pans)).toBeLessThan(-0.6);
    expect(Math.max(...pans)).toBeGreaterThan(0.6);
    // A single rack stands near the middle; two stand apart.
    expect(Math.abs(pans[0] ?? 1)).toBeLessThan(0.1);
    expect(Math.abs((pans[0] ?? 0) - (pans[1] ?? 0))).toBeGreaterThan(0.4);
  });

  it("puts a model's racks close enough to beat slowly", () => {
    const voices = fanVoices(8);
    for (let model = 0; model < MAX_RACKS; model += 3) {
      const speeds = voices.slice(model, model + 3).map((v) => v.frequency);
      expect(Math.max(...speeds) / Math.min(...speeds)).toBeLessThan(1.013);
    }
  });

  it.each([0.02, 0.035, 0.05])("keeps a fan's wander at %f Hz within ±8 cents", (rate) => {
    const delay = wanderDelay(rate);
    const drift = new DriftGenerator(9, 16, rate, 1, SR);
    const limit = 2 ** (WANDER_CENTS / 1200) - 1;
    let widest = 0;
    const dt = 0.01;
    for (let t = 0; t < 3000; t += dt) {
      // The pitch's ratio is 1 − the delay's slope.
      const slope = (delay * (drift.valueAtTime(t + dt) - drift.valueAtTime(t))) / dt;
      widest = Math.max(widest, Math.abs(slope));
    }
    expect(widest).toBeLessThanOrEqual(limit);
    expect(widest).toBeGreaterThan(0.5 * limit);
  });
});

describe("whine", () => {
  it.each(Array.from({ length: 40 }, (_, i) => 1 + 25 * i))(
    "never goes above 5.6 kHz for seed %i",
    (seed) => {
      const { first, second, pan } = whineTones(seed);
      expect(first).toBeGreaterThanOrEqual(3600);
      expect(first).toBeLessThanOrEqual(5200);
      expect(second).toBeGreaterThan(first);
      expect(second).toBeLessThanOrEqual(WHINE_LIMIT);
      expect(Math.abs(pan)).toBeLessThanOrEqual(0.3);
    },
  );

  it("is off at 0 and at most its cap at 100", () => {
    expect(whineDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(whineDb(100)).toBeCloseTo(WHINE_DB);
    expect(whineDb(25)).toBeCloseTo(WHINE_DB + 10 * Math.log10(0.25), 5);
    expect(whineDb(1000)).toBeCloseTo(WHINE_DB);
  });
});

describe("levels", () => {
  it("runs the air from 10 dB down at Airflow 0 to its level at 100", () => {
    expect(db(airGain(100))).toBeCloseTo(AIR_DB);
    expect(db(airGain(0))).toBeCloseTo(AIR_DB - AIRFLOW_RANGE_DB);
    expect(db(airGain(50))).toBeCloseTo(AIR_DB - AIRFLOW_RANGE_DB / 2);
  });

  it("turns the cooling off at 0", () => {
    expect(hvacShare(0)).toBe(0);
    expect(hvacShare(100)).toBe(1);
  });

  it("seeds the compressor at 48–56 Hz", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(compressorFrequency(seed)).toBeGreaterThanOrEqual(48);
      expect(compressorFrequency(seed)).toBeLessThanOrEqual(56);
    }
  });

  it.each([44100, 48000])("puts the air alone near its level at %i Hz", (sampleRate) => {
    const k = kernel({ airflow: 100, racks: 1, hvac: 0, whine: 0, sampleRate });
    const [left = new Float32Array()] = render(k, 0, seconds(20, sampleRate));
    // The single rack's tones add a little, and the air's drift moves it ±0.7 dB.
    expect(Math.abs(db(rms(left, seconds(0.5, sampleRate))) - AIR_DB)).toBeLessThan(1.5);
  });

  it("keeps the levels the same at 44.1 kHz and 48 kHz", () => {
    const at = (sampleRate: number) =>
      db(rms(render(kernel({ sampleRate }), 0, seconds(10, sampleRate))[0] ?? new Float32Array()));
    expect(Math.abs(at(44100) - at(48000))).toBeLessThan(0.5);
  });
});

describe("disk ticks", () => {
  it("bursts 2–7 ticks, 12–40 ms apart", () => {
    const counts = new Set<number>();
    for (let burst = 0; burst < 2000; burst++) {
      const count = ticksInBurst(burst * 7919);
      counts.add(count);
      for (let k = 1; k < count; k++) {
        const gap = tickGap(burst, k);
        expect(gap).toBeGreaterThanOrEqual(0.012);
        expect(gap).toBeLessThanOrEqual(0.04);
      }
    }
    expect([...counts].toSorted((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("adds ticks only when on, about as often as the rate says", () => {
    const length = seconds(120);
    const [on = new Float32Array()] = render(kernel({ disks: 1 }), 0, length);
    const [off = new Float32Array()] = render(kernel({ disks: 0 }), 0, length);
    let bursts = 0;
    let quiet = Number.POSITIVE_INFINITY;
    for (let i = 0; i < length; i++) {
      if (Math.abs((on[i] ?? 0) - (off[i] ?? 0)) > 1e-6) {
        if (quiet > seconds(0.1)) {
          bursts++;
        }
        quiet = 0;
      } else {
        quiet++;
      }
    }
    expect(bursts).toBeGreaterThan(0.4 * BURST_RATE * 120);
    expect(bursts).toBeLessThan(2 * BURST_RATE * 120);
  });

  it("peaks under the air's peaks", () => {
    const length = seconds(120);
    const settings = { airflow: 100, racks: 1, hvac: 0, whine: 0 };
    const [on = new Float32Array()] = render(kernel({ ...settings, disks: 1 }), 0, length);
    const [off = new Float32Array()] = render(kernel({ ...settings, disks: 0 }), 0, length);
    const ticks = on.map((v, i) => v - (off[i] ?? 0));
    expect(peakOf(ticks)).toBeGreaterThan(0);
    expect(db(peakOf(ticks))).toBeLessThan(db(peakOf(off)));
  });
});

describe("kernel", () => {
  it("renders the same for the same seed, differently for another", () => {
    const length = seconds(1);
    const [a] = render(kernel({ seed: 5, disks: 1 }), 0, length);
    const [b] = render(kernel({ seed: 5, disks: 1 }), 0, length);
    const [c] = render(kernel({ seed: 6, disks: 1 }), 0, length);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  const extremes = [
    { airflow: 0, racks: 1, hvac: 0, whine: 0, disks: 0 },
    { airflow: 100, racks: 1, hvac: 100, whine: 100, disks: 1 },
    { airflow: 100, racks: 12, hvac: 100, whine: 100, disks: 1 },
    { airflow: 0, racks: 12, hvac: 100, whine: 100, disks: 1 },
  ];
  it.each(extremes)(
    "stays finite and under −3 dBFS at airflow $airflow, racks $racks, cooling $hvac, whine $whine",
    (settings) => {
      for (let seed = 1; seed <= 3; seed++) {
        const [left = new Float32Array(), right = new Float32Array()] = render(
          kernel({ ...settings, seed }),
          0,
          seconds(20),
        );
        expect(left.every((v) => Number.isFinite(v))).toBe(true);
        expect(right.every((v) => Number.isFinite(v))).toBe(true);
        expect(db(Math.max(peakOf(left), peakOf(right)))).toBeLessThan(-3);
      }
    },
  );

  it("keeps the tones' level at any number of racks", () => {
    // The air off as far as it goes, so the tones and their racks show.
    const level = (racks: number) => {
      const [left = new Float32Array()] = render(
        kernel({ airflow: 0, racks, hvac: 0, whine: 0 }),
        0,
        seconds(6),
      );
      return db(rms(left));
    };
    expect(Math.abs(level(12) - level(1))).toBeLessThan(1);
  });

  it("fades a rack in over a second rather than at once", () => {
    const quiet = { airflow: 0, hvac: 0, whine: 0 };
    const k = kernel({ ...quiet, racks: 1 });
    render(k, 0, seconds(1));
    k.set(0, 12, 0, 0, 0);
    const span = [seconds(1), seconds(1) + QUANTUM * 4] as const;
    const [left = new Float32Array()] = render(k, ...span);
    const [one = new Float32Array()] = render(kernel({ ...quiet, racks: 1 }), ...span);
    const [twelve = new Float32Array()] = render(kernel({ ...quiet, racks: 12 }), ...span);
    // Still mostly the single rack: the others have barely begun.
    expect(differenceDb(one, left)).toBeLessThan(-16);
    expect(differenceDb(one, twelve)).toBeGreaterThan(-12);
  });

  it.each([{ disks: 0 }, { disks: 1 }])(
    "is the same rendered afresh from a later sample, once its filters settle (disks $disks)",
    ({ disks }) => {
      const from = seconds(3) + 37;
      const whole = render(kernel({ disks, seed: 4 }), 0, seconds(9));
      const later = render(kernel({ disks, seed: 4 }), from, seconds(9));
      const settle = seconds(1);
      for (const channel of [0, 1]) {
        const a = whole[channel]?.subarray(from + settle) ?? new Float32Array();
        const b = later[channel]?.subarray(settle) ?? new Float32Array();
        expect(differenceDb(a, b)).toBeLessThan(-40);
      }
    },
  );

  it("decorrelates its sides", () => {
    const [left = new Float32Array(), right = new Float32Array()] = render(kernel(), 0, seconds(4));
    let lr = 0;
    for (let i = 0; i < left.length; i++) {
      lr += (left[i] ?? 0) * (right[i] ?? 0);
    }
    expect(Math.abs(lr / (rms(left) * rms(right) * left.length))).toBeLessThan(0.15);
  });
});

describe("readServerRoomOptions", () => {
  it("reads the seed and offset, with safe fallbacks", () => {
    expect(readServerRoomOptions({ seed: 12.7, offset: 3.5 })).toEqual({ seed: 12, offset: 3.5 });
    expect(readServerRoomOptions(undefined)).toEqual({ seed: 0, offset: 0 });
  });
});
