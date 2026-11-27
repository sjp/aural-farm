import { describe, expect, it } from "vitest";
import { createEventBlock, eventHash, eventsInBlock } from "../../audio/dsp/events";
import {
  CAR_LONGEST,
  CAR_PAN,
  CAR_RISE,
  CAR_STREAM,
  carEnvelope,
  carRate,
  carShape,
  carSweep,
  CITY_CHANNELS,
  CityKernel,
  DOPPLER,
  guard,
  readCityOptions,
  RUMBLE_DB,
  rumbleShare,
  SIGNAL_PAN,
  SIGNAL_STREAM,
  signalEnvelope,
  signalRate,
  signalShape,
  SIREN_LONGEST,
  spaceDb,
} from "./city-dsp";

const SR = 48000;
const QUANTUM = 128;

const db = (x: number) => 20 * Math.log10(x);
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
  day?: number;
  traffic?: number;
  rumble?: number;
  signals?: number;
  sampleRate?: number;
}

/** Renders `seconds` from absolute second `from`, a quantum at a time, as four channels. */
function render(
  seconds: number,
  { seed = 1, day = 0, traffic = 50, rumble = 60, signals = 0, sampleRate = SR }: Settings = {},
  from = 0,
): Float32Array[] {
  const kernel = new CityKernel(seed, sampleRate);
  kernel.set(day, traffic, rumble, signals);
  const length = Math.round(seconds * sampleRate);
  const start = Math.round(from * sampleRate);
  const out = Array.from({ length: CITY_CHANNELS }, () => new Float32Array(length));
  const block = Array.from({ length: CITY_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let done = 0; done < length; done += QUANTUM) {
    kernel.render(block, start + done);
    for (const [c, channel] of out.entries()) {
      channel.set((block[c] ?? new Float32Array()).subarray(0, length - done), done);
    }
  }
  return out;
}

/** Signal events in `blocks` 1 s blocks at `rate` per second, for `seed`. */
function countEvents(seed: number, stream: number, rate: number, blocks: number): number {
  const events = createEventBlock(16);
  let count = 0;
  for (let b = 0; b < blocks; b++) {
    count += eventsInBlock(seed, stream, b, rate, events);
  }
  return count;
}

describe("params", () => {
  it("passes about 0.25 cars a second by day and 0.05 at night at Traffic 50", () => {
    expect(carRate(50, 1)).toBeCloseTo(0.25);
    expect(carRate(50, 0)).toBeCloseTo(0.05);
  });

  it("passes cars in proportion to Traffic, and none at 0", () => {
    expect(carRate(0, 1)).toBe(0);
    expect(carRate(100, 1)).toBeCloseTo(2 * carRate(50, 1));
    expect(carRate(25, 0)).toBeCloseTo(carRate(50, 0) / 2);
  });

  it("sounds far signals about every 6 minutes (Rare) or 2 (Occasional), and never when off", () => {
    expect(signalRate("off")).toBe(0);
    expect(1 / signalRate("rare")).toBeCloseTo(360);
    expect(1 / signalRate("occasional")).toBeCloseTo(120);
  });

  it("sends the cars from −30 to −6 dB as Space goes from 0 to 100", () => {
    expect(spaceDb(0) - 18).toBeCloseTo(-30);
    expect(spaceDb(50) - 18).toBeCloseTo(-18);
    expect(spaceDb(100) - 18).toBeCloseTo(-6);
  });

  it("silences the rumble at 0 and lifts it 3 dB at 100", () => {
    expect(rumbleShare(0)).toBe(0);
    expect(rumbleShare(60)).toBeCloseTo(1);
    expect(db(rumbleShare(100))).toBeGreaterThan(2.5);
    expect(db(rumbleShare(100))).toBeLessThan(3.5);
  });
});

describe("cars", () => {
  it("are deterministic per hash and within their ranges", () => {
    for (let i = 0; i < 200; i++) {
      const hash = eventHash(7, CAR_STREAM, i, 0);
      const car = carShape(hash);
      expect(carShape(hash)).toEqual(car);
      expect(car.length).toBeGreaterThanOrEqual(3);
      expect(car.length).toBeLessThanOrEqual(CAR_LONGEST);
      expect(car.centre).toBeGreaterThanOrEqual(400);
      expect(car.centre).toBeLessThanOrEqual(900);
      expect(car.peakDb).toBeGreaterThanOrEqual(-16);
      expect(car.peakDb).toBeLessThanOrEqual(-6);
      expect(Math.abs(car.direction)).toBe(1);
    }
  });

  it("pass in both directions", () => {
    const directions = new Set(
      Array.from({ length: 50 }, (_, i) => carShape(eventHash(1, CAR_STREAM, i, 0)).direction),
    );
    expect(directions).toEqual(new Set([1, -1]));
  });

  it("depend only on the seed and the block index", () => {
    const a = createEventBlock(16);
    const b = createEventBlock(16);
    eventsInBlock(3, CAR_STREAM, 1234, carRate(100, 1), a);
    eventsInBlock(9, CAR_STREAM, 77, carRate(100, 1), createEventBlock(16));
    eventsInBlock(3, CAR_STREAM, 1234, carRate(100, 1), b);
    expect(b.count).toBe(a.count);
    expect(Array.from(b.offsets.subarray(0, b.count))).toEqual(
      Array.from(a.offsets.subarray(0, a.count)),
    );
  });

  it("come at the traffic's rate over a long run", () => {
    const hours = 2;
    const count = countEvents(1, CAR_STREAM, carRate(50, 1), 3600 * hours);
    expect(count / (3600 * hours)).toBeGreaterThan(0.23);
    expect(count / (3600 * hours)).toBeLessThan(0.27);
  });
});

describe("a car's pass", () => {
  it("starts and ends at zero, and peaks at 1 after its rise", () => {
    expect(carEnvelope(0)).toBe(0);
    expect(carEnvelope(1)).toBe(0);
    expect(carEnvelope(1e-6)).toBeLessThan(1e-9);
    expect(carEnvelope(1 - 1e-6)).toBeLessThan(1e-9);
    expect(carEnvelope(CAR_RISE)).toBeCloseTo(1);
    expect(carEnvelope(-0.1)).toBe(0);
    expect(carEnvelope(1.1)).toBe(0);
  });

  it("rises, then falls", () => {
    const steps = 200;
    const points = Array.from({ length: steps + 1 }, (_, i) => i / steps);
    const rising = points.filter((p) => p <= CAR_RISE).map((p) => carEnvelope(p));
    const falling = [CAR_RISE, ...points.filter((p) => p > CAR_RISE)].map((p) => carEnvelope(p));
    for (let i = 1; i < rising.length; i++) {
      expect(rising[i]).toBeGreaterThanOrEqual(rising[i - 1] ?? 0);
    }
    for (let i = 1; i < falling.length; i++) {
      expect(falling[i]).toBeLessThanOrEqual(falling[i - 1] ?? 0);
    }
  });

  it("sweeps monotonically across, half-way at the peak", () => {
    expect(carSweep(0)).toBe(0);
    expect(carSweep(1)).toBe(1);
    expect(carSweep(CAR_RISE)).toBeCloseTo(0.5);
    let last = 0;
    for (let p = 0.005; p <= 1; p += 0.005) {
      const sweep = carSweep(p);
      expect(sweep).toBeGreaterThanOrEqual(last);
      last = sweep;
    }
  });

  it("pans from one side to the other within reach, and falls about 12 % in pitch", () => {
    const pan = (p: number) => CAR_PAN * (2 * carSweep(p) - 1);
    expect(pan(0)).toBeCloseTo(-CAR_PAN);
    expect(pan(1)).toBeCloseTo(CAR_PAN);
    const centre = (p: number) => 1 + DOPPLER / 2 - DOPPLER * carSweep(p);
    expect(1 - centre(1) / centre(0)).toBeGreaterThan(0.1);
    expect(1 - centre(1) / centre(0)).toBeLessThan(0.13);
  });
});

describe("far signals", () => {
  it("never come when off", () => {
    expect(countEvents(1, SIGNAL_STREAM, signalRate("off"), 3600 * 10)).toBe(0);
  });

  it("come about 10 times an hour when rare", () => {
    const hours = 200;
    const count = countEvents(1, SIGNAL_STREAM, signalRate("rare"), 3600 * hours);
    expect(count / hours).toBeGreaterThan(9);
    expect(count / hours).toBeLessThan(11);
  });

  const shapes = Array.from({ length: 400 }, (_, i) =>
    signalShape(eventHash(5, SIGNAL_STREAM, i, 0)),
  );
  const sirens = shapes.filter((s) => s.siren);
  const horns = shapes.filter((s) => !s.siren);

  it("are about a third sirens, the rest horns, within reach of the centre", () => {
    expect(sirens.length).toBeGreaterThan(80);
    expect(sirens.length).toBeLessThan(200);
    expect(Math.max(...shapes.map((s) => Math.abs(s.pan)))).toBeLessThanOrEqual(SIGNAL_PAN);
  });

  it("sound sirens for 8–14 s, sweeping every 3–4 s", () => {
    expect(Math.min(...sirens.map((s) => s.length))).toBeGreaterThanOrEqual(8);
    expect(Math.max(...sirens.map((s) => s.length))).toBeLessThanOrEqual(SIREN_LONGEST);
    expect(Math.min(...sirens.map((s) => s.period))).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sirens.map((s) => s.period))).toBeLessThanOrEqual(4);
  });

  it("sound horns for 0.3–0.8 s, at 300–420 Hz", () => {
    expect(Math.min(...horns.map((s) => s.length))).toBeGreaterThanOrEqual(0.3);
    expect(Math.max(...horns.map((s) => s.length))).toBeLessThanOrEqual(0.8);
    expect(Math.min(...horns.map((s) => s.pitch))).toBeGreaterThanOrEqual(300);
    expect(Math.max(...horns.map((s) => s.pitch))).toBeLessThanOrEqual(420);
  });

  it("fade in and out from zero", () => {
    expect(signalEnvelope(0, 10, 3, 3)).toBe(0);
    expect(signalEnvelope(10, 10, 3, 3)).toBe(0);
    expect(signalEnvelope(1e-4, 10, 3, 3)).toBeLessThan(1e-8);
    expect(signalEnvelope(5, 10, 3, 3)).toBe(1);
    expect(signalEnvelope(10 - 1e-4, 10, 3, 3)).toBeLessThan(1e-8);
  });
});

describe("guard", () => {
  it("leaves quiet samples alone and never passes −3 dBFS", () => {
    expect(guard(0.1)).toBe(0.1);
    expect(guard(-0.2)).toBe(-0.2);
    for (const x of [0.5, 1, 10, 1e6]) {
      expect(db(guard(x))).toBeLessThan(-3);
      expect(guard(-x)).toBe(-guard(x));
    }
  });
});

describe("CityKernel", () => {
  it("is deterministic per seed, and differs between seeds", () => {
    const a = render(2, { seed: 4 });
    const b = render(2, { seed: 4 });
    const c = render(2, { seed: 5 });
    expect(a[0]).toEqual(b[0]);
    expect(a[3]).toEqual(b[3]);
    expect(a[0]).not.toEqual(c[0]);
  });

  it("decorrelates the sides", () => {
    const [left = new Float32Array(), right = new Float32Array()] = render(2, { traffic: 0 });
    expect(left).not.toEqual(right);
  });

  it("is time-addressable: a render from 20 s matches one from 0, cars and signals included", () => {
    const settings = { day: 1, traffic: 100, signals: 1 / 20 };
    const whole = render(26, settings);
    const late = render(6, settings, 20);
    for (const [c, channel] of late.entries()) {
      const tail = (whole[c] ?? new Float32Array()).subarray(20 * SR);
      let error = 0;
      for (let i = SR; i < channel.length; i++) {
        error = Math.max(error, Math.abs((channel[i] ?? 0) - (tail[i] ?? 0)));
      }
      expect(db(error / peakOf(tail))).toBeLessThan(-60);
    }
  });

  it.each([
    ["night, defaults", { day: 0 }],
    ["day, defaults", { day: 1 }],
    [
      "day, everything up, occasional signals",
      { day: 1, traffic: 100, rumble: 100, signals: 1 / 120 },
    ],
    ["no rumble, busiest", { day: 1, traffic: 100, rumble: 0 }],
  ] as const)("stays finite and under −3 dBFS: %s", (_, settings) => {
    const out = render(60, settings);
    for (const channel of out) {
      expect(channel.every((x) => Number.isFinite(x))).toBe(true);
      expect(db(peakOf(channel))).toBeLessThan(-3);
    }
  });

  it("is silent with no rumble, traffic or signals", () => {
    const out = render(3, { traffic: 0, rumble: 0 });
    for (const channel of out) {
      expect(peakOf(channel)).toBe(0);
    }
  });

  it("sets the day's rumble near its level, and the night about 4 dB under it", () => {
    const day = rms(render(20, { day: 1, traffic: 0 })[0] ?? new Float32Array(), SR);
    const night = rms(render(20, { day: 0, traffic: 0 })[0] ?? new Float32Array(), SR);
    expect(Math.abs(db(day) - RUMBLE_DB)).toBeLessThan(2.5);
    expect(db(day) - db(night)).toBeGreaterThan(3);
    expect(db(day) - db(night)).toBeLessThan(5.5);
  });

  it("feeds the reverb far under the sound", () => {
    const [dry = new Float32Array(), , feed = new Float32Array()] = render(10, { day: 1 });
    expect(db(rms(feed)) - db(rms(dry))).toBeLessThan(-20);
  });

  it("sounds the same level at 44.1 kHz as at 48 kHz", () => {
    const at48 = rms(render(10, { day: 1 })[0] ?? new Float32Array(), SR);
    const at44 = rms(render(10, { day: 1, sampleRate: 44100 })[0] ?? new Float32Array(), 44100);
    expect(Math.abs(db(at48) - db(at44))).toBeLessThan(1);
  });

  it("passes cars at the traffic's rate, and none at Traffic 0", () => {
    const kernel = new CityKernel(2, SR);
    const block = Array.from({ length: CITY_CHANNELS }, () => new Float32Array(QUANTUM));
    kernel.set(1, 0, 60, 0);
    let most = 0;
    for (let n = 0; n < 20 * SR; n += QUANTUM) {
      kernel.render(block, n);
      most = Math.max(most, kernel.carsSounding);
    }
    expect(most).toBe(0);
    kernel.set(1, 100, 60, 0);
    for (let n = 20 * SR; n < 60 * SR; n += QUANTUM) {
      kernel.render(block, n);
      most = Math.max(most, kernel.carsSounding);
    }
    expect(most).toBeGreaterThan(0);
  });

  it("sounds a far signal when one comes, and none when off", () => {
    const kernel = new CityKernel(1, SR);
    const block = Array.from({ length: CITY_CHANNELS }, () => new Float32Array(QUANTUM));
    kernel.set(0, 0, 0, 0);
    let heard = false;
    for (let n = 0; n < 60 * SR; n += QUANTUM) {
      kernel.render(block, n);
      heard ||= kernel.signalsSounding > 0;
    }
    expect(heard).toBe(false);
    kernel.set(0, 0, 0, 1 / 5);
    for (let n = 60 * SR; n < 120 * SR; n += QUANTUM) {
      kernel.render(block, n);
      heard ||= kernel.signalsSounding > 0;
    }
    expect(heard).toBe(true);
  });
});

describe("readCityOptions", () => {
  it("reads the seed and offset, with safe defaults", () => {
    expect(readCityOptions({ seed: 12.7, offset: 3 })).toEqual({ seed: 12, offset: 3 });
    expect(readCityOptions(undefined)).toEqual({ seed: 0, offset: 0 });
    expect(readCityOptions({ seed: "x", offset: Number.NaN })).toEqual({ seed: 0, offset: 0 });
  });
});
