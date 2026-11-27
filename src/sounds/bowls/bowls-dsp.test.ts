import { describe, expect, it } from "vitest";
import { ModalBank } from "../../audio/dsp/modal";
import { createPeriodicEvents, PeriodicSchedule } from "../../audio/dsp/periodic";
import {
  BOWL_PAN,
  BOWL_STEPS,
  bowlCount,
  bowlFundamental,
  bowlModes,
  bowlPan,
  BowlsKernel,
  FUNDAMENTAL_BEAT,
  FUNDAMENTAL_DECAY,
  FUNDAMENTAL_DETUNE,
  guard,
  GUARD_CEILING,
  MODE_RATIOS,
  MODE_TOP,
  pickBowl,
  readBowlsOptions,
  RUB_RANGE_DB,
  rubLevel,
  STRENGTH,
  strikeInterval,
  strikeStrength,
  STRIKE_JITTER,
  STRIKE_STREAM,
  UPPER_BEAT,
  UPPER_DETUNE,
} from "./bowls-dsp";
import { MAX_BOWLS, type BowlKey } from "./bowls.meta";

const SR = 48000;
const QUANTUM = 128;
const KEYS: readonly BowlKey[] = ["c", "d", "e", "f", "g", "a", "b"];
const KEY_HZ: Readonly<Record<BowlKey, number>> = {
  c: 130.81,
  d: 146.83,
  e: 164.81,
  f: 174.61,
  g: 196,
  a: 220,
  b: 246.94,
};

const peakOf = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rmsOf = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

interface Settings {
  key?: BowlKey;
  seed?: number;
  bowls?: number;
  interval?: number;
  rub?: boolean;
  sampleRate?: number;
}

/** Renders `seconds` from absolute second `from` with `kernel`, a quantum at a time. */
function renderWith(
  kernel: BowlsKernel,
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

/** Renders `seconds` from absolute second `from` with a fresh kernel. */
function render(
  seconds: number,
  { key = "d", seed = 1, bowls = 3, interval = 25, rub = false, sampleRate = SR }: Settings = {},
  from = 0,
): [Float32Array, Float32Array] {
  const kernel = new BowlsKernel(key, seed, sampleRate);
  kernel.set(bowls, interval, rub);
  return renderWith(kernel, seconds, from, sampleRate);
}

/** The largest difference between `a` and `b`. */
function worstDifference(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (const [i, x] of a.entries()) {
    worst = Math.max(worst, Math.abs(x - (b[i] ?? 0)));
  }
  return worst;
}

/** Every strike slot in [t0, t1): its index and time. */
function slots(seed: number, interval: number, t0: number, t1: number) {
  const schedule = new PeriodicSchedule(seed, STRIKE_STREAM, interval, STRIKE_JITTER);
  const events = createPeriodicEvents(8);
  const found: { n: number; t: number }[] = [];
  for (let t = t0; t < t1; t += 1) {
    schedule.eventsIn(t, Math.min(t + 1, t1), events);
    for (let i = 0; i < events.count; i++) {
      found.push({ n: events.indices[i] ?? 0, t: events.times[i] ?? 0 });
    }
  }
  return found;
}

describe("bowl table", () => {
  it.each(KEYS)("%s: fundamentals at 0, 7, 12, 14 and 19 semitones above the key", (key) => {
    for (const [i, steps] of BOWL_STEPS.entries()) {
      expect(bowlFundamental(key, i)).toBeCloseTo(KEY_HZ[key] * 2 ** (steps / 12), 1);
    }
  });

  it.each(KEYS)("%s: four modes per bowl, none above 7 kHz, within their detune", (key) => {
    for (let seed = 1; seed <= 5; seed++) {
      for (let i = 0; i < MAX_BOWLS; i++) {
        const modes = bowlModes(key, seed, i);
        expect(modes).toHaveLength(MODE_RATIOS.length);
        const fundamental = bowlFundamental(key, i);
        for (const [m, mode] of modes.entries()) {
          expect(mode.frequency + mode.beat).toBeLessThanOrEqual(MODE_TOP);
          const nominal = fundamental * (MODE_RATIOS[m] ?? 0);
          const detune = m === 0 ? FUNDAMENTAL_DETUNE : UPPER_DETUNE;
          expect(Math.abs(mode.frequency / nominal - 1)).toBeLessThanOrEqual(detune);
          const [lo, hi] = m === 0 ? FUNDAMENTAL_BEAT : UPPER_BEAT;
          expect(mode.beat).toBeGreaterThanOrEqual(lo);
          expect(mode.beat).toBeLessThanOrEqual(hi);
        }
        expect(modes[0]?.decay).toBeGreaterThanOrEqual(FUNDAMENTAL_DECAY[0]);
        expect(modes[0]?.decay).toBeLessThanOrEqual(FUNDAMENTAL_DECAY[1]);
        // Each higher mode rings shorter and quieter.
        for (let m = 1; m < modes.length; m++) {
          expect(modes[m]?.decay).toBeLessThan(modes[m - 1]?.decay ?? 0);
          expect(modes[m]?.amplitude).toBeLessThan(modes[m - 1]?.amplitude ?? 0);
        }
      }
    }
  });

  it("gives every seed its own bowls", () => {
    const a = bowlModes("d", 1, 0);
    const b = bowlModes("d", 2, 0);
    expect(a[1]?.frequency).not.toBe(b[1]?.frequency);
    expect(a[0]?.beat).not.toBe(b[0]?.beat);
    expect(bowlModes("d", 1, 0)).toEqual(a);
  });

  it("places each bowl within ±0.5, the same whatever the count, the deepest near the centre", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const pans = Array.from({ length: MAX_BOWLS }, (_, i) => bowlPan(seed, i));
      for (const pan of pans) {
        expect(Math.abs(pan)).toBeLessThanOrEqual(BOWL_PAN);
      }
      expect(Math.abs(pans[0] ?? 1)).toBeLessThan(0.1);
      // The next two sit on opposite sides.
      expect(Math.sign(pans[1] ?? 0)).toBe(-Math.sign(pans[2] ?? 0));
    }
  });

  it("clamps the count to 1–5", () => {
    expect(bowlCount(0)).toBe(1);
    expect(bowlCount(3.4)).toBe(3);
    expect(bowlCount(9)).toBe(MAX_BOWLS);
    expect(bowlCount(Number.NaN)).toBe(1);
  });
});

describe("split pairs", () => {
  /** The spacing of the envelope's dips, in seconds, for one mode's pair struck alone. */
  function beatPeriod(frequency: number, beat: number, sign: number): number {
    const bank = new ModalBank(SR, 2);
    // A long decay, so the dips are deep and evenly spaced.
    bank.setMode(0, frequency, 200, 1);
    bank.setMode(1, frequency + beat, 200, sign);
    bank.strike(1);
    const out = new Float32Array(SR * 8);
    bank.render(out, 0, out.length);
    // The peak in each 10 ms window, then the dips between them.
    const window = SR / 100;
    const envelope = Array.from({ length: out.length / window }, (_, w) =>
      peakOf(out.subarray(w * window, (w + 1) * window)),
    );
    const dips: number[] = [];
    for (let w = 1; w < envelope.length - 1; w++) {
      const e = envelope[w] ?? 0;
      if (e < (envelope[w - 1] ?? 0) && e <= (envelope[w + 1] ?? 0) && e < 0.5) {
        dips.push(w / 100);
      }
    }
    return ((dips.at(-1) ?? 0) - (dips[0] ?? 0)) / Math.max(1, dips.length - 1);
  }

  it.each([0, 1, 2, 3])("mode %i of each bowl beats at its hashed rate", (m) => {
    for (let i = 0; i < MAX_BOWLS; i++) {
      const [mode] = bowlModes("d", 1, i).slice(m);
      const period = beatPeriod(mode.frequency, mode.beat, m === 0 ? -1 : 1);
      expect(period).toBeCloseTo(1 / mode.beat, 1);
    }
  });
});

describe("strike schedule", () => {
  it("lays slots out as a pure function of seed, interval and slot", () => {
    const a = slots(3, 25, 0, 600);
    expect(slots(3, 25, 0, 600)).toEqual(a);
    const late = slots(3, 25, 300, 600);
    expect(late).toEqual(a.filter((s) => s.t >= 300));
    expect(slots(4, 25, 0, 600)).not.toEqual(a);
  });

  it.each([10, 25, 60])("keeps strikes at least 0.4 × %i s apart", (interval) => {
    for (let seed = 1; seed <= 5; seed++) {
      const found = slots(seed, interval, 0, 3600);
      for (let i = 1; i < found.length; i++) {
        const gap = (found[i]?.t ?? 0) - (found[i - 1]?.t ?? 0);
        expect(gap).toBeGreaterThanOrEqual(0.4 * interval - 1e-9);
      }
      const mean = ((found.at(-1)?.t ?? 0) - (found[0]?.t ?? 0)) / (found.length - 1);
      expect(mean).toBeCloseTo(interval, 0);
    }
  });

  it.each([2, 3, 4, 5])("never strikes the same bowl twice running, %i bowls", (count) => {
    for (let seed = 1; seed <= 10; seed++) {
      let previous = pickBowl(seed, -200, count);
      for (let n = -199; n < 400; n++) {
        const bowl = pickBowl(seed, n, count);
        expect(bowl).not.toBe(previous);
        expect(bowl).toBeGreaterThanOrEqual(0);
        expect(bowl).toBeLessThan(count);
        previous = bowl;
      }
    }
  });

  it.each([3, 4, 5])("strikes every bowl in each cycle of %i slots", (count) => {
    for (let cycle = -3; cycle < 30; cycle++) {
      const picked = new Set(
        Array.from({ length: count }, (_, i) => pickBowl(7, cycle * count + i, count)),
      );
      expect(picked.size).toBe(count);
    }
  });

  it("strikes one bowl alone every time", () => {
    for (let n = -5; n < 20; n++) {
      expect(pickBowl(1, n, 1)).toBe(0);
    }
  });

  it("strikes in 0.55–1, the deepest bowl a little harder on average", () => {
    let deepest = 0;
    let others = 0;
    for (let n = 0; n < 2000; n++) {
      const a = strikeStrength(1, n, 0);
      const b = strikeStrength(1, n, 2);
      for (const s of [a, b]) {
        expect(s).toBeGreaterThanOrEqual(STRENGTH[0]);
        expect(s).toBeLessThanOrEqual(STRENGTH[1]);
      }
      deepest += a;
      others += b;
    }
    expect(deepest / 2000).toBeGreaterThan(others / 2000 + 0.02);
  });

  it("clamps the interval to 10–60 s", () => {
    expect(strikeInterval(5)).toBe(10);
    expect(strikeInterval(25)).toBe(25);
    expect(strikeInterval(90)).toBe(60);
    expect(strikeInterval(Number.NaN)).toBe(10);
  });
});

describe("rim singing", () => {
  it("swings between −40 and −16 dB", () => {
    expect(20 * Math.log10(rubLevel(-5))).toBeCloseTo(RUB_RANGE_DB[0]);
    expect(20 * Math.log10(rubLevel(5))).toBeCloseTo(RUB_RANGE_DB[1]);
    expect(20 * Math.log10(rubLevel(0))).toBeCloseTo((RUB_RANGE_DB[0] + RUB_RANGE_DB[1]) / 2);
  });

  it("fades in over seconds when turned on, never at once", () => {
    const off = new BowlsKernel("d", 1, SR);
    off.set(3, 25, false);
    const on = new BowlsKernel("d", 1, SR);
    on.set(3, 25, false);
    renderWith(off, 2, 100);
    renderWith(on, 2, 100);
    on.set(3, 25, true);
    const [a] = renderWith(off, 6, 102);
    const [b] = renderWith(on, 6, 102);
    const added = b.map((x, i) => x - (a[i] ?? 0));
    const early = rmsOf(added.subarray(0, SR / 4));
    const late = rmsOf(added.subarray(SR * 5, SR * 6));
    expect(late).toBeGreaterThan(0);
    expect(early).toBeLessThan(late / 4);
  });
});

describe("BowlsKernel", () => {
  it("is deterministic per seed, and differs between seeds", () => {
    const [a] = render(10, { seed: 3 });
    const [b] = render(10, { seed: 3 });
    const [c] = render(10, { seed: 4 });
    expect(a).toEqual(b);
    expect(worstDifference(a, c)).toBeGreaterThan(0.001);
  });

  it.each([false, true])("is time-addressable, rim singing %s", (rub) => {
    const [whole] = render(70, { rub, interval: 10, bowls: 5 });
    const [late] = render(30, { rub, interval: 10, bowls: 5 }, 40);
    const tail = whole.subarray(40 * SR);
    expect(worstDifference(tail, late)).toBeLessThan(peakOf(tail) * 10 ** (-60 / 20));
  });

  it.each([
    { bowls: 1, interval: 60 },
    { bowls: 5, interval: 10, rub: true },
    { key: "c" as const, bowls: 5, interval: 10 },
    { key: "b" as const, bowls: 5, interval: 10, rub: true },
  ])("is finite and stays under −3 dBFS at %o", (settings) => {
    for (const channel of render(60, settings)) {
      expect(channel.every((x) => Number.isFinite(x))).toBe(true);
      expect(peakOf(channel)).toBeLessThan(10 ** (-3 / 20));
    }
  });

  it("keeps the worst overlap (every bowl at once, full strength, singing) under its ceiling", () => {
    const kernel = new BowlsKernel("d", 1, SR);
    kernel.set(5, 10, true);
    renderWith(kernel, 1, 100);
    kernel.strikeAll(1);
    kernel.strikeAll(1, 3);
    for (const channel of renderWith(kernel, 5, 101)) {
      expect(peakOf(channel)).toBeLessThanOrEqual(Math.fround(GUARD_CEILING));
    }
  });

  it("keeps three bowls struck at once, full strength, near the guard's knee", () => {
    const kernel = new BowlsKernel("d", 1, SR);
    kernel.set(3, 60, false);
    renderWith(kernel, 0.01, 1e5);
    kernel.strikeAll(1, 3);
    const [left] = renderWith(kernel, 3, 1e5 + 0.01);
    expect(peakOf(left)).toBeLessThan(10 ** (-6 / 20));
  });

  it("sounds the same at 44.1 kHz", () => {
    const a = render(60, { bowls: 5, interval: 10 });
    const b = render(60, { bowls: 5, interval: 10, sampleRate: 44100 });
    const db = (x: number) => 20 * Math.log10(x);
    expect(Math.abs(db(rmsOf(a[0])) - db(rmsOf(b[0])))).toBeLessThan(0.5);
  });

  it("brings the next strike within one new interval when the interval shortens", () => {
    const steady = new BowlsKernel("d", 2, SR);
    steady.set(3, 60, false);
    const changed = new BowlsKernel("d", 2, SR);
    changed.set(3, 60, false);
    // Find a moment with no strike due for over 10 s.
    const due = slots(2, 60, 0, 600);
    const gap = due.findIndex((s, i) => i > 0 && s.t - (due[i - 1]?.t ?? 0) > 30);
    const at = Math.ceil((due[gap - 1]?.t ?? 0) + 2);
    expect((due[gap]?.t ?? 0) - at).toBeGreaterThan(12);
    renderWith(steady, at - 1, 1);
    renderWith(changed, at - 1, 1);
    changed.set(3, 10, false);
    const [a] = renderWith(steady, 12, at);
    const [b] = renderWith(changed, 12, at);
    const difference = b.map((x, i) => x - (a[i] ?? 0));
    // Nothing changes until the new strike, which comes within 10 s.
    expect(peakOf(difference.subarray(0, SR / 2))).toBe(0);
    expect(peakOf(difference.subarray(0, 10 * SR + QUANTUM))).toBeGreaterThan(0.01);
  });

  it("strikes only bowls in the set", () => {
    const kernel = new BowlsKernel("d", 1, SR);
    kernel.set(2, 10, false);
    renderWith(kernel, 120, 100);
    expect(kernel.ringing).toBeLessThanOrEqual(2);
  });
});

describe("guard", () => {
  it("passes quiet samples and never passes the ceiling", () => {
    expect(guard(0.1)).toBe(0.1);
    expect(guard(-0.1)).toBe(-0.1);
    expect(guard(10)).toBeLessThanOrEqual(GUARD_CEILING);
    expect(guard(-10)).toBeGreaterThanOrEqual(-GUARD_CEILING);
  });
});

describe("readBowlsOptions", () => {
  it("reads the key, seed and offset", () => {
    expect(readBowlsOptions({ key: "g", seed: 4.7, offset: 2 })).toEqual({
      key: "g",
      seed: 4,
      offset: 2,
    });
  });

  it("falls back to safe defaults", () => {
    expect(readBowlsOptions({ key: "h", seed: "x" })).toEqual({ key: "d", seed: 0, offset: 0 });
    expect(readBowlsOptions(null)).toEqual({ key: "d", seed: 0, offset: 0 });
  });
});
