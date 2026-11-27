import { describe, expect, it } from "vitest";
import { bandEnergyDb, rmsDb } from "../../audio/analysis";
import { biquadCoefficients, BUTTERWORTH_Q, filterSamples } from "../../audio/biquad";
import { createPeriodicEvents } from "../../audio/dsp/periodic";
import { HASH_START, hashStep } from "../../audio/random";
import {
  airCutoff,
  boutGain,
  CHIRP_JITTER,
  chirpPeriod,
  chirpsPerMinute,
  chorusDb,
  Cricket,
  CRICKET_SLOTS,
  cricketDb,
  cricketTraits,
  effectiveDistance,
  InsectsGenerator,
  katydidCount,
  katydidTraits,
  onePoleGain,
  pulseRate,
  readInsectsOptions,
  sendDb,
} from "./insects-dsp";
import { MAX_CRICKETS } from "./insects.meta";

const SR = 48000;
const QUANTUM = 128;

interface Settings {
  seed?: number;
  count?: number;
  warmth?: number;
  distance?: number;
  katydids?: number;
  sampleRate?: number;
}

function generator({
  seed = 1,
  count = 5,
  warmth = 20,
  distance = 40,
  katydids = 0,
  sampleRate = SR,
}: Settings) {
  const g = new InsectsGenerator(seed, warmth, sampleRate);
  g.set(count, warmth, distance, katydids);
  return g;
}

/** Renders `g` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(
  g: { render: (l: Float32Array, r: Float32Array, start: number) => void },
  from: number,
  to: number,
  before?: (start: number) => void,
) {
  const left = new Float32Array(to - from);
  const right = new Float32Array(to - from);
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  for (let n = from; n < to; n += QUANTUM) {
    const length = Math.min(QUANTUM, to - n);
    const [bl, br] =
      length === QUANTUM ? [l, r] : [new Float32Array(length), new Float32Array(length)];
    before?.(n);
    g.render(bl, br, n);
    left.set(bl, n - from);
    right.set(br, n - from);
  }
  return { left, right };
}

/** Renders cricket `index` alone, as the generator would, adding into silence. */
function renderCricket(seed: number, index: number, from: number, to: number) {
  const params = { warmth: 20, distance: 40 };
  const cricket = new Cricket(seed, index, params.warmth);
  cricket.target = 1;
  cricket.restart(from / SR, params);
  return render(
    {
      render(l, r, start) {
        l.fill(0);
        r.fill(0);
        cricket.render(l, r, l.length, start / SR, 1 / SR, params);
      },
    },
    from,
    to,
  );
}

/** The comfort low-pass the sound puts over the worklet's output. */
const comfort = (x: Float32Array) =>
  filterSamples(biquadCoefficients({ type: "lowpass", frequency: 7000, Q: BUTTERWORTH_Q }, SR), x);

const peak = (...buffers: Float32Array[]) =>
  Math.max(...buffers.map((b) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));

const allFinite = (b: Float32Array) => b.every((v) => Number.isFinite(v));

function maxDifference(a: Float32Array, b: Float32Array, from = 0): number {
  let max = 0;
  for (let i = from; i < a.length; i++) {
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return max;
}

describe("param mappings", () => {
  it("follows Dolbear's law: 54, 110 and 166 chirps a minute at 12, 20 and 28 °C", () => {
    expect(chirpsPerMinute(12)).toBe(54);
    expect(chirpsPerMinute(20)).toBe(110);
    expect(chirpsPerMinute(28)).toBe(166);
  });

  it("pulses 22 a second at 12 °C to 45 at 28 °C", () => {
    expect(pulseRate(12)).toBeCloseTo(22);
    expect(pulseRate(28)).toBeCloseTo(45);
    expect(pulseRate(20)).toBeCloseTo(33.5);
  });

  it("spaces chirps by 60 / (chirps a minute × the individual's factor)", () => {
    expect(chirpPeriod(20, 1)).toBeCloseTo(60 / 110);
    expect(chirpPeriod(28, 1.1)).toBeCloseTo(60 / (166 * 1.1));
  });

  it("sets a cricket's level and softening by its distance", () => {
    expect(cricketDb(0.2)).toBe(-4);
    expect(cricketDb(1)).toBe(-22);
    expect(airCutoff(0.2)).toBeCloseTo(9000);
    expect(airCutoff(1)).toBeCloseTo(4500);
    expect(onePoleGain(4500, 4500)).toBeCloseTo(Math.SQRT1_2);
  });

  it("pushes every individual further away with the Distance param", () => {
    expect(effectiveDistance(0.2, 0)).toBe(0.2);
    expect(effectiveDistance(0.2, 100)).toBeCloseTo(0.84);
    expect(effectiveDistance(1, 100)).toBe(1);
    expect(effectiveDistance(0.3, 40)).toBeLessThan(effectiveDistance(0.3, 100));
  });

  it("raises the chorus and the reverb send with distance", () => {
    expect(chorusDb(0)).toBe(-45);
    expect(chorusDb(100)).toBe(-32);
    expect(sendDb(0)).toBe(-24);
    expect(sendDb(100)).toBe(-18);
  });

  it("has a slot for every cricket the Crickets param allows", () => {
    expect(CRICKET_SLOTS).toBe(MAX_CRICKETS);
  });

  it("reads processor options, falling back to safe defaults", () => {
    expect(readInsectsOptions({ seed: 4.7, warmth: 25, offset: 2 })).toEqual({
      seed: 4,
      warmth: 25,
      offset: 2,
    });
    expect(readInsectsOptions(undefined)).toEqual({ seed: 0, warmth: 20, offset: 0 });
  });
});

describe("individuals", () => {
  const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

  it.each(SEEDS)("give seed %d's crickets traits in range", (seed) => {
    for (let i = 0; i < CRICKET_SLOTS; i++) {
      const t = cricketTraits(seed, i);
      expect(t.frequency).toBeGreaterThanOrEqual(3800);
      expect(t.frequency).toBeLessThan(5200);
      expect(t.factor).toBeGreaterThanOrEqual(0.9);
      expect(t.factor).toBeLessThan(1.1);
      expect([3, 4, 5]).toContain(t.pulses);
      expect(t.pulseLength).toBeGreaterThanOrEqual(0.008);
      expect(t.pulseLength).toBeLessThan(0.015);
      expect(t.distance).toBeGreaterThanOrEqual(0.2);
      expect(t.distance).toBeLessThan(1);
      expect(Math.abs(t.pan)).toBeLessThan(t.distance < 0.5 ? 0.5 : 0.8);
    }
  });

  it.each(SEEDS)("keep seed %d's first cricket close and never far to one side", (seed) => {
    const first = cricketTraits(seed, 0);
    expect(first.distance).toBeLessThan(0.35);
    expect(Math.abs(first.pan)).toBeLessThan(0.3);
  });

  it("depend on the seed and index only", () => {
    expect(cricketTraits(3, 4)).toEqual(cricketTraits(3, 4));
    expect(cricketTraits(3, 4)).not.toEqual(cricketTraits(4, 4));
    expect(cricketTraits(3, 4)).not.toEqual(cricketTraits(3, 5));
  });

  it.each(SEEDS)("give seed %d 1–3 katydids with traits in range", (seed) => {
    const count = katydidCount(seed);
    expect([1, 2, 3]).toContain(count);
    for (let i = 0; i < count; i++) {
      const t = katydidTraits(seed, i);
      expect(t.centre).toBeGreaterThanOrEqual(3000);
      expect(t.centre).toBeLessThan(5500);
      expect([2, 3, 4]).toContain(t.pulses);
      expect(t.pulseLength).toBeGreaterThanOrEqual(0.02);
      expect(t.pulseLength).toBeLessThan(0.04);
      // Each rasp comes 1.5–4 s after the last.
      const shortest = t.period * (1 - 2 * 0.2);
      const longest = t.period * (1 + 2 * 0.2);
      expect(shortest).toBeGreaterThanOrEqual(1.2);
      expect(longest).toBeLessThanOrEqual(4.5);
    }
  });
});

describe("chirp timing", () => {
  it("is the same for the same seed and differs for another", () => {
    const times = (seed: number) => {
      const events = createPeriodicEvents(64);
      new Cricket(seed, 0, 20).chirpsIn(100, 120, events);
      return Array.from(events.times.subarray(0, events.count));
    };
    expect(times(1)).toEqual(times(1));
    expect(times(1)).not.toEqual(times(2));
  });

  it.each([12, 20, 28])("averages the period within 1 %% over 1 000 chirps at %d °C", (warmth) => {
    const cricket = new Cricket(1, 2, warmth);
    const period = chirpPeriod(warmth, cricket.traits.factor);
    const events = createPeriodicEvents(1001);
    expect(cricket.chirpsIn(50, 50 + period * 1002, events)).toBe(1001);
    const mean = (events.times[1000] - events.times[0]) / 1000;
    expect(Math.abs(mean / period - 1)).toBeLessThan(0.01);
    // And each chirp strays from its grid by at most the jitter.
    for (let k = 1; k < 1000; k++) {
      const gap = (events.times[k] ?? 0) - (events.times[k - 1] ?? 0);
      expect(gap).toBeGreaterThan(period * (1 - 2 * CHIRP_JITTER) - 1e-9);
      expect(gap).toBeLessThan(period * (1 + 2 * CHIRP_JITTER) + 1e-9);
    }
  });
});

describe("bouts", () => {
  const prefix = hashStep(hashStep(HASH_START, 1), 99);

  it("sing about three blocks in four", () => {
    let sung = 0;
    for (let b = 0; b < 4000; b++) {
      sung += boutGain(prefix, b * 8 + 4);
    }
    expect(sung / 4000).toBeGreaterThan(0.72);
    expect(sung / 4000).toBeLessThan(0.78);
  });

  it("fade smoothly across a block's edge, never jumping", () => {
    let last = boutGain(prefix, 0);
    for (let t = 0; t < 800; t += 0.01) {
      const g = boutGain(prefix, t);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(Math.abs(g - last)).toBeLessThan(0.011);
      last = g;
    }
  });
});

describe("InsectsGenerator", () => {
  it("gives the same output for the same seed, params and start, and another for another seed", () => {
    const a = render(generator({}), 0, SR * 3);
    const b = render(generator({}), 0, SR * 3);
    const c = render(generator({ seed: 2 }), 0, SR * 3);
    expect(maxDifference(a.left, b.left)).toBe(0);
    expect(maxDifference(a.left, c.left)).toBeGreaterThan(0.01);
  });

  it.each([
    { katydids: 0, name: "crickets and chorus" },
    { katydids: 1, name: "with katydids" },
  ])("is the same from an absolute start whenever it begins ($name)", ({ katydids }) => {
    const whole = render(generator({ katydids }), 0, SR * 20);
    const late = render(generator({ katydids }), SR * 10, SR * 20);
    // The chorus's filters settle within a few milliseconds.
    const settle = SR / 20;
    const tail = (x: Float32Array) => x.subarray(SR * 10);
    expect(maxDifference(tail(whole.left), late.left, settle)).toBeLessThan(1e-4);
    expect(maxDifference(tail(whole.right), late.right, settle)).toBeLessThan(1e-4);
  });

  it("leaves crickets 0–4 unchanged when the count goes from 5 to 7", () => {
    const five = render(generator({ count: 5 }), 0, SR * 10);
    const seven = render(generator({ count: 7 }), 0, SR * 10);
    const fifth = renderCricket(1, 5, 0, SR * 10);
    const sixth = renderCricket(1, 6, 0, SR * 10);
    let max = 0;
    for (let i = 0; i < five.left.length; i++) {
      const added = (fifth.left[i] ?? 0) + (sixth.left[i] ?? 0);
      max = Math.max(max, Math.abs((seven.left[i] ?? 0) - (five.left[i] ?? 0) - added));
    }
    expect(peak(fifth.left, sixth.left)).toBeGreaterThan(0.01);
    expect(max).toBeLessThan(1e-6);
  });

  it("fades crickets out over a second when the count drops", () => {
    const g = generator({ count: 5 });
    render(g, 0, SR);
    g.set(1, 20, 40, 0);
    render(g, SR, SR + SR / 2);
    expect(g.crickets[0]?.presence).toBe(1);
    expect(g.crickets[4]?.presence).toBeCloseTo(0.5, 1);
    render(g, SR + SR / 2, SR * 3);
    expect(g.crickets[4]?.presence).toBe(0);
  });

  it("lets a chirp already sounding keep its pace when the warmth changes", () => {
    const params = { warmth: 20, distance: 40 };
    const singer = (change: number | undefined) => {
      const cricket = new Cricket(1, 0, 20);
      const latched = { ...params };
      cricket.target = 1;
      cricket.restart(0, latched);
      return {
        cricket,
        render(l: Float32Array, r: Float32Array, start: number) {
          if (start === change) {
            latched.warmth = 28;
            cricket.setWarmth(28, start / SR);
          }
          l.fill(0);
          r.fill(0);
          cricket.render(l, r, l.length, start / SR, 1 / SR, latched);
        },
      };
    };
    const a = render(singer(undefined), 0, SR * 20);
    // Change in the render quantum after a chirp's second pulse begins, in a
    // chirp that sounds: it carries on as it began, until the next.
    const events = createPeriodicEvents(64);
    const { cricket } = singer(undefined);
    const pulse = 1 / (pulseRate(20) * cricket.traits.factor);
    const count = cricket.chirpsIn(1, 18, events);
    const change = Array.from(
      events.times.subarray(0, count),
      (t) => Math.ceil(((t + pulse) * SR) / QUANTUM) * QUANTUM,
    ).find((n) => peak(a.left.subarray(n, n + QUANTUM)) > 0.001);
    expect(change).toBeDefined();
    const changed = singer(change);
    const b = render(changed, 0, SR * 20);
    changed.cricket.chirpsIn((change ?? 0) / SR, 20, events);
    const next = Math.floor(events.times[0] * SR);
    expect(maxDifference(a.left.subarray(0, next), b.left.subarray(0, next))).toBe(0);
    expect(maxDifference(a.left, b.left)).toBeGreaterThan(0.001);
  });

  it("adds the katydids' rasps only when they are on", () => {
    const off = render(generator({}), 0, SR * 10);
    const on = render(generator({ katydids: 1 }), 0, SR * 10);
    expect(maxDifference(off.left, on.left)).toBeGreaterThan(0.001);
    // Fading out, then off: the same as never on.
    const g = generator({ katydids: 1 });
    g.set(5, 20, 40, 0);
    const faded = render(g, 0, SR * 10);
    expect(maxDifference(off.left, faded.left, QUANTUM)).toBe(0);
  });

  it.each([12, 20, 28])(
    "keeps the energy above 8 kHz 40 dB under the total at %d °C, close by",
    (warmth) => {
      for (const katydids of [0, 1]) {
        const { left, right } = render(
          generator({ warmth, distance: 0, count: 12, katydids }),
          0,
          SR * 10,
        );
        for (const channel of [comfort(left), comfort(right)]) {
          const total = rmsDb(channel);
          expect(bandEnergyDb(channel, SR, 8000, SR / 2) - total).toBeLessThan(-40);
        }
      }
    },
  );

  it.each([1, 2, 3])("stays finite and under −3 dBFS at its loudest (seed %d)", (seed) => {
    const { left, right } = render(
      generator({ seed, count: 12, warmth: 28, distance: 0, katydids: 1 }),
      0,
      SR * 20,
    );
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(peak(left, right)).toBeLessThan(10 ** (-3 / 20));
  });

  it.each([
    { name: "fewest, coolest, farthest", count: 1, warmth: 12, distance: 100 },
    { name: "most, warmest, closest", count: 12, warmth: 28, distance: 0 },
  ])("stays finite and audible: $name", (settings) => {
    const { left, right } = render(generator(settings), 0, SR * 10);
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(peak(left, right)).toBeGreaterThan(0.001);
    expect(peak(left, right)).toBeLessThan(10 ** (-3 / 20));
  });

  it("works at 44.1 kHz at about the same level", () => {
    const at48 = render(generator({}), 0, SR * 10);
    const at44 = render(generator({ sampleRate: 44100 }), 0, 44100 * 10);
    expect(allFinite(at44.left)).toBe(true);
    expect(Math.abs(rmsDb(at44.left) - rmsDb(at48.left))).toBeLessThan(1);
  });
});
