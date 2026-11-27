import { describe, expect, it } from "vitest";
import {
  addWaveEnvelopes,
  BED_CUTOFF,
  SWELL_CUTOFF,
  CHURN_CHANNEL,
  BACKWASH,
  BED_CHANNEL,
  CRASH,
  CUTOFF_CHANNEL,
  crashCutoff,
  FOAM_LEFT,
  WATER_CHANNEL,
  FOAM_RIGHT,
  foamCutoff,
  OCEAN_CHANNELS,
  OceanGenerator,
  ONSET_JITTER,
  outputDb,
  Rattle,
  readOceanOptions,
  sendDb,
  SWELL,
  WAVE_LIFE,
  WaveField,
  WaveSchedule,
} from "./ocean-dsp";
import type { OceanShore } from "./ocean.meta";

const SR = 48000;
const QUANTUM = 128;

/** Onsets of waves `from` to `to` (inclusive). */
const onsets = (schedule: WaveSchedule, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => schedule.onset(from + i));

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - (times[i] ?? 0));

describe("wave timing", () => {
  it("gives the same onsets for the same seed, and others for another", () => {
    expect(onsets(new WaveSchedule(4, 10), -5, 50)).toEqual(
      onsets(new WaveSchedule(4, 10), -5, 50),
    );
    expect(onsets(new WaveSchedule(5, 10), 0, 50)).not.toEqual(
      onsets(new WaveSchedule(4, 10), 0, 50),
    );
  });

  it.each([6, 10, 14])("keeps every gap within 0.6–1.4 periods at period %d", (period) => {
    for (const gap of gaps(onsets(new WaveSchedule(1, period), -10, 1000))) {
      expect(gap).toBeGreaterThanOrEqual((1 - 2 * ONSET_JITTER) * period);
      expect(gap).toBeLessThanOrEqual((1 + 2 * ONSET_JITTER) * period);
    }
  });

  it.each([6, 10, 14])("averages a gap within 3 %% of period %d over 1 000 waves", (period) => {
    const g = gaps(onsets(new WaveSchedule(2, period), 0, 1000));
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    expect(Math.abs(mean - period) / period).toBeLessThan(0.03);
  });

  it("finds the latest wave to have started at any time", () => {
    const schedule = new WaveSchedule(3, 8);
    for (let t = -20; t < 400; t += 0.37) {
      const n = schedule.latest(t);
      expect(schedule.onset(n)).toBeLessThanOrEqual(t);
      expect(schedule.onset(n + 1)).toBeGreaterThan(t);
    }
  });

  it("changes the period from the next wave on, keeping every onset up to it", () => {
    const schedule = new WaveSchedule(1, 10);
    const t = 123.4;
    const next = schedule.latest(t) + 1;
    const before = onsets(schedule, next - 6, next);
    expect(schedule.setPeriod(6, t)).toBe(true);
    expect(onsets(schedule, next - 6, next)).toEqual(before);
    for (const gap of gaps(onsets(schedule, next, next + 200))) {
      expect(gap).toBeGreaterThanOrEqual(0.6 * 6);
      expect(gap).toBeLessThanOrEqual(1.4 * 6);
    }
    expect(schedule.setPeriod(6, t + 1)).toBe(false);
  });

  it("keeps earlier waves' onsets through several changes in a row", () => {
    const schedule = new WaveSchedule(9, 14);
    const before = onsets(schedule, 0, 10);
    const changes: [number, number][] = [
      [200, 6],
      [200.5, 12],
      [215, 7],
      [240, 14],
      [260, 6],
      [262, 9],
      [290, 6],
    ];
    for (const [t, period] of changes) {
      const next = schedule.latest(t) + 1;
      const kept = onsets(schedule, next - 5, next);
      schedule.setPeriod(period, t);
      expect(onsets(schedule, next - 5, next)).toEqual(kept);
    }
    // Waves before the first change keep theirs too, and every wave since is in order.
    expect(onsets(schedule, 0, 10)).toEqual(before);
    const since = schedule.latest(200);
    for (const gap of gaps(onsets(schedule, since, since + 40))) {
      expect(gap).toBeGreaterThanOrEqual(0.6 * 6);
    }
  });
});

describe("envelopes", () => {
  const wave = { size: 1, swell: 3, hold: 0.5, foamDecay: 2, backwash: 4, pan: 0.3 };
  const at = (age: number) => {
    const out = new Float64Array(6);
    addWaveEnvelopes(wave, age, out);
    return out;
  };

  it("swells, breaks, foams and drains in that order", () => {
    const peakTime = (index: number) => {
      let best = 0;
      let when = 0;
      for (let age = 0; age < WAVE_LIFE; age += 0.01) {
        const v = at(age)[index];
        if (v > best) {
          best = v;
          when = age;
        }
      }
      return when;
    };
    expect(peakTime(SWELL)).toBeCloseTo(3, 1);
    expect(peakTime(CRASH)).toBeGreaterThan(3);
    expect(peakTime(CRASH)).toBeLessThan(3.7);
    expect(peakTime(FOAM_RIGHT)).toBeCloseTo(3.2, 1);
    expect(peakTime(BACKWASH)).toBeGreaterThan(4);
    expect(at(1)[CRASH]).toBe(0);
  });

  it("starts and ends silent", () => {
    expect([...at(-1)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect([...at(0)].every((v) => v === 0)).toBe(true);
    expect([...at(WAVE_LIFE)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Math.max(...at(WAVE_LIFE - 0.01))).toBeLessThan(1e-3);
  });

  it("turns the foam's far side down by its pan", () => {
    const frame = at(3.5);
    expect(frame[FOAM_RIGHT]).toBeGreaterThan(0);
    expect(frame[FOAM_LEFT]).toBeCloseTo(frame[FOAM_RIGHT] * 0.7);
  });

  it.each([6, 10, 14].flatMap((period) => [1, 2, 3].map((seed) => [period, seed])))(
    "stay within 0..1 with no NaN at period %d, seed %d",
    (period, seed) => {
      const field = new WaveField(seed, period, SR);
      const frame = new Float64Array(6);
      let quietest = Number.POSITIVE_INFINITY;
      let loudest = 0;
      let finite = true;
      for (let t = 0; t < 600; t += 0.05) {
        field.at(t, frame);
        for (let i = 0; i <= BACKWASH; i++) {
          // Math.min/max carry a NaN through, so it fails the bounds below.
          const v = frame[i] ?? Number.NaN;
          quietest = Math.min(quietest, v);
          loudest = Math.max(loudest, v);
        }
        finite &&= Number.isFinite(frame[5]);
      }
      expect(quietest).toBeGreaterThanOrEqual(0);
      expect(loudest).toBeLessThanOrEqual(1);
      expect(finite).toBe(true);
      expect(loudest).toBeGreaterThan(0.6);
    },
  );
});

/** Renders `g` from absolute sample `from` to `to`, one render quantum at a time, as a worklet would. */
function render(g: OceanGenerator, from: number, to: number) {
  const channels = Array.from({ length: OCEAN_CHANNELS }, () => new Float32Array(to - from));
  const buffers = Array.from({ length: OCEAN_CHANNELS }, () => new Float32Array(QUANTUM));
  for (let n = from; n < to; n += QUANTUM) {
    g.render(buffers, n);
    buffers.forEach((buffer, c) => {
      channels[c]?.set(buffer.subarray(0, Math.min(QUANTUM, to - n)), n - from);
    });
  }
  return channels;
}

/** The audio channels: the bed's and the water's stereo pairs. */
const AUDIO = [BED_CHANNEL, WATER_CHANNEL].flatMap((c) => [c, c + 1]);
const CONTROLS = [CUTOFF_CHANNEL, CHURN_CHANNEL];
const none = new Float32Array(0);

const peak = (c: Float32Array) => c.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
const maxDifference = (a: Float32Array, b: Float32Array) =>
  a.reduce((m, v, i) => Math.max(m, Math.abs(v - (b[i] ?? 0))), 0);

describe("generator", () => {
  it.each<[OceanShore, number]>([
    ["sand", 6],
    ["sand", 14],
    ["pebbles", 6],
    ["pebbles", 14],
  ])("stays finite and bounded on %s at period %d", (shore, period) => {
    const channels = render(new OceanGenerator(1, shore, period, SR), 0, 16 * SR);
    for (const channel of channels) {
      expect(channel.every((v) => Number.isFinite(v))).toBe(true);
    }
    for (const c of AUDIO) {
      expect(peak(channels[c] ?? none)).toBeLessThan(1.5);
      expect(peak(channels[c] ?? none)).toBeGreaterThan(0.05);
    }
    // The bed's cutoff stays between its rest and fully open.
    const cutoff = channels[CUTOFF_CHANNEL] ?? none;
    expect(cutoff.reduce((m, v) => Math.min(m, v), Infinity)).toBeGreaterThanOrEqual(BED_CUTOFF);
    expect(peak(cutoff)).toBeLessThanOrEqual(BED_CUTOFF + SWELL_CUTOFF + crashCutoff(50, 0) + 1e-3);
  });

  it("is deterministic per seed", () => {
    const a = render(new OceanGenerator(7, "pebbles", 10, SR), SR, 3 * SR);
    const b = render(new OceanGenerator(7, "pebbles", 10, SR), SR, 3 * SR);
    const c = render(new OceanGenerator(8, "pebbles", 10, SR), SR, 3 * SR);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("adds the rattle to the water on pebbles only", () => {
    const sand = render(new OceanGenerator(1, "sand", 10, SR), 0, 20 * SR);
    const pebbles = render(new OceanGenerator(1, "pebbles", 10, SR), 0, 20 * SR);
    expect(pebbles[BED_CHANNEL]).toEqual(sand[BED_CHANNEL]);
    expect(pebbles[WATER_CHANNEL]).not.toEqual(sand[WATER_CHANNEL]);
  });

  it("renders from any time as if it had run from the start, inside a wave", () => {
    const g = new OceanGenerator(3, "pebbles", 10, SR);
    // A seam 1.37 s after a wave's break, while its foam and crash are sounding.
    const wave = g.field.schedule.latest(60);
    const seam = Math.round((g.field.schedule.onset(wave) + 4 + 1.37) * SR);
    const whole = render(new OceanGenerator(3, "pebbles", 10, SR), seam - 2 * SR, seam + SR);
    const late = render(new OceanGenerator(3, "pebbles", 10, SR), seam, seam + SR);
    // Controls and the rattle are exact; the noises' filters settle within 0.2 s.
    const settle = Math.round(0.2 * SR);
    const tail = (c: number) => (whole[c] ?? none).subarray(2 * SR);
    for (const c of CONTROLS) {
      expect(maxDifference(tail(c), late[c] ?? none)).toBe(0);
    }
    for (const c of AUDIO) {
      const difference = maxDifference(
        tail(c).subarray(settle),
        (late[c] ?? none).subarray(settle),
      );
      expect(difference).toBeLessThan(1e-3);
    }
    expect(peak(late[CUTOFF_CHANNEL] ?? none)).toBeGreaterThan(BED_CUTOFF + 100);
  });

  it("keeps a wave that is sounding as it is through a period change", () => {
    const steady = new OceanGenerator(5, "sand", 10, SR);
    const changed = new OceanGenerator(5, "sand", 10, SR);
    const t = Math.round(steady.field.schedule.onset(6) + 4) * SR;
    render(steady, 0, t);
    render(changed, 0, t);
    changed.setPeriod(6, t);
    const a = render(steady, t, t + 2 * SR);
    const b = render(changed, t, t + 2 * SR);
    expect(b[CUTOFF_CHANNEL]).toEqual(a[CUTOFF_CHANNEL]);
  });
});

describe("rattle", () => {
  it("is a function of the sample, whatever it rendered before", () => {
    const a = new Rattle(1, SR);
    const b = new Rattle(1, SR);
    const left = new Float64Array(2000);
    for (let n = 0; n < 2000; n++) {
      a.next(10_000 + n, 1);
      left[n] = a.left;
    }
    for (let n = 1500; n < 2000; n++) {
      b.next(10_000 + n, 1);
      expect(b.left).toBe(left[n]);
    }
  });

  it("sounds more bursts at the height of the backwash, and stays under full scale", () => {
    const count = (backwash: number) => {
      const r = new Rattle(2, SR);
      let samples = 0;
      let loudest = 0;
      for (let n = 0; n < SR; n++) {
        r.next(n, backwash);
        loudest = Math.max(loudest, Math.abs(r.left));
        if (r.left !== 0) {
          samples++;
        }
      }
      expect(loudest).toBeLessThan(1);
      return samples;
    };
    const edge = count(0);
    const height = count(1);
    expect(edge).toBeGreaterThan(0);
    expect(height / edge).toBeGreaterThan(2);
    expect(height / edge).toBeLessThan(3.5);
  });
});

describe("param mappings", () => {
  it("opens the crash 1.5–3.5 kHz by size close up, and to 600 Hz far away", () => {
    expect(crashCutoff(0, 0)).toBeCloseTo(1500);
    expect(crashCutoff(100, 0)).toBeCloseTo(3500);
    expect(crashCutoff(100, 100)).toBeCloseTo(600);
  });

  it("dulls the foam and raises the send with distance", () => {
    expect(foamCutoff(0)).toBeCloseTo(6500);
    expect(foamCutoff(100)).toBeCloseTo(3000);
    expect(sendDb(0)).toBe(-34);
    expect(sendDb(100)).toBe(-20);
  });

  it("lowers the biggest waves' level, and raises the far sound's", () => {
    expect(outputDb(50, 0)).toBe(0);
    expect(outputDb(100, 0)).toBe(-2.5);
    expect(outputDb(0, 100)).toBe(1.5);
  });

  it("reads options, falling back to safe defaults", () => {
    expect(readOceanOptions({ seed: 4.7, shore: "pebbles", period: 7, offset: 2 })).toEqual({
      seed: 4,
      shore: "pebbles",
      period: 7,
      offset: 2,
    });
    expect(readOceanOptions({ shore: "rocks", period: -1 })).toEqual({
      seed: 0,
      shore: "sand",
      period: 10,
      offset: 0,
    });
    expect(readOceanOptions(undefined).shore).toBe("sand");
  });
});
