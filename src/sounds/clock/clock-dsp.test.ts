import { describe, expect, it } from "vitest";
import { hashFloat } from "../../audio/random";
import {
  Beats,
  CHIME_LENGTH,
  CLOCKS,
  ClockKernel,
  HOUR,
  JITTER,
  ROOM_TONE_DB,
  preClickLead,
  readClockOptions,
  ringLength,
  tickTockPeriod,
  tockSkew,
  toneCutoff,
} from "./clock-dsp";
import type { ClockType } from "./clock.meta";

const SR = 48000;
const QUANTUM = 128;
const TYPES: ClockType[] = ["mantel", "wall", "grandfather"];
const JITTER_STREAM = 1;

const dbfs = (x: number) => 20 * Math.log10(x);

function peakOf(x: Float32Array): number {
  let peak = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

function energy(x: Float32Array): number {
  let sum = 0;
  for (const v of x) {
    sum += v * v;
  }
  return sum;
}

function largestDifference(a: Float32Array, b: Float32Array): number {
  let largest = 0;
  for (let i = 0; i < a.length; i++) {
    largest = Math.max(largest, Math.abs(a[i] - b[i]));
  }
  return largest;
}

interface Settings {
  /** With the room tone; the beats alone by default. */
  roomTone?: boolean;
  type?: ClockType;
  seed?: number;
  tone?: number;
  chime?: number;
  sampleRate?: number;
}

function kernel({
  type = "mantel",
  seed = 1,
  tone = 35,
  chime = 0,
  sampleRate = SR,
  roomTone = false,
}: Settings) {
  const k = new ClockKernel(type, seed, sampleRate, roomTone);
  k.set(tone, chime);
  return k;
}

/** Renders `k` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(k: ClockKernel, from: number, to: number): [Float32Array, Float32Array] {
  const left = new Float32Array(to - from);
  const right = new Float32Array(to - from);
  const ql = new Float32Array(QUANTUM);
  const qr = new Float32Array(QUANTUM);
  for (let n = from; n < to; n += QUANTUM) {
    k.render(ql, qr, n);
    const length = Math.min(QUANTUM, to - n);
    left.set(ql.subarray(0, length), n - from);
    right.set(qr.subarray(0, length), n - from);
  }
  return [left, right];
}

/** Beat n's time from the formula: n · beat, the tock's skew, and ±0.8 ms of hashed jitter. */
function formulaTime(type: ClockType, seed: number, n: number): number {
  const jitter = (2 * hashFloat(seed, JITTER_STREAM, n) - 1) * JITTER;
  return n * CLOCKS[type].beat + ((n & 1) === 1 ? tockSkew(type, seed) : 0) + jitter;
}

describe("beats", () => {
  it.each(TYPES)("puts %s's beats at the formula's times", (type) => {
    const beats = new Beats(type, 4);
    for (let n = -5; n < 500; n++) {
      expect(beats.timeOf(n)).toBeCloseTo(formulaTime(type, 4, n), 9);
    }
  });

  it.each(TYPES)("keeps %s's jitter within ±0.8 ms, and uses the range", (type) => {
    const beats = new Beats(type, 2);
    const skew = tockSkew(type, 2);
    let widest = 0;
    for (let n = 0; n < 2000; n++) {
      const off = beats.timeOf(n) - n * CLOCKS[type].beat - ((n & 1) === 1 ? skew : 0);
      expect(Math.abs(off)).toBeLessThanOrEqual(JITTER + 1e-12);
      widest = Math.max(widest, Math.abs(off));
    }
    expect(widest).toBeGreaterThan(0.9 * JITTER);
  });

  it.each([1, 2, 3, 50, 999])("skews seed %i's tocks by 1–3 %% of the beat", (seed) => {
    for (const type of TYPES) {
      const share = tockSkew(type, seed) / CLOCKS[type].beat;
      expect(share).toBeGreaterThanOrEqual(0.01);
      expect(share).toBeLessThanOrEqual(0.03);
    }
  });

  it.each(TYPES)("makes %s's tick-to-tock and tock-to-tick gaps differ by the skew", (type) => {
    const beats = new Beats(type, 7);
    const skew = tockSkew(type, 7);
    let tickToTock = 0;
    let tockToTick = 0;
    const pairs = 500;
    for (let n = 0; n < 2 * pairs; n += 2) {
      tickToTock += beats.timeOf(n + 1) - beats.timeOf(n);
      tockToTick += beats.timeOf(n + 2) - beats.timeOf(n + 1);
    }
    // On average the tock is `skew` late, so the gaps differ by twice it.
    expect((tickToTock - tockToTick) / pairs).toBeCloseTo(2 * skew, 4);
    expect(tickToTock / pairs).toBeGreaterThan(CLOCKS[type].beat);
  });

  it("seeds the pre-click 6–12 ms ahead", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(preClickLead(seed)).toBeGreaterThanOrEqual(0.006);
      expect(preClickLead(seed)).toBeLessThanOrEqual(0.012);
    }
  });

  it("gives a tick-tock's period", () => {
    expect(tickTockPeriod("mantel")).toBeCloseTo(0.9);
    expect(tickTockPeriod("wall")).toBeCloseTo(1.5);
    expect(tickTockPeriod("grandfather")).toBeCloseTo(2);
  });
});

describe("tone", () => {
  it("runs the low-pass from 2.5 kHz to 6.5 kHz, never above 8 kHz", () => {
    expect(toneCutoff(0)).toBe(2500);
    expect(toneCutoff(100)).toBe(6500);
    expect(toneCutoff(1000)).toBeLessThan(8000);
  });
});

describe("kernel", () => {
  it.each(TYPES.flatMap((type) => [0, 777, SR * 100 + 5].map((start) => ({ type, start }))))(
    "strikes $type's beats on their samples from a render at $start",
    ({ type, start }) => {
      const seed = 3;
      const k = kernel({ type, seed });
      const beat = CLOCKS[type].beat;
      const pre = Math.round(preClickLead(seed) * SR);
      const [left] = render(k, start, start + Math.round(6 * beat * SR));
      // Between beats the clock is silent, so each beat's first sound is its pre-click.
      const first = Math.ceil(start / SR / beat) + 1;
      for (let n = first; n < first + 4; n++) {
        const main = Math.round(formulaTime(type, seed, n) * SR);
        const from = main - pre - Math.round(0.1 * beat * SR) - start;
        let onset = from;
        while (left[onset] === 0) {
          onset++;
        }
        expect(Math.abs(onset + start + pre - main)).toBeLessThanOrEqual(1);
      }
    },
  );

  it.each(TYPES)("renders %s the same for the same seed, differently for another", (type) => {
    const length = 2 * SR;
    const [a] = render(kernel({ type, seed: 5 }), 0, length);
    const [b] = render(kernel({ type, seed: 5 }), 0, length);
    const [c] = render(kernel({ type, seed: 6 }), 0, length);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it.each(TYPES.flatMap((type) => [0, 35, 100].map((tone) => ({ type, tone }))))(
    "keeps $type at Tone $tone finite and its peak bounded",
    ({ type, tone }) => {
      let peak = 0;
      let finite = true;
      for (let seed = 0; seed < 4; seed++) {
        const [left, right] = render(kernel({ type, tone, seed }), 0, 8 * SR);
        finite &&= left.every((v) => Number.isFinite(v)) && right.every((v) => Number.isFinite(v));
        peak = Math.max(peak, peakOf(left), peakOf(right));
      }
      expect(finite).toBe(true);
      // Below −9 dBFS at the default Tone, −6 at any.
      expect(dbfs(peak)).toBeLessThan(tone === 35 ? -9 : -6);
      expect(dbfs(peak)).toBeGreaterThan(-16);
    },
  );

  it.each(TYPES)("rings %s for no longer than its ring length", (type) => {
    const beat = CLOCKS[type].beat;
    const [left] = render(kernel({ type }), 0, Math.round(10 * beat * SR));
    // Count the samples sounding per beat.
    let sounding = 0;
    for (const v of left) {
      if (v !== 0) {
        sounding++;
      }
    }
    expect(sounding / 10).toBeLessThan(ringLength(type) * SR + 2 * QUANTUM);
    expect(ringLength(type)).toBeLessThan(0.2);
  });

  it.each(TYPES)("renders %s the same at the start of a render as mid-way", (type) => {
    const from = Math.round(3.21 * SR);
    const [long] = render(kernel({ type }), 0, from + 2 * SR);
    const [fresh] = render(kernel({ type }), from, from + 2 * SR);
    const tail = long.subarray(from);
    expect(largestDifference(fresh, tail)).toBeLessThan(1e-6);
  });

  it.each(TYPES)("sounds %s at the same level at 44.1 kHz", (type) => {
    const [a] = render(kernel({ type }), 0, 20 * SR);
    const [b] = render(kernel({ type, sampleRate: 44100 }), 0, 20 * 44100);
    const level = (x: Float32Array, sr: number) => 10 * Math.log10(energy(x) / sr);
    expect(Math.abs(level(a, SR) - level(b, 44100))).toBeLessThan(1);
  });

  it("puts tocks a little lower and quieter than ticks", () => {
    const type = "mantel";
    const seed = 2;
    const [left] = render(kernel({ type, seed }), 0, 20 * SR);
    let ticks = 0;
    let tocks = 0;
    for (let n = 1; n < 40; n++) {
      const main = Math.round(formulaTime(type, seed, n) * SR);
      const e = energy(left.subarray(main - 0.02 * SR, main + 0.08 * SR));
      if ((n & 1) === 1) {
        tocks += e;
      } else {
        ticks += e;
      }
    }
    expect(10 * Math.log10(tocks / ticks)).toBeLessThan(0);
    expect(10 * Math.log10(tocks / ticks)).toBeGreaterThan(-4);
  });
});

describe("room tone", () => {
  it.each([SR, 44100])("sits at its level between the beats at %i Hz", (sampleRate) => {
    const k = kernel({ roomTone: true, sampleRate });
    // A stretch with no beat ringing: from 0.2 s to 0.4 s, between the first two.
    const from = Math.round(0.2 * sampleRate);
    const [left, right] = render(k, 0, Math.round(0.4 * sampleRate));
    for (const side of [left, right]) {
      const level = 10 * Math.log10(energy(side.subarray(from)) / (side.length - from));
      expect(Math.abs(level - ROOM_TONE_DB)).toBeLessThan(1.5);
    }
  });

  it("is the same from a fresh render as from a longer one, once its filters settle", () => {
    const [long] = render(kernel({ roomTone: true }), 0, 3 * SR);
    const [fresh] = render(kernel({ roomTone: true }), 2 * SR, 3 * SR);
    expect(largestDifference(fresh.subarray(0.2 * SR), long.subarray(2.2 * SR))).toBeLessThan(1e-6);
  });

  it("is different on each side", () => {
    const [left, right] = render(kernel({ roomTone: true }), 0, Math.round(0.4 * SR));
    expect(largestDifference(left.subarray(0.2 * SR), right.subarray(0.2 * SR))).toBeGreaterThan(0);
  });
});

describe("chime", () => {
  const hour = HOUR * SR;

  it.each(TYPES)("chimes %s softly on the hour when on", (type) => {
    const from = hour - SR;
    const to = hour + Math.ceil(CHIME_LENGTH * SR) + SR;
    const [on] = render(kernel({ type, chime: 1 }), from, to);
    const [off] = render(kernel({ type, chime: 0 }), from, to);
    const chime = on.map((v, i) => v - off[i]);
    // Nothing before the hour, a chime after it, gone by its end.
    expect(peakOf(chime.subarray(0, SR))).toBe(0);
    expect(peakOf(chime.subarray(SR, 2 * SR))).toBeGreaterThan(0.01);
    expect(peakOf(chime.subarray(chime.length - SR))).toBe(0);
    // No more than 3 dB above a tick's peak.
    expect(peakOf(chime)).toBeLessThan(peakOf(off) * 10 ** (3 / 20));
  });

  it.each(TYPES)("leaves %s's gaps silent at the hour when off", (type) => {
    const [off] = render(kernel({ type, chime: 0 }), hour, hour + 3 * SR);
    let silent = 0;
    for (const v of off) {
      if (v === 0) {
        silent++;
      }
    }
    // Only the beats sound: most of the time nothing does.
    expect(silent / off.length).toBeGreaterThan(0.6);
  });

  it("doesn't chime at time 0", () => {
    const [on] = render(kernel({ chime: 1 }), 0, 3 * SR);
    const [off] = render(kernel({ chime: 0 }), 0, 3 * SR);
    expect(on).toEqual(off);
  });

  it("renders the chime the same from a fresh render as from a longer one", () => {
    const [long] = render(kernel({ type: "wall", chime: 1 }), hour - 5 * SR, hour + 3 * SR);
    const [fresh] = render(kernel({ type: "wall", chime: 1 }), hour + SR, hour + 3 * SR);
    const tail = long.subarray(6 * SR);
    expect(largestDifference(fresh, tail)).toBeLessThan(1e-6);
  });

  it("fades the chime out without a jump when turned off", () => {
    const k = kernel({ type: "grandfather", chime: 1 });
    const [before] = render(k, hour, hour + SR);
    k.set(35, 0);
    const [after] = render(k, hour + SR, hour + 2 * SR);
    const [off] = render(kernel({ type: "grandfather" }), hour, hour + 2 * SR);
    const chime = Float32Array.from([...before, ...after], (v, i) => v - off[i]);
    // No step where it turns off, and gone within a quarter-second.
    let step = 0;
    for (let i = 1; i < chime.length; i++) {
      step = Math.max(step, Math.abs(chime[i] - chime[i - 1]));
    }
    expect(step).toBeLessThan(peakOf(chime) / 4);
    expect(peakOf(chime.subarray(SR + 0.05 * SR, SR + 0.1 * SR))).toBeGreaterThan(0);
    expect(peakOf(chime.subarray(SR + 0.25 * SR))).toBeLessThan(peakOf(chime) / 100);
  });
});

describe("options", () => {
  it("reads the clock, seed and offset, falling back to safe defaults", () => {
    expect(readClockOptions({ type: "wall", seed: 3.7, offset: 2 })).toEqual({
      type: "wall",
      seed: 3,
      offset: 2,
    });
    expect(readClockOptions({ type: "cuckoo" })).toEqual({ type: "mantel", seed: 0, offset: 0 });
    expect(readClockOptions(undefined)).toEqual({ type: "mantel", seed: 0, offset: 0 });
  });
});
