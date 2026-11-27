import { describe, expect, it } from "vitest";
import { gainToDb } from "../../audio/glide";
import { waveAt } from "../../audio/lfo";
import {
  droneCutoff,
  droneWave,
  EVEN_HARMONIC_DB,
  HARMONIC_LEVEL,
  harmonicLevel,
  HARMONICS,
  REFERENCE_PITCH,
  roomSendDb,
  THROB,
  throbDepth,
} from "./engine-core-dsp";

const POINTS = 4096;

/** The wave sampled over one cycle. */
function sampled(wave: Parameters<typeof waveAt>[0], offset = 0): number[] {
  return Array.from({ length: POINTS }, (_, i) => waveAt(wave, i / POINTS) + offset);
}

describe("droneWave", () => {
  const wave = droneWave();

  it("has harmonics 1–8 and nothing else", () => {
    expect(wave.real.length).toBe(HARMONICS + 1);
    expect(wave.imag.length).toBe(HARMONICS + 1);
    expect(wave.real[0]).toBe(0);
    expect(wave.imag[0]).toBe(0);
    for (let k = 1; k <= HARMONICS; k++) {
      expect(harmonicLevel(wave, k)).toBeGreaterThan(0);
    }
  });

  it.each([1, 3, 5, 7])("falls 6 dB per octave over the odd harmonics (harmonic %s)", (k) => {
    expect(harmonicLevel(wave, k)).toBeCloseTo(HARMONIC_LEVEL / k, 12);
  });

  it.each([2, 4, 6, 8])("keeps even harmonic %s 3 dB under the odd slope", (k) => {
    const db = gainToDb(harmonicLevel(wave, k) / (HARMONIC_LEVEL / k));
    expect(db).toBeCloseTo(EVEN_HARMONIC_DB, 9);
  });

  it("falls about 6 dB per octave from harmonic 1 to 2, 2 to 4 and 4 to 8", () => {
    for (const k of [1, 2, 4]) {
      const fall = gainToDb(harmonicLevel(wave, 2 * k) / harmonicLevel(wave, k));
      expect(fall).toBeCloseTo(-6.02 + (k === 1 ? EVEN_HARMONIC_DB : 0), 1);
    }
  });

  it("has a lower crest factor than the same harmonics in sawtooth phase", () => {
    const crest = (values: number[]) => {
      const peak = Math.max(...values.map((v) => Math.abs(v)));
      const rms = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
      return peak / rms;
    };
    const levels = wave.real.map((_, k) => (k === 0 ? 0 : harmonicLevel(wave, k)));
    const sawtooth = { real: levels.map(() => 0), imag: levels };
    expect(crest(sampled(wave))).toBeLessThan(0.85 * crest(sampled(sawtooth)));
  });
});

describe("throb pulse", () => {
  const values = sampled(THROB, THROB.offset);
  const peakAt = values.indexOf(Math.max(...values)) / POINTS;
  const troughAt = values.indexOf(Math.min(...values)) / POINTS;

  it("uses the first 6 Fourier terms", () => {
    expect(Math.max(THROB.real.length, THROB.imag.length)).toBe(7);
  });

  it("spans 0..1 once offset, without overshoot beyond ±2 %", () => {
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-0.02);
    expect(Math.max(...values)).toBeLessThanOrEqual(1.02);
    expect(Math.max(...values) - Math.min(...values)).toBeCloseTo(1, 4);
  });

  it("rises over about 35 % of the cycle and falls over the rest", () => {
    const rise = (peakAt - troughAt + 1) % 1;
    expect(Math.abs(rise - 0.35)).toBeLessThan(0.05);
  });

  it("averages near the middle of its range", () => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.3);
    expect(mean).toBeLessThan(0.7);
  });
});

describe("droneCutoff", () => {
  it.each([
    [0, 180],
    [50, 180 * Math.sqrt(5)],
    [100, 900],
  ])("is %s Hz at power %s at the reference pitch", (power, hz) => {
    expect(droneCutoff(power, REFERENCE_PITCH)).toBeCloseTo(hz, 9);
  });

  it("scales with the pitch", () => {
    expect(droneCutoff(55, 72)).toBeCloseTo(droneCutoff(55, REFERENCE_PITCH) * 1.5, 9);
  });

  it("keeps harmonic 6 within an octave of the cutoff at every setting", () => {
    for (const pitch of [32, 48, 72]) {
      expect(droneCutoff(0, pitch)).toBeGreaterThan((6 * pitch) / 2);
    }
  });
});

describe("param mappings", () => {
  it.each([
    [0, -40],
    [40, -28.8],
    [100, -12],
  ])("sends room %s to the reverb at %s dB", (room, db) => {
    expect(roomSendDb(room)).toBeCloseTo(db, 9);
  });

  it.each([
    [-5, 0],
    [0, 0],
    [45, 0.45],
    [100, 1],
    [120, 1],
  ])("turns pulse depth %s into %s", (depth, fraction) => {
    expect(throbDepth(depth)).toBeCloseTo(fraction, 12);
  });
});
