import { describe, expect, it } from "vitest";
import {
  beatOffset,
  beatPeriod,
  DRIFT,
  DUB,
  dubDelay,
  FLOW_FLOOR,
  flowLevel,
  HeartBeats,
  HeartbeatKernel,
  LUB,
  readHeartbeatOptions,
  SCATTER,
  SWAY,
  thumpLength,
} from "./heartbeat-dsp";

const SR = 48000;
const QUANTUM = 128;

const dbfs = (x: number) => 20 * Math.log10(x);

function peakOf(x: Float32Array): number {
  let peak = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

function rmsOf(x: Float32Array): number {
  let sum = 0;
  for (const v of x) {
    sum += v * v;
  }
  return Math.sqrt(sum / x.length);
}

interface Settings {
  seed?: number;
  rate?: number;
  bed?: number;
  sampleRate?: number;
}

function kernel({ seed = 1, rate = 64, bed = 50, sampleRate = SR }: Settings = {}) {
  const k = new HeartbeatKernel(seed, sampleRate, rate);
  k.set(rate, bed);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: HeartbeatKernel, from: number, to: number): Float32Array {
  const out = new Float32Array(to - from);
  for (let n = from; n < to; n += QUANTUM) {
    k.render(out.subarray(n - from, Math.min(n + QUANTUM, to) - from), n);
  }
  return out;
}

/** Every beat time in [t0, t1), as a worklet finds them, a quantum at a time. */
function beatTimes(beats: HeartBeats, t0: number, t1: number): number[] {
  const times: number[] = [];
  for (let n = beats.firstFrom(t0); beats.timeOf(n) < t1; n++) {
    times.push(beats.timeOf(n));
  }
  return times;
}

const intervals = (times: number[]) => times.slice(1).map((t, i) => t - (times[i] ?? 0));

describe("beatPeriod", () => {
  it("is 60 / rate, held to 50–90 bpm", () => {
    expect(beatPeriod(60)).toBe(1);
    expect(beatPeriod(90)).toBeCloseTo(2 / 3, 12);
    expect(beatPeriod(10)).toBe(1.2);
    expect(beatPeriod(200)).toBeCloseTo(2 / 3, 12);
  });
});

describe("dubDelay", () => {
  it("shrinks a little as the rate rises", () => {
    expect(dubDelay(beatPeriod(50))).toBeCloseTo(0.36, 12);
    expect(dubDelay(beatPeriod(90))).toBeCloseTo(0.24 + 0.1 / 1.5, 12);
  });

  it("leaves the dub done before the next lub at every rate", () => {
    const T = beatPeriod(90);
    expect(dubDelay(T) + thumpLength(DUB)).toBeLessThan(0.94 * T + thumpLength(LUB));
    expect(thumpLength(LUB)).toBeLessThan(0.94 * T);
  });
});

describe("beatOffset", () => {
  it("is a pure function of seed and beat, within its reach", () => {
    const a = beatOffset(7);
    const b = beatOffset(7);
    const c = beatOffset(8);
    let differs = 0;
    for (let n = -200; n < 2000; n++) {
      expect(a(n)).toBe(b(n));
      expect(Math.abs(a(n))).toBeLessThanOrEqual(DRIFT + SWAY + SCATTER);
      if (a(n) !== c(n)) {
        differs++;
      }
    }
    expect(differs).toBe(2200);
  });

  it("drifts slowly: neighbouring beats move by much less than its reach", () => {
    const v = beatOffset(3);
    let largest = 0;
    for (let n = 0; n < 5000; n++) {
      largest = Math.max(largest, Math.abs(v(n + 1) - v(n)));
    }
    expect(largest).toBeLessThan(0.045);
    expect(largest).toBeGreaterThan(0.01);
  });
});

describe("HeartBeats", () => {
  it.each([50, 64, 90])("is a pure function of seed, rate and n at %d bpm", (rate) => {
    const a = new HeartBeats(5, rate);
    const b = new HeartBeats(5, rate);
    for (let n = -10; n < 1000; n++) {
      expect(a.timeOf(n)).toBe(b.timeOf(n));
    }
  });

  it.each([50, 64, 90])("finds the same beats rendered from 300 s as from 0, at %d bpm", (rate) => {
    const whole = beatTimes(new HeartBeats(2, rate), 0, 600);
    const late = beatTimes(new HeartBeats(2, rate), 300, 600);
    expect(whole.filter((t) => t >= 300)).toEqual(late);
  });

  it.each([1, 2, 3, 42, 999])(
    "keeps every interval within ±6 %% of the period, seed %d",
    (seed) => {
      for (const rate of [50, 64, 90]) {
        const T = beatPeriod(rate);
        const gaps = intervals(beatTimes(new HeartBeats(seed, rate), 0, 600));
        expect(Math.min(...gaps)).toBeGreaterThan(0.94 * T);
        expect(Math.max(...gaps)).toBeLessThan(1.06 * T);
      }
    },
  );

  it("keeps its rate on average: no drift builds up", () => {
    const beats = new HeartBeats(4, 64);
    expect(beats.timeOf(10000) / 10000).toBeCloseTo(beatPeriod(64), 5);
  });

  it.each([
    [50, 90],
    [90, 50],
    [64, 72],
    [72, 64],
  ])("moves from %d to %d bpm at the next beat, never doubling or dropping one", (from, to) => {
    const Tfrom = beatPeriod(from);
    const Tto = beatPeriod(to);
    // A change at many points through a beat.
    for (let k = 0; k < 40; k++) {
      const beats = new HeartBeats(9, from);
      const change = 30 + (k / 40) * Tfrom;
      const before = beatTimes(beats, 20, change);
      beats.setRate(to, change);
      const after = beatTimes(beats, change, change + 20);
      const gaps = intervals([...before, ...after]);
      // The beat at the change keeps its time or comes sooner: no gap shorter than
      // the shorter period allows (so no doubled beat), none longer than the longer.
      expect(Math.min(...gaps)).toBeGreaterThan(0.9 * Math.min(Tfrom, Tto));
      expect(Math.max(...gaps)).toBeLessThan(1.06 * Math.max(Tfrom, Tto));
      // After the first beat at the new rate, the new spacing holds.
      for (const gap of intervals(after).slice(1)) {
        expect(gap).toBeGreaterThan(0.94 * Tto);
        expect(gap).toBeLessThan(1.06 * Tto);
      }
    }
  });

  it("starts afresh on absolute time when reset", () => {
    const beats = new HeartBeats(6, 64);
    beats.setRate(80, 12.3);
    beats.reset(80);
    expect(beatTimes(beats, 100, 110)).toEqual(beatTimes(new HeartBeats(6, 80), 100, 110));
  });
});

describe("flowLevel", () => {
  it("is off at 0 and full at 100", () => {
    expect(flowLevel(0)).toBe(0);
    expect(flowLevel(50)).toBe(0.5);
    expect(flowLevel(100)).toBe(1);
    expect(flowLevel(150)).toBe(1);
  });
});

describe("HeartbeatKernel", () => {
  it("is deterministic per seed, and seeds differ", () => {
    const a = render(kernel({ seed: 4 }), 0, 5 * SR);
    const b = render(kernel({ seed: 4 }), 0, 5 * SR);
    const c = render(kernel({ seed: 5 }), 0, 5 * SR);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("is time-addressable: a render from 10 s matches one from 0", () => {
    const whole = render(kernel(), 0, 14 * SR);
    const late = render(kernel(), 10 * SR, 14 * SR);
    const tail = whole.subarray(10 * SR);
    let largest = 0;
    for (let i = 0; i < late.length; i++) {
      largest = Math.max(largest, Math.abs(late[i] - tail[i]));
    }
    expect(dbfs(largest / peakOf(tail))).toBeLessThan(-80);
  });

  it.each([
    { rate: 50, bed: 0 },
    { rate: 50, bed: 100 },
    { rate: 90, bed: 0 },
    { rate: 90, bed: 100 },
    { rate: 64, bed: 50 },
  ])("stays finite and peaks under −3 dBFS at $rate bpm, Flow $bed", (settings) => {
    for (const seed of [1, 2]) {
      const out = render(kernel({ ...settings, seed }), 0, 30 * SR);
      expect(out.every((v) => Number.isFinite(v))).toBe(true);
      expect(dbfs(peakOf(out))).toBeLessThan(-3);
    }
  });

  it("has a soft level at the defaults, near −23 dBFS RMS before the muffle", () => {
    const db = dbfs(rmsOf(render(kernel(), 0, 60 * SR)));
    expect(db).toBeGreaterThan(-27);
    expect(db).toBeLessThan(-20);
  });

  it("starts and ends each lub and dub on zero: silence between beats, no step anywhere", () => {
    // At 50 bpm with no flow, each beat has died away well before the next.
    const k = kernel({ rate: 50, bed: 0 });
    const out = render(k, 0, 30 * SR);
    const beats = beatTimes(new HeartBeats(1, 50), 0, 30);
    expect(beats.length).toBeGreaterThan(20);
    for (const t of beats) {
      const start = Math.round(t * SR);
      if (start < 1) {
        continue;
      }
      // Silent up to the lub, then rising from nothing.
      expect(out[start - 1]).toBe(0);
      expect(Math.abs(out[start] ?? 1)).toBeLessThan(1e-6);
      expect(Math.abs(out[start + 1] ?? 1)).toBeLessThan(1e-3);
    }
    let step = 0;
    for (let i = 1; i < out.length; i++) {
      step = Math.max(step, Math.abs(out[i] - out[i - 1]));
    }
    // The sines move at most about 0.007 a sample and the noise thump about
    // twice that; a step to or from a thump's full level would be 0.3 or more.
    expect(step).toBeLessThan(0.03);
  });

  it("swells its flow between its floor and 1, smoothly", () => {
    const k = kernel({ rate: 90 });
    const one = new Float32Array(1);
    let low = 1;
    let high = 0;
    let previous = Number.NaN;
    let step = 0;
    for (let f = 0; f < 20 * SR; f++) {
      k.render(one, f);
      const e = k.flowEnvelope;
      if (f > 2 * SR) {
        low = Math.min(low, e);
        high = Math.max(high, e);
        step = Math.max(step, Math.abs(e - previous));
      }
      previous = e;
    }
    expect(low).toBeGreaterThanOrEqual(FLOW_FLOOR);
    expect(low).toBeLessThan(FLOW_FLOOR + 0.2);
    expect(high).toBeCloseTo(1, 6);
    // From floor to full over 120 ms, a step on every eighth sample: no jumps.
    expect(step).toBeLessThan(0.002);
  });

  it("adds the flow with Flow, 4 dB under the beats at 100", () => {
    const beats = render(kernel({ bed: 0 }), 0, 60 * SR);
    const full = render(kernel({ bed: 100 }), 0, 60 * SR);
    const flow = full.map((v, i) => v - beats[i]);
    const gap = dbfs(rmsOf(beats)) - dbfs(rmsOf(flow));
    expect(gap).toBeGreaterThan(3);
    expect(gap).toBeLessThan(5);
  });

  it("glides Flow, never stepping", () => {
    const k = kernel({ bed: 0 });
    const a = render(k, 0, SR);
    k.set(64, 100);
    const b = render(k, SR, 2 * SR);
    const out = Float32Array.from([...a, ...b]);
    let step = 0;
    for (let i = SR - 10; i < SR + 4800; i++) {
      step = Math.max(step, Math.abs(out[i] - out[i - 1]));
    }
    expect(step).toBeLessThan(0.01);
  });

  it("changes rate from the next beat, without a click", () => {
    const k = kernel({ rate: 50, bed: 50 });
    const a = render(k, 0, 10 * SR);
    k.set(90, 50);
    const b = render(k, 10 * SR, 20 * SR);
    expect([...a, ...b].every((v) => Number.isFinite(v))).toBe(true);
    const out = Float32Array.from([...a, ...b]);
    let step = 0;
    for (let i = 1; i < out.length; i++) {
      step = Math.max(step, Math.abs(out[i] - out[i - 1]));
    }
    expect(step).toBeLessThan(0.03);
  });

  it("sounds the same at 44.1 kHz as at 48 kHz", () => {
    const at48 = dbfs(rmsOf(render(kernel(), 0, 60 * SR)));
    const at44 = dbfs(rmsOf(render(kernel({ sampleRate: 44100 }), 0, 60 * 44100)));
    expect(Math.abs(at48 - at44)).toBeLessThan(0.5);
  });
});

describe("readHeartbeatOptions", () => {
  it("reads the options, falling back to safe defaults", () => {
    expect(readHeartbeatOptions({ seed: 3.7, rate: 72, offset: 1.5 })).toEqual({
      seed: 3,
      rate: 72,
      offset: 1.5,
    });
    expect(readHeartbeatOptions(undefined)).toEqual({ seed: 0, rate: 64, offset: 0 });
    expect(readHeartbeatOptions({ seed: "x", rate: Number.NaN })).toEqual({
      seed: 0,
      rate: 64,
      offset: 0,
    });
  });
});
