import { describe, expect, it } from "vitest";
import {
  AIRPLANE_CHANNELS,
  AirplaneKernel,
  BLADE_RATIO,
  BLADE_UNDER_BUZZ_DB,
  beatPeriod,
  CHIME,
  CHIME_OVER_RUMBLE_DB,
  CHIME_RATES,
  chimeNote,
  chimeRoot,
  Chimes,
  ENGINES_UNDER_RUMBLE_DB,
  engineGains,
  engineSpeeds,
  engineWave,
  MAJOR_THIRD,
  NOTE_GAP,
  NOTE_LENGTH,
  OFFSET_RANGE,
  readAirplaneOptions,
  ROOT_RANGE,
  ROTATION_RANGE,
  RUMBLE_DB,
  RUMBLE_LEFT,
  RUMBLE_RIGHT,
  rumbleShareBelow,
  SEATS,
  seatRumbleDb,
  VENT_RIGHT_DB,
  VENT_UNDER_RUMBLE_DB,
  ventShare,
  WANDER_FIRST,
  WANDER_SECOND,
} from "./airplane-dsp";
import type { AirplaneSeat } from "./airplane.meta";

const SR = 48000;
const QUANTUM = 128;
const SEAT_NAMES: readonly AirplaneSeat[] = ["front", "wing", "rear"];

const db = (x: number) => 20 * Math.log10(x);
const seconds = (s: number, sampleRate = SR) => Math.round(s * sampleRate);

function rms(x: Float32Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < x.length; i++) {
    sum += (x[i] ?? 0) ** 2;
  }
  return Math.sqrt(sum / Math.max(1, x.length - from));
}

function peakOf(x: Float32Array): number {
  let peak = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

interface Settings {
  seed?: number;
  seat?: AirplaneSeat;
  vent?: number;
  chime?: number;
  sampleRate?: number;
}

function kernel({ seed = 1, seat = "wing", vent = 35, chime = 0, sampleRate = SR }: Settings = {}) {
  const k = new AirplaneKernel(seed, sampleRate);
  k.set(SEATS[seat].lowpass, vent, chime);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: AirplaneKernel, from: number, to: number): Float32Array[] {
  const out = Array.from({ length: AIRPLANE_CHANNELS }, () => new Float32Array(to - from));
  const quantum = Array.from({ length: AIRPLANE_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    k.render(quantum, n);
    quantum.forEach((b, c) => {
      out[c]?.set(b.subarray(0, Math.min(QUANTUM, to - n)), n - from);
    });
  }
  return out;
}

/** Renders chimes from absolute sample `from` to `to`, a quantum at a time. */
function renderChimes(c: Chimes, from: number, to: number, rate: number): Float32Array {
  const out = new Float32Array(to - from);
  const quantum = new Float32Array(QUANTUM);
  for (let n = from; n < to; n += QUANTUM) {
    c.render(quantum, n, SR, rate, n === from);
    out.set(quantum.subarray(0, Math.min(QUANTUM, to - n)), n - from);
  }
  return out;
}

/** The first chime's start for `seed` at `rate`, in absolute seconds. */
function firstChime(seed: number, rate: number): number {
  const c = new Chimes(seed);
  for (let b = 0; b < 100000; b++) {
    const t = c.startIn(b, rate);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  throw new Error("no chime");
}

/** The strongest frequency in `x` between `low` and `high` Hz, by a 0.5 Hz scan. */
function strongest(x: Float32Array, low: number, high: number): number {
  let best = 0;
  let bestPower = -1;
  for (let f = low; f <= high; f += 0.5) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < x.length; i++) {
      const a = (2 * Math.PI * f * i) / SR;
      re += (x[i] ?? 0) * Math.cos(a);
      im += (x[i] ?? 0) * Math.sin(a);
    }
    const power = re * re + im * im;
    if (power > bestPower) {
      bestPower = power;
      best = f;
    }
  }
  return best;
}

describe("engines", () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i * 37);

  it.each(seeds)("seed %d turns them in range, beating every 1.7–4 s", (seed) => {
    const { first, second } = engineSpeeds(seed);
    expect(first).toBeGreaterThanOrEqual(ROTATION_RANGE[0]);
    expect(first).toBeLessThanOrEqual(ROTATION_RANGE[1]);
    expect(second - first).toBeGreaterThanOrEqual(OFFSET_RANGE[0]);
    expect(second - first).toBeLessThanOrEqual(OFFSET_RANGE[1]);
    expect(beatPeriod(seed)).toBeGreaterThanOrEqual(1.7);
    expect(beatPeriod(seed)).toBeLessThanOrEqual(4);
  });

  it("is the same for the same seed and differs for another", () => {
    expect(engineSpeeds(7)).toEqual(engineSpeeds(7));
    expect(engineSpeeds(7).first).not.toBe(engineSpeeds(8).first);
  });

  it("buzzes with six harmonics falling 5 dB a step, the fourth lifted 3 dB", () => {
    const { imag, real } = engineWave(false);
    expect(imag).toHaveLength(7);
    expect(real.every((r) => r === 0)).toBe(true);
    const levels = imag.slice(1).map((a) => db(a));
    expect(levels.map((l) => Math.round(l * 1000) / 1000)).toEqual([0, -5, -10, -12, -20, -25]);
  });

  it("adds the first engine's blade-pass at 22 times its rotation, 18 dB under its buzz", () => {
    const buzz = engineWave(false).imag;
    const { imag } = engineWave(true);
    expect(imag).toHaveLength(BLADE_RATIO + 1);
    expect(imag.slice(0, buzz.length)).toEqual(buzz);
    expect(imag.slice(buzz.length, BLADE_RATIO).every((a) => a === 0)).toBe(true);
    const buzzRms = Math.sqrt(buzz.reduce((sum, a) => sum + (a * a) / 2, 0));
    expect(db((imag[BLADE_RATIO] ?? 0) / Math.SQRT2 / buzzRms)).toBeCloseTo(BLADE_UNDER_BUZZ_DB, 9);
  });

  it.each(SEAT_NAMES)(
    "are off at 0 and 12 dB under the rumble at 100 (%s, by its seat)",
    (seat) => {
      const off = engineGains(0, seat);
      expect(Object.values(off).every((g) => g === 0)).toBe(true);
      const g = engineGains(100, seat);
      const rmsOf = (withBlades: boolean) =>
        Math.sqrt(engineWave(withBlades).imag.reduce((sum, a) => sum + (a * a) / 2, 0));
      const first = rmsOf(true);
      const second = rmsOf(false);
      const power =
        (first ** 2 * (g.firstLeft ** 2 + g.firstRight ** 2) +
          second ** 2 * (g.secondLeft ** 2 + g.secondRight ** 2)) /
        2;
      expect(10 * Math.log10(power)).toBeCloseTo(
        RUMBLE_DB + ENGINES_UNDER_RUMBLE_DB + SEATS[seat].enginesDb,
        9,
      );
    },
  );

  it("puts the first engine left and the second right, and keeps both in mono", () => {
    const g = engineGains(100, "wing");
    expect(g.firstLeft).toBeGreaterThan(g.firstRight);
    expect(g.secondRight).toBeGreaterThan(g.secondLeft);
    // In mono the slower engine is no more than a few dB over the other, so they still beat.
    const firstMono = g.firstLeft + g.firstRight;
    const secondMono = g.secondLeft + g.secondRight;
    expect(db(firstMono / secondMono)).toBeGreaterThan(0);
    expect(db(firstMono / secondMono)).toBeLessThan(6);
  });

  it("are quieter at the front and louder at the rear", () => {
    expect(SEATS.front.enginesDb).toBe(-6);
    expect(SEATS.rear.enginesDb).toBe(4);
    expect(engineGains(50, "front").firstLeft).toBeLessThan(engineGains(50, "wing").firstLeft);
    expect(engineGains(50, "rear").firstLeft).toBeGreaterThan(engineGains(50, "wing").firstLeft);
  });
});

describe("rumble", () => {
  it("keeps its energy below 25 Hz at least 20 dB down", () => {
    expect(10 * Math.log10(rumbleShareBelow(25, SR))).toBeLessThan(-20);
  });

  it("opens its low-pass at the front and closes it at the rear, barely changing its level", () => {
    expect(SEATS.front.lowpass).toBe(1.3);
    expect(SEATS.wing.lowpass).toBe(1);
    expect(SEATS.rear.lowpass).toBe(0.8);
    expect(seatRumbleDb("wing", SR)).toBeCloseTo(0, 9);
    expect(seatRumbleDb("front", SR)).toBeGreaterThan(0);
    expect(seatRumbleDb("front", SR)).toBeLessThan(1);
    expect(seatRumbleDb("rear", SR)).toBeLessThan(0);
    expect(seatRumbleDb("rear", SR)).toBeGreaterThan(-1);
  });

  it("maps Air vent onto its share", () => {
    expect(ventShare(0)).toBe(0);
    expect(ventShare(35)).toBeCloseTo(0.35, 9);
    expect(ventShare(100)).toBe(1);
    expect(ventShare(150)).toBe(1);
  });
});

describe("chime", () => {
  const rate = CHIME_RATES.sometimes;
  const seed = 3;
  const start = firstChime(seed, rate);
  const from = seconds(Math.floor(start) - 1);
  const to = seconds(start + NOTE_GAP + NOTE_LENGTH + 1);
  const chime = renderChimes(new Chimes(seed), from, to, rate);
  const at = (t: number) => seconds(start + t) - from;

  it("is rare: once in about 25 minutes, or about 8", () => {
    expect(CHIME_RATES.off).toBe(0);
    expect(1 / CHIME_RATES.rarely).toBeCloseTo(1500, 6);
    expect(1 / CHIME_RATES.sometimes).toBeCloseTo(480, 6);
    const c = new Chimes(5);
    let count = 0;
    for (let b = 0; b < 48000; b++) {
      count += Number.isNaN(c.startIn(b, rate)) ? 0 : 1;
    }
    // 100 expected over 48 000 s; a few fall to the quiet rule.
    expect(count).toBeGreaterThan(70);
    expect(count).toBeLessThan(130);
  });

  it("never starts two within four seconds", () => {
    const c = new Chimes(9);
    const starts = Array.from({ length: 20000 }, (_, b) => c.startIn(b, 0.05)).filter(
      (t) => !Number.isNaN(t),
    );
    expect(starts.length).toBeGreaterThan(100);
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThan(4);
  });

  it("is silent before it starts, sounds, and is silent once it has rung out", () => {
    expect(peakOf(chime.subarray(0, at(-0.01)))).toBe(0);
    expect(peakOf(chime.subarray(at(0), at(0.3)))).toBeGreaterThan(0.01);
    expect(peakOf(chime.subarray(at(NOTE_GAP + NOTE_LENGTH + 0.01)))).toBe(0);
  });

  it("peaks about 8 dB over the rumble's level, never more", () => {
    expect(chime.every((v) => Number.isFinite(v))).toBe(true);
    const peakDb = db(peakOf(chime));
    expect(peakDb).toBeLessThanOrEqual(RUMBLE_DB + CHIME_OVER_RUMBLE_DB);
    expect(peakDb).toBeGreaterThan(RUMBLE_DB + CHIME_OVER_RUMBLE_DB - 3);
  });

  it("plays a note and then the major third under it", () => {
    const root = chimeRoot(seed);
    expect(root).toBeGreaterThanOrEqual(ROOT_RANGE[0]);
    expect(root).toBeLessThanOrEqual(ROOT_RANGE[1]);
    const high = strongest(chime.subarray(at(0.02), at(0.42)), 400, 900);
    const low = strongest(chime.subarray(at(1.6), at(2.0)), 400, 900);
    expect(high).toBeCloseTo(root * MAJOR_THIRD, -0.5);
    expect(low).toBeCloseTo(root, -0.5);
    expect(high / low).toBeCloseTo(MAJOR_THIRD, 2);
  });

  it("each note starts softly, from nothing", () => {
    expect(chimeNote(600, 0)).toBe(0);
    expect(Math.abs(chimeNote(600, 0.0005))).toBeLessThan(0.07);
    expect(chimeNote(600, NOTE_LENGTH)).toBe(0);
  });

  it("is the same for the same seed and differs for another", () => {
    expect(renderChimes(new Chimes(seed), from, to, rate)).toEqual(chime);
    expect(chimeRoot(seed)).not.toBe(chimeRoot(seed + 1));
  });

  it("is time-addressable: a fresh render from mid-chime matches the whole", () => {
    const mid = at(0.6);
    const later = renderChimes(new Chimes(seed), from + mid, to, rate);
    expect(peakOf(later.map((v, i) => v - (chime[mid + i] ?? 0)))).toBeLessThan(1e-6);
    // And blocks 100–110 rendered afresh match the tail of 0–110, chime or not.
    const whole = renderChimes(new Chimes(1), 0, seconds(110), 0.05);
    const tail = renderChimes(new Chimes(1), seconds(100), seconds(110), 0.05);
    expect(peakOf(whole)).toBeGreaterThan(0);
    expect(peakOf(tail.map((v, i) => v - (whole[seconds(100) + i] ?? 0)))).toBeLessThan(1e-6);
  });

  it("is silent when off", () => {
    expect(peakOf(renderChimes(new Chimes(seed), from, to, 0))).toBe(0);
  });
});

describe("kernel", () => {
  it("is the same for the same seed and differs for another", () => {
    const a = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const b = render(kernel({ seed: 4 }), 0, seconds(0.5));
    const c = render(kernel({ seed: 5 }), 0, seconds(0.5));
    expect(a).toEqual(b);
    expect(a[RUMBLE_LEFT]).not.toEqual(c[RUMBLE_LEFT]);
  });

  it("is the same rendered afresh from a later sample, once its filters settle", () => {
    const from = seconds(3) + 37;
    const whole = render(kernel({ vent: 100 }), 0, seconds(5));
    const later = render(kernel({ vent: 100 }), from, seconds(5));
    const settle = seconds(1);
    for (const channel of [RUMBLE_LEFT, RUMBLE_RIGHT, WANDER_FIRST, WANDER_SECOND]) {
      const a = whole[channel]?.subarray(from + settle) ?? new Float32Array();
      const b = later[channel]?.subarray(settle) ?? new Float32Array();
      const difference = a.map((v, i) => v - (b[i] ?? 0));
      expect(db(rms(difference) / rms(a))).toBeLessThan(-40);
    }
  });

  it("decorrelates its sides", () => {
    const out = render(kernel(), 0, seconds(4));
    const left = out[RUMBLE_LEFT] ?? new Float32Array();
    const right = out[RUMBLE_RIGHT] ?? new Float32Array();
    let lr = 0;
    for (let i = 0; i < left.length; i++) {
      lr += (left[i] ?? 0) * (right[i] ?? 0);
    }
    expect(Math.abs(lr / (rms(left) * rms(right) * left.length))).toBeLessThan(0.15);
  });

  it("puts the rumble near its level, and the vent 16 dB under it at 100", () => {
    const quiet = render(kernel({ vent: 0 }), 0, seconds(30));
    const full = render(kernel({ vent: 100 }), 0, seconds(30));
    expect(db(rms(quiet[RUMBLE_LEFT] ?? new Float32Array(), SR))).toBeCloseTo(RUMBLE_DB, 0);
    // The same noise feeds both, so the difference is the vent alone.
    for (const [channel, sideDb] of [
      [RUMBLE_LEFT, -VENT_RIGHT_DB / 2],
      [RUMBLE_RIGHT, VENT_RIGHT_DB / 2],
    ] as const) {
      const a = quiet[channel] ?? new Float32Array();
      const vent = (full[channel] ?? new Float32Array()).map((v, i) => v - (a[i] ?? 0));
      expect(db(rms(vent, SR))).toBeCloseTo(RUMBLE_DB + VENT_UNDER_RUMBLE_DB + sideDb, 0);
    }
  });

  it("sends the engines' wander as slow drifts within ±1", () => {
    const out = render(kernel(), 0, seconds(30));
    for (const channel of [WANDER_FIRST, WANDER_SECOND]) {
      const wander = out[channel] ?? new Float32Array();
      expect(peakOf(wander)).toBeLessThanOrEqual(1);
      let step = 0;
      for (let i = 1; i < wander.length; i++) {
        step = Math.max(step, Math.abs((wander[i] ?? 0) - (wander[i - 1] ?? 0)));
      }
      // At most about 2.3 × 0.012 a second.
      expect(step * SR).toBeLessThan(0.03);
    }
    expect(out[WANDER_FIRST]).not.toEqual(out[WANDER_SECOND]);
  });

  it.each(SEAT_NAMES)("stays finite and bounded in the %s seat, vent full, chiming", (seat) => {
    const out = render(kernel({ seat, vent: 100, chime: 0.05 }), 0, seconds(20));
    for (const channel of out) {
      expect(channel.every((v) => Number.isFinite(v))).toBe(true);
    }
    for (const channel of [RUMBLE_LEFT, RUMBLE_RIGHT, CHIME]) {
      expect(db(peakOf(out[channel] ?? new Float32Array()))).toBeLessThan(-6);
    }
    expect(peakOf(out[CHIME] ?? new Float32Array())).toBeGreaterThan(0);
  });

  it("follows the same params to the same level at 44.1 and 48 kHz", () => {
    const level = (sampleRate: number) =>
      db(
        rms(
          render(kernel({ sampleRate }), 0, seconds(8, sampleRate))[RUMBLE_LEFT] ??
            new Float32Array(),
          seconds(0.5, sampleRate),
        ),
      );
    expect(Math.abs(level(44100) - level(48000))).toBeLessThan(0.5);
  });
});

describe("options", () => {
  it("reads the seed and offset, with safe defaults", () => {
    expect(readAirplaneOptions({ seed: 12.7, offset: 3.5 })).toEqual({ seed: 12, offset: 3.5 });
    expect(readAirplaneOptions(undefined)).toEqual({ seed: 0, offset: 0 });
    expect(readAirplaneOptions({ seed: "x", offset: Number.NaN })).toEqual({ seed: 0, offset: 0 });
  });
});
