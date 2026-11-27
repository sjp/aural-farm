import { describe, expect, it } from "vitest";
import { createEventBlock, eventsInBlock } from "../../audio/dsp/events";
import { ModalBank } from "../../audio/dsp/modal";
import {
  CANDIDATE_RATE,
  CHIMES_CHANNELS,
  ChimesKernel,
  clapperPlace,
  DECAY_POWER,
  DETUNE,
  FLOOR_RATE,
  guard,
  gustShape,
  keepChance,
  knockEnvelope,
  MODE_TOP,
  pickTube,
  PICK_SPREAD,
  readChimesOptions,
  STRENGTH,
  type Strike,
  STRIKE_STREAM,
  StrikeScheduler,
  TUBE_PAN,
  tubeCount,
  tubeFundamental,
  tubeModes,
  tubePan,
  TUNINGS,
} from "./chimes-dsp";
import { MAX_TUBES, MIN_TUBES, type ChimeTuning } from "./chimes.meta";

const SR = 48000;
const QUANTUM = 128;
const TUNING_NAMES = Object.keys(TUNINGS) as ChimeTuning[];
const SCALES: Record<ChimeTuning, readonly number[]> = {
  major: [0, 2, 4, 7, 9],
  minor: [0, 3, 5, 7, 10],
  "in-scale": [0, 1, 5, 7, 8],
  bamboo: [0, 2, 4, 7, 9],
};
const ROOTS: Record<ChimeTuning, number> = {
  major: 440,
  minor: 440,
  "in-scale": 329.6,
  bamboo: 146.8,
};

const peakOf = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

interface Settings {
  tuning?: ChimeTuning;
  seed?: number;
  tubes?: number;
  wind?: number;
  sampleRate?: number;
}

/** Renders `seconds` from absolute second `from`, a quantum at a time, as two channels. */
function render(
  seconds: number,
  { tuning = "major", seed = 1, tubes = 5, wind = 35, sampleRate = SR }: Settings = {},
  from = 0,
): [Float32Array, Float32Array] {
  const kernel = new ChimesKernel(tuning, seed, sampleRate);
  kernel.set(tubes, wind);
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

/** The largest difference between `a` and `b`. */
function worstDifference(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (const [i, x] of a.entries()) {
    worst = Math.max(worst, Math.abs(x - (b[i] ?? 0)));
  }
  return worst;
}

/** Every kept strike over `seconds` from 0: its time, tube and strength. */
function strikes(
  seconds: number,
  { seed = 1, wind = 35, tubes = 5 }: Settings = {},
): { t: number; tube: number; strength: number }[] {
  const scheduler = new StrikeScheduler(seed, SR);
  const block = createEventBlock(64);
  const struck: Strike = { tube: -1, strength: 0 };
  const kept = [];
  for (let b = 0; b < seconds; b++) {
    eventsInBlock(seed, STRIKE_STREAM, b, CANDIDATE_RATE, block);
    for (let i = 0; i < block.count; i++) {
      const t = b + (block.offsets[i] ?? 0);
      scheduler.strike(b, i, t, wind, tubes, struck);
      if (struck.tube >= 0) {
        kept.push({ t, tube: struck.tube, strength: struck.strength });
      }
    }
  }
  return kept;
}

describe("tuning tables", () => {
  it.each(TUNING_NAMES)(
    "%s: ascending fundamentals on its scale, climbing by octaves",
    (tuning) => {
      const scale = SCALES[tuning];
      for (let tubes = MIN_TUBES; tubes <= MAX_TUBES; tubes++) {
        const fundamentals = Array.from({ length: tubes }, (_, i) => tubeFundamental(tuning, i));
        for (const [i, f] of fundamentals.entries()) {
          const semitones = 12 * Math.log2(f / ROOTS[tuning]);
          const expected = (scale[i % scale.length] ?? 0) + 12 * Math.floor(i / scale.length);
          expect(semitones).toBeCloseTo(expected, 1);
          expect(f).toBeGreaterThan(i > 0 ? (fundamentals[i - 1] ?? 0) : 0);
        }
      }
    },
  );

  it.each(TUNING_NAMES)("%s: no mode above 7.5 kHz, detuned at most 0.4 %%", (tuning) => {
    const ratios = TUNINGS[tuning].ratios;
    for (let seed = 1; seed <= 5; seed++) {
      for (let i = 0; i < MAX_TUBES; i++) {
        const modes = tubeModes(tuning, seed, i);
        const fundamental = tubeFundamental(tuning, i);
        expect(modes.length).toBeGreaterThan(0);
        expect(modes.length).toBeLessThanOrEqual(ratios.length);
        for (const [m, mode] of modes.entries()) {
          expect(mode.frequency).toBeLessThanOrEqual(MODE_TOP);
          const nominal = fundamental * (ratios[m] ?? 0);
          expect(Math.abs(mode.frequency / nominal - 1)).toBeLessThanOrEqual(DETUNE);
        }
      }
    }
  });

  it("keeps every mode below 7.5 kHz and drops those above it", () => {
    // The top tube of Pentatonic major is near 1.1 kHz: its fourth mode, near 9.9 kHz, goes.
    expect(tubeModes("major", 1, MAX_TUBES - 1)).toHaveLength(3);
    expect(tubeModes("major", 1, 0)).toHaveLength(4);
  });

  it.each(TUNING_NAMES)("%s: the fundamental rings longest, the higher modes shorter", (tuning) => {
    const { decay, ratios } = TUNINGS[tuning];
    for (let i = 0; i < MAX_TUBES; i++) {
      const modes = tubeModes(tuning, 3, i);
      const base = modes[0]?.decay ?? 0;
      expect(base).toBeGreaterThanOrEqual(decay[0]);
      expect(base).toBeLessThanOrEqual(decay[1]);
      for (const [m, mode] of modes.entries()) {
        expect(mode.decay).toBeCloseTo(base / (ratios[m] ?? 1) ** DECAY_POWER, 6);
      }
    }
  });

  it("differs from seed to seed, but is the same for a seed", () => {
    expect(tubeModes("major", 1, 2)).toEqual(tubeModes("major", 1, 2));
    expect(tubeModes("major", 1, 2)[0]?.frequency).not.toBe(tubeModes("major", 2, 2)[0]?.frequency);
  });
});

describe("modal reuse", () => {
  it.each([
    ["major", 0],
    ["in-scale", 4],
    ["bamboo", 2],
  ] as const)(
    "%s tube %i's fundamental falls 60 dB in its decay time, within 5 %%",
    (tuning, i) => {
      const [mode] = tubeModes(tuning, 1, i);
      const bank = new ModalBank(SR, 1);
      bank.setMode(0, mode.frequency, mode.decay, 1);
      bank.strike(1);
      const length = Math.ceil(mode.decay * 1.2 * SR);
      const out = new Float32Array(length);
      bank.render(out, 0, length);
      // The ring's peak over one period at the start, and the first period it is 60 dB below.
      const period = Math.ceil(SR / mode.frequency);
      const start = peakOf(out.subarray(0, period));
      let crossed = length;
      for (let at = 0; at + period <= length; at += period) {
        if (peakOf(out.subarray(at, at + period)) < start / 1000) {
          crossed = at;
          break;
        }
      }
      expect(Math.abs(crossed / SR / mode.decay - 1)).toBeLessThan(0.05);
    },
  );
});

describe("tubes", () => {
  it("counts whole tubes, from 3 to 8", () => {
    expect(tubeCount(5.4)).toBe(5);
    expect(tubeCount(1)).toBe(MIN_TUBES);
    expect(tubeCount(20)).toBe(MAX_TUBES);
    expect(tubeCount(Number.NaN)).toBe(MIN_TUBES);
  });

  it("hang evenly across ±0.6 in order", () => {
    expect(tubePan(0, 5)).toBeCloseTo(-TUBE_PAN);
    expect(tubePan(2, 5)).toBeCloseTo(0);
    expect(tubePan(4, 5)).toBeCloseTo(TUBE_PAN);
    expect(tubePan(1, 3)).toBeCloseTo(0);
  });
});

describe("strike scheduler", () => {
  it("rises with the drift into gusts, from 0 in a dead lull to 1 at the top", () => {
    expect(gustShape(-1)).toBe(0);
    expect(gustShape(1)).toBe(1);
    expect(gustShape(0)).toBeCloseTo(0.5 ** 1.8);
    expect(gustShape(0.3)).toBeGreaterThan(gustShape(0.1));
  });

  it("keeps more strikes in stronger gusts and stronger wind, with a floor at Wind 0", () => {
    expect(keepChance(0.5, 60)).toBeGreaterThan(keepChance(0.2, 60));
    expect(keepChance(0.5, 60)).toBeGreaterThan(keepChance(0.5, 30));
    expect(keepChance(1, 100)).toBeCloseTo(0.8);
    expect(keepChance(1, 0)).toBeCloseTo(FLOOR_RATE / CANDIDATE_RATE);
  });

  it("is the same for a seed and block, and differs between seeds", () => {
    expect(strikes(60)).toEqual(strikes(60));
    expect(strikes(60, { seed: 2 })).not.toEqual(strikes(60));
  });

  it("picks each strike's tube from its time and hash alone, never from earlier strikes", () => {
    const scheduler = new StrikeScheduler(4, SR);
    const block = createEventBlock(64);
    const forward: number[] = [];
    const backward: number[] = [];
    const struck: Strike = { tube: -1, strength: 0 };
    for (let b = 0; b < 40; b++) {
      eventsInBlock(4, STRIKE_STREAM, b, CANDIDATE_RATE, block);
      for (let i = 0; i < block.count; i++) {
        scheduler.strike(b, i, b + (block.offsets[i] ?? 0), 100, 8, struck);
        forward.push(struck.tube);
      }
    }
    const fresh = new StrikeScheduler(4, SR);
    for (let b = 39; b >= 0; b--) {
      eventsInBlock(4, STRIKE_STREAM, b, CANDIDATE_RATE, block);
      const picks = [];
      for (let i = block.count - 1; i >= 0; i--) {
        fresh.strike(b, i, b + (block.offsets[i] ?? 0), 100, 8, struck);
        picks.unshift(struck.tube);
      }
      backward.unshift(...picks);
    }
    expect(backward).toEqual(forward);
  });

  it("strikes more often as the wind rises, and in the gusts", () => {
    const at = (wind: number) => strikes(600, { wind }).length;
    expect(at(0)).toBeLessThan(at(35));
    expect(at(35)).toBeLessThan(at(100));
    // Kept strikes land in stronger gusts than the candidates on average.
    const scheduler = new StrikeScheduler(1, SR);
    const kept = strikes(600, { wind: 35 });
    const keptGust = kept.reduce((sum, s) => sum + scheduler.gustAt(s.t), 0) / kept.length;
    let all = 0;
    for (let t = 0; t < 600; t += 0.1) {
      all += scheduler.gustAt(t);
    }
    expect(keptGust).toBeGreaterThan((1.15 * all) / 6000);
  });

  it("strikes about once in 20 s at Wind 0", () => {
    const count = strikes(2000, { wind: 0 }).length;
    expect(count).toBeGreaterThan(60);
    expect(count).toBeLessThan(140);
  });

  it("strikes 0.3–1 times hard, and only the tubes in the set", () => {
    for (const s of strikes(300, { wind: 100, tubes: 4 })) {
      expect(s.tube).toBeGreaterThanOrEqual(0);
      expect(s.tube).toBeLessThan(4);
      expect(s.strength).toBeGreaterThanOrEqual(STRENGTH[0] * 0.4);
      expect(s.strength).toBeLessThanOrEqual(STRENGTH[1]);
    }
  });

  it("lands near the clapper", () => {
    for (const place of [0, 0.3, 1]) {
      for (const u of [0, 0.5, 0.999]) {
        const tube = pickTube(place, u, 8);
        expect(Math.abs(tube - place * 7)).toBeLessThanOrEqual(PICK_SPREAD + 0.5);
      }
    }
    expect(clapperPlace(-1)).toBe(0);
    expect(clapperPlace(0)).toBe(0.5);
    expect(clapperPlace(1)).toBe(1);
  });
});

describe("knock and guard", () => {
  it("knocks with a quick rise and a fall to nothing", () => {
    expect(knockEnvelope(0)).toBe(0);
    expect(knockEnvelope(0.1)).toBeCloseTo(1);
    expect(knockEnvelope(0.5)).toBeLessThan(1);
    expect(knockEnvelope(1)).toBe(0);
  });

  it("leaves quiet samples alone and never passes −4.5 dBFS", () => {
    expect(guard(0.1)).toBe(0.1);
    expect(guard(-0.1)).toBe(-0.1);
    expect(guard(10)).toBeLessThanOrEqual(10 ** (-4.5 / 20));
    expect(guard(-10)).toBeGreaterThanOrEqual(-(10 ** (-4.5 / 20)));
  });
});

describe("kernel", () => {
  it("has two channels", () => {
    expect(CHIMES_CHANNELS).toBe(2);
  });

  it.each(TUNING_NAMES)("%s: is deterministic per seed, and finite", (tuning) => {
    const [a] = render(20, { tuning });
    const [b] = render(20, { tuning });
    const [c] = render(20, { tuning, seed: 2 });
    expect(worstDifference(a, b)).toBe(0);
    expect(worstDifference(a, c)).toBeGreaterThan(0);
    expect(a.every((x) => Number.isFinite(x))).toBe(true);
    expect(peakOf(a)).toBeGreaterThan(0);
  });

  it.each(TUNING_NAMES)(
    "%s: is time-addressable: a render from 20 s matches one from 0",
    (tuning) => {
      const [whole] = render(25, { tuning, wind: 100 });
      const [part] = render(5, { tuning, wind: 100 }, 20);
      expect(worstDifference(whole.subarray(20 * SR), part)).toBeLessThan(1e-4);
    },
  );

  it.each(TUNING_NAMES)(
    "%s: every tube struck at once at full strength peaks under −3 dBFS",
    (tuning) => {
      const kernel = new ChimesKernel(tuning, 1, SR);
      kernel.set(MAX_TUBES, 100);
      const left = new Float32Array(QUANTUM);
      const right = new Float32Array(QUANTUM);
      kernel.render(left, right, 0);
      kernel.strikeAll(1);
      let peak = 0;
      for (let done = QUANTUM; done < 3 * SR; done += QUANTUM) {
        kernel.render(left, right, done);
        peak = Math.max(peak, peakOf(left), peakOf(right));
      }
      expect(peak).toBeGreaterThan(0.1);
      expect(peak).toBeLessThanOrEqual(10 ** (-3 / 20));
    },
  );

  it.each(TUNING_NAMES)("%s: peaks under −3 dBFS at Wind 100 with 8 tubes", (tuning) => {
    const [left, right] = render(60, { tuning, wind: 100, tubes: MAX_TUBES });
    expect(Math.max(peakOf(left), peakOf(right))).toBeLessThanOrEqual(10 ** (-3 / 20));
  });

  it("lets a tube left out of the set ring out, and strikes it no more", () => {
    const kernel = new ChimesKernel("major", 1, SR);
    kernel.set(MAX_TUBES, 100);
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    let at = 0;
    let most = 0;
    for (; at < 60 * SR; at += QUANTUM) {
      kernel.render(left, right, at);
      most = Math.max(most, kernel.ringing);
    }
    expect(most).toBeGreaterThan(MIN_TUBES);
    kernel.set(MIN_TUBES, 100);
    // Every tube has rung out 1.5 times its longest decay after its last strike.
    for (; at < 75 * SR; at += QUANTUM) {
      kernel.render(left, right, at);
    }
    expect(kernel.ringing).toBeLessThanOrEqual(MIN_TUBES);
  });

  it("is about as loud at 44.1 kHz as at 48 kHz", () => {
    const power = (channels: Float32Array[]) =>
      channels.reduce((sum, c) => sum + c.reduce((s, x) => s + x * x, 0) / c.length, 0);
    const at48 = power(render(30, { wind: 100 }));
    const at44 = power(render(30, { wind: 100, sampleRate: 44100 }));
    expect(Math.abs(10 * Math.log10(at44 / at48))).toBeLessThan(0.5);
  });
});

describe("readChimesOptions", () => {
  it("reads the tuning, seed and offset", () => {
    expect(readChimesOptions({ tuning: "bamboo", seed: 7.6, offset: 3 })).toEqual({
      tuning: "bamboo",
      seed: 7,
      offset: 3,
    });
  });

  it("falls back to safe defaults", () => {
    expect(readChimesOptions(undefined)).toEqual({ tuning: "major", seed: 0, offset: 0 });
    expect(readChimesOptions({ tuning: "brass", seed: "x" })).toEqual({
      tuning: "major",
      seed: 0,
      offset: 0,
    });
  });
});
