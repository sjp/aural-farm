import { describe, expect, it } from "vitest";
import { createRng } from "../../audio/random";
import {
  activeBirds,
  activityFactor,
  airCutoff,
  BIRD_SLOTS,
  birdDb,
  birdProfile,
  BirdsongGenerator,
  CHIP,
  Contour,
  effectiveDistance,
  FEWEST_SYLLABLES,
  HIGHEST_PITCH,
  LONGEST_PHRASE,
  LOWEST_PITCH,
  makeSyllable,
  MOST_SYLLABLES,
  Phrase,
  readBirdsongOptions,
  Schedule,
  sendDb,
  SLUR,
  SYLLABLE_TYPES,
  TIMES_OF_DAY,
  TRILL,
  WARBLE,
  WHISTLE,
  type Syllable,
} from "./birdsong-dsp";
import { BIRDSONG_TIMES } from "./birdsong.meta";

const SR = 48000;
const QUANTUM = 128;
const TIMES = [0, 1, 2] as const;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

interface Settings {
  seed?: number;
  time?: number;
  density?: number;
  distance?: number;
  sampleRate?: number;
}

function generator({ seed = 1, time = 1, density = 50, distance = 40, sampleRate = SR }: Settings) {
  const g = new BirdsongGenerator(seed, sampleRate);
  g.set(time, density, distance);
  return g;
}

/** Renders `g` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(g: BirdsongGenerator, from: number, to: number) {
  const out = [0, 1, 2, 3].map(() => new Float32Array(to - from));
  const q = [0, 1, 2, 3].map(() => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    const length = Math.min(QUANTUM, to - n);
    const [a, b, c, d] = length === QUANTUM ? q : q.map(() => new Float32Array(length));
    g.render(a, b, c, d, n);
    out[0].set(a, n - from);
    out[1].set(b, n - from);
    out[2].set(c, n - from);
    out[3].set(d, n - from);
  }
  return { dryLeft: out[0], dryRight: out[1], wetLeft: out[2], wetRight: out[3] };
}

const peak = (...buffers: Float32Array[]) =>
  Math.max(...buffers.map((b) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));

function maxDifference(a: Float32Array, b: Float32Array, from = 0): number {
  let max = 0;
  for (let i = from; i < a.length; i++) {
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return max;
}

/** Every phrase the schedule gives bird `b` in blocks `from` to `to`, as [start, end] in samples. */
function phrases(schedule: Schedule, b: number, from: number, to: number) {
  const phrase = new Phrase();
  const out: [number, number][] = [];
  for (let k = from; k < to; k++) {
    const t = schedule.candidateTime(b, k);
    if (!Number.isNaN(t) && schedule.phrase(b, k, t, phrase)) {
      out.push([phrase.starts[0], phrase.end]);
    }
  }
  return out;
}

/**
 * Sweeps syllable `s`, sung at `pitch` and `tempo`, sample by sample, a little
 * past its end: its pitch range while it sounds, its amplitude at the first
 * and last sample, and the largest step in amplitude, and in pitch (as a
 * fraction) while it sounds.
 */
function sweep(s: Syllable, pitch: number, tempo: number) {
  const c = new Contour();
  const samples = Math.round((s.length / tempo) * SR) + 2;
  const out = { low: Infinity, high: 0, first: 0, last: 0, amplitudeStep: 0, pitchStep: 0 };
  let lastF = Number.NaN;
  let lastA = 0;
  for (let i = 0; i < samples; i++) {
    c.at(s, pitch, tempo, i / SR);
    const f = c.frequency;
    const a = c.amplitude;
    if (i === 0) {
      out.first = a;
    }
    if (a > 0) {
      out.low = Math.min(out.low, f);
      out.high = Math.max(out.high, f);
      if (lastA > 0) {
        out.pitchStep = Math.max(out.pitchStep, Math.abs(f / lastF - 1));
      }
    }
    out.amplitudeStep = Math.max(out.amplitudeStep, Math.abs(a - lastA));
    lastF = f;
    lastA = a;
  }
  out.last = lastA;
  return out;
}

describe("param mappings", () => {
  it("has the times of day in the order the meta lists them", () => {
    expect(TIMES_OF_DAY).toHaveLength(BIRDSONG_TIMES.length);
  });

  it.each(SEEDS)("sets how many birds sing for seed %d by the time of day", (seed) => {
    expect(activeBirds(seed, 0)).toBeGreaterThanOrEqual(6);
    expect(activeBirds(seed, 0)).toBeLessThanOrEqual(BIRD_SLOTS);
    expect(activeBirds(seed, 1)).toBeGreaterThanOrEqual(4);
    expect(activeBirds(seed, 1)).toBeLessThanOrEqual(5);
    expect(activeBirds(seed, 2)).toBeGreaterThanOrEqual(2);
    expect(activeBirds(seed, 2)).toBeLessThanOrEqual(3);
  });

  it("scales how often birds sing with the Activity", () => {
    expect(activityFactor(0)).toBeCloseTo(0.25);
    expect(activityFactor(50)).toBe(1);
    expect(activityFactor(100)).toBeCloseTo(2.5);
    expect(activityFactor(30)).toBeLessThan(activityFactor(40));
  });

  it("sets a bird's level, softening and reverb by its distance", () => {
    expect(birdDb(0.25)).toBe(-4);
    expect(birdDb(1)).toBe(-24);
    expect(airCutoff(0.25)).toBeCloseTo(7000);
    expect(airCutoff(1)).toBeCloseTo(3000);
    expect(sendDb(0.25)).toBe(-20);
    expect(sendDb(1)).toBe(-10);
  });

  it("pushes every bird further away with the Distance param", () => {
    expect(effectiveDistance(0.25, 0)).toBe(0.25);
    expect(effectiveDistance(0.25, 100)).toBeCloseTo(0.85);
    expect(effectiveDistance(1, 100)).toBe(1);
  });

  it("reads processor options, falling back to safe defaults", () => {
    expect(readBirdsongOptions({ seed: 4.7, offset: 2 })).toEqual({ seed: 4, offset: 2 });
    expect(readBirdsongOptions(undefined)).toEqual({ seed: 0, offset: 0 });
  });
});

describe("profiles", () => {
  it.each(SEEDS)("give seed %d's birds voices and places in range", (seed) => {
    for (let slot = 0; slot < BIRD_SLOTS; slot++) {
      const p = birdProfile(seed, slot);
      expect(p.pitch).toBeGreaterThanOrEqual(2200);
      expect(p.pitch).toBeLessThan(4800);
      expect(p.range).toBeGreaterThanOrEqual(0.4);
      expect(p.range).toBeLessThan(1.2);
      expect(p.tempo).toBeGreaterThanOrEqual(0.8);
      expect(p.tempo).toBeLessThan(1.25);
      expect(p.types.length).toBeGreaterThanOrEqual(3);
      expect(p.types.length).toBeLessThanOrEqual(5);
      expect(p.types).toContain(SLUR);
      expect(p.repertoire.length).toBeGreaterThanOrEqual(3);
      expect(p.repertoire.length).toBeLessThanOrEqual(6);
      expect(p.distance).toBeGreaterThanOrEqual(0.25);
      expect(p.distance).toBeLessThan(1);
      expect(Math.abs(p.pan)).toBeLessThan(0.8);
      for (const pattern of p.repertoire) {
        expect(pattern.length).toBeGreaterThanOrEqual(FEWEST_SYLLABLES);
        expect(pattern.length).toBeLessThanOrEqual(MOST_SYLLABLES);
        expect(pattern.filter((s) => s.type === TRILL).length).toBeLessThanOrEqual(1);
        for (const s of pattern) {
          expect(p.types).toContain(s.type);
          expect(s.gap).toBeGreaterThanOrEqual(0.02);
          expect(s.gap).toBeLessThan(0.12);
        }
      }
    }
  });

  it.each(SEEDS)("keep seed %d's first bird the nearest, and never far to one side", (seed) => {
    const first = birdProfile(seed, 0);
    expect(Math.abs(first.pan)).toBeLessThan(0.3);
    for (let slot = 1; slot < BIRD_SLOTS; slot++) {
      expect(birdProfile(seed, slot).distance).toBeGreaterThan(first.distance);
    }
  });

  it("depend on the seed and slot only", () => {
    expect(birdProfile(3, 4)).toEqual(birdProfile(3, 4));
    expect(birdProfile(3, 4)).not.toEqual(birdProfile(4, 4));
    expect(birdProfile(3, 4)).not.toEqual(birdProfile(3, 5));
  });
});

describe("syllables", () => {
  const NAMES = ["whistle", "slur", "chip", "trill", "warble"];
  const LENGTHS: Record<number, [number, number]> = {
    [WHISTLE]: [0.12, 0.4],
    [SLUR]: [0.06, 0.15],
    [CHIP]: [0.015, 0.04],
    [TRILL]: [0.35, 1.6],
    [WARBLE]: [0.2, 0.6],
  };
  const cases = SYLLABLE_TYPES.map((type) => [NAMES[type], type] as const);
  const made = (type: number) => {
    const rng = createRng(type + 100);
    return Array.from({ length: 40 }, (_, i) =>
      makeSyllable(rng, type, 2200 + (i % 8) * 370, 0.4 + (i % 5) * 0.2),
    );
  };

  it.each(cases)("makes each %s as long as its kind", (_, type) => {
    const [lo, hi] = LENGTHS[type];
    for (const s of made(type)) {
      expect(s.length).toBeGreaterThanOrEqual(lo);
      expect(s.length).toBeLessThanOrEqual(hi);
    }
  });

  it.each(cases)("moves each %s's pitch and amplitude smoothly, from and to silence", (_, type) => {
    for (const s of made(type)) {
      for (const [pitch, tempo] of [
        [0.96, 0.74],
        [1.04, 1.35],
      ]) {
        const swept = sweep(s, pitch, tempo);
        expect(swept.first).toBe(0);
        expect(swept.last).toBe(0);
        expect(swept.amplitudeStep).toBeLessThan(0.025);
        expect(swept.pitchStep).toBeLessThan(0.01);
      }
    }
  });

  it.each(cases)("keeps each %s within its range, and any harmonic under 7.5 kHz", (_, type) => {
    for (const s of made(type)) {
      const swept = sweep(s, 1, 1);
      expect(swept.low).toBeGreaterThanOrEqual(s.low * 0.999);
      expect(swept.high).toBeLessThanOrEqual(s.high * 1.001);
      // A harmonic sounds only where it stays under 7.5 kHz at a phrase's highest pitch.
      expect(s.harmonic === 0 || 2 * s.high * 1.04 <= HIGHEST_PITCH).toBe(true);
    }
  });
});

describe("phrases", () => {
  it.each(SEEDS.slice(0, 5))("sing 2–8 syllables, each within 1.5–7.5 kHz, for seed %d", (seed) => {
    const schedule = new Schedule(seed, SR);
    schedule.set(0, 100);
    const phrase = new Phrase();
    let sung = 0;
    let low = Infinity;
    let high = 0;
    for (let b = 0; b < BIRD_SLOTS; b++) {
      for (let k = 0; k < 120; k++) {
        const t = schedule.candidateTime(b, k);
        if (Number.isNaN(t) || !schedule.phrase(b, k, t, phrase)) {
          continue;
        }
        sung++;
        expect(phrase.count).toBeGreaterThanOrEqual(FEWEST_SYLLABLES);
        expect(phrase.count).toBeLessThanOrEqual(MOST_SYLLABLES);
        expect((phrase.end - phrase.starts[0]) / SR).toBeLessThanOrEqual(LONGEST_PHRASE);
        for (let i = 0; i < phrase.count; i++) {
          const s = phrase.syllables[i];
          const swept = sweep(s, phrase.pitch, phrase.tempo);
          low = Math.min(low, swept.low);
          high = Math.max(high, swept.high);
        }
      }
    }
    expect(sung).toBeGreaterThan(100);
    expect(low).toBeGreaterThanOrEqual(LOWEST_PITCH);
    expect(high).toBeLessThanOrEqual(HIGHEST_PITCH);
  });

  it("are the same for the same seed and differ for another", () => {
    const one = new Schedule(1, SR);
    one.set(1, 50);
    const again = new Schedule(1, SR);
    again.set(1, 50);
    const other = new Schedule(2, SR);
    other.set(1, 50);
    expect(phrases(one, 1, 0, 200)).toEqual(phrases(again, 1, 0, 200));
    expect(phrases(one, 1, 0, 200)).not.toEqual(phrases(other, 1, 0, 200));
  });

  it("open with the nearest bird early in the first second", () => {
    for (const seed of SEEDS) {
      const schedule = new Schedule(seed, SR);
      schedule.set(1, 50);
      const t = schedule.candidateTime(0, 0);
      expect(t).toBeGreaterThanOrEqual(0.15);
      expect(t).toBeLessThan(0.6);
    }
    // At the defaults, the first seed's opening phrase survives.
    const schedule = new Schedule(1, SR);
    schedule.set(1, 50);
    expect(schedule.phrase(0, 0, schedule.candidateTime(0, 0), new Phrase())).toBe(true);
  });
});

describe("schedule", () => {
  it.each(TIMES)("never starts a bird's phrase while it sings, at time of day %d", (time) => {
    for (const seed of [1, 2, 3]) {
      for (const density of [50, 100]) {
        const schedule = new Schedule(seed, SR);
        schedule.set(time, density);
        for (let b = 0; b < BIRD_SLOTS; b++) {
          const sung = phrases(schedule, b, -10, 1500);
          for (let i = 1; i < sung.length; i++) {
            expect(sung[i]?.[0]).toBeGreaterThan(sung[i - 1]?.[1] ?? 0);
          }
        }
      }
    }
  });

  it.each(TIMES)("meets the target phrase rate within 15 %% at time of day %d", (time) => {
    for (const seed of [1, 2, 3, 4]) {
      const schedule = new Schedule(seed, SR);
      schedule.set(time, 50);
      let sung = 0;
      for (let b = 0; b < BIRD_SLOTS; b++) {
        sung += phrases(schedule, b, 1, 5001).length;
      }
      const target = schedule.targets(time, 50).reduce((a, b) => a + b, 0);
      expect(Math.abs(sung / 5000 / target - 1)).toBeLessThan(0.15);
    }
  });

  it("is busier at dawn than in the morning, and sparsest in the day", () => {
    const rate = (time: number) => {
      const schedule = new Schedule(1, SR);
      schedule.set(time, 50);
      let sung = 0;
      for (let b = 0; b < BIRD_SLOTS; b++) {
        sung += phrases(schedule, b, 1, 1001).length;
      }
      return sung;
    };
    expect(rate(0)).toBeGreaterThan(rate(1));
    expect(rate(1)).toBeGreaterThan(rate(2));
  });

  it("sings more with more Activity", () => {
    const rate = (density: number) => {
      const schedule = new Schedule(1, SR);
      schedule.set(1, density);
      let sung = 0;
      for (let b = 0; b < BIRD_SLOTS; b++) {
        sung += phrases(schedule, b, 1, 1001).length;
      }
      return sung;
    };
    expect(rate(0)).toBeGreaterThan(0);
    expect(rate(0)).toBeLessThan(rate(50));
    expect(rate(50)).toBeLessThan(rate(100));
  });
});

describe("the generator", () => {
  it("renders a phrase across a chunk seam as it does in one render", () => {
    // A seam part-way through the second syllable of seed 1's opening phrase.
    const schedule = new Schedule(1, SR);
    schedule.set(1, 50);
    const phrase = new Phrase();
    schedule.phrase(0, 0, schedule.candidateTime(0, 0), phrase);
    const seam = phrase.starts[1] + Math.floor(phrase.lengths[1] / 2) + 37;
    const from = 0;
    const to = phrase.end + SR / 10;
    const whole = render(generator({}), from, to);
    const first = render(generator({}), from, seam);
    const second = render(generator({}), seam, to);
    const joined = (a: Float32Array, b: Float32Array) => {
      const out = new Float32Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    };
    // The birds alone (the reverb send) match exactly; the dry mix once the air's filters settle.
    expect(peak(whole.wetLeft.subarray(seam - 1000, seam + 1000))).toBeGreaterThan(0);
    expect(maxDifference(whole.wetLeft, joined(first.wetLeft, second.wetLeft))).toBe(0);
    expect(maxDifference(whole.wetRight, joined(first.wetRight, second.wetRight))).toBe(0);
    const settled = seam + SR / 50;
    expect(
      maxDifference(whole.dryLeft, joined(first.dryLeft, second.dryLeft), settled),
    ).toBeLessThan(1e-7);
    expect(
      maxDifference(whole.dryRight, joined(first.dryRight, second.dryRight), settled),
    ).toBeLessThan(1e-7);
  });

  it("renders the same from a seed every time and differently for another", () => {
    const a = render(generator({ seed: 5 }), SR * 20, SR * 30);
    const b = render(generator({ seed: 5 }), SR * 20, SR * 30);
    const c = render(generator({ seed: 6 }), SR * 20, SR * 30);
    expect(maxDifference(a.dryLeft, b.dryLeft)).toBe(0);
    expect(maxDifference(a.dryLeft, c.dryLeft)).toBeGreaterThan(0.01);
  });

  it.each(TIMES)(
    "stays finite and well under full scale at Activity 100, Distance 0, time of day %d",
    (time) => {
      for (const seed of [1, 2]) {
        const out = render(generator({ seed, time, density: 100, distance: 0 }), 0, SR * 20);
        for (const channel of Object.values(out)) {
          expect(channel.every((v) => Number.isFinite(v))).toBe(true);
        }
        expect(peak(out.dryLeft, out.dryRight)).toBeLessThan(0.5);
        expect(peak(out.wetLeft, out.wetRight)).toBeLessThan(0.1);
      }
    },
  );

  it("fills the gaps with faint air, never digital silence", () => {
    const out = render(generator({ time: 2, density: 0 }), SR * 40, SR * 41);
    expect(out.dryLeft.some((v) => v !== 0)).toBe(true);
    expect(out.dryRight.some((v) => v !== 0)).toBe(true);
  });
});
