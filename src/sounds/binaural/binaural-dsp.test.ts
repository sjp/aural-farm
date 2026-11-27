import { describe, expect, it } from "vitest";
import { waveAt } from "../../audio/lfo";
import {
  bedGain,
  beatOf,
  isochronicLevel,
  PULSE_FLOOR_DB,
  pulseGain,
  TONE_LEVEL,
  toneFrequencies,
  wholePeriod,
} from "./binaural-dsp";

describe("beatOf", () => {
  it.each([
    ["delta", 2],
    ["theta", 6],
    ["alpha", 10],
    ["beta", 18],
  ] as const)("gives %s its beat, whatever the custom beat", (preset, beat) => {
    expect(beatOf(preset, 23.4)).toBe(beat);
  });

  it("uses the custom beat for Custom", () => {
    expect(beatOf("custom", 23.4)).toBe(23.4);
  });
});

describe("toneFrequencies", () => {
  it.each([
    [200, 10],
    [100, 30],
    [400, 1],
    [137, 7.3],
  ])("centres the tones on %d Hz, exactly %d Hz apart", (carrier, beat) => {
    const { left, right } = toneFrequencies(carrier, beat);
    expect(right - left).toBeCloseTo(beat, 10);
    expect((left + right) / 2).toBeCloseTo(carrier, 10);
    expect(left).toBeGreaterThan(0);
  });
});

describe("pulseGain", () => {
  const POINTS = 4096;
  const { wave, base } = pulseGain();
  const gains = Array.from({ length: POINTS }, (_, m) => base + waveAt(wave, m / POINTS));
  const floor = 10 ** (PULSE_FLOOR_DB / 20);

  it("swings from −14 dB to 0 dB, overshooting neither by more than 2 %", () => {
    expect(Math.min(...gains)).toBeGreaterThan(floor * 0.98);
    expect(Math.min(...gains)).toBeLessThan(floor * 1.02);
    expect(Math.max(...gains)).toBeLessThan(1.02);
    expect(Math.max(...gains)).toBeGreaterThan(0.98);
  });

  it("stays near its peak for a good part of the cycle, a pulse rather than a sine", () => {
    const high = gains.filter((g) => g > 0.9).length / POINTS;
    expect(high).toBeGreaterThan(0.25);
  });

  it("moves smoothly: under 0.4 % of its range a sample at 30 Hz, 44.1 kHz", () => {
    // 30 Hz at 44.1 kHz is 1470 samples a cycle.
    const samples = 1470;
    let largest = 0;
    let previous = base + waveAt(wave, 0);
    for (let m = 1; m <= samples; m++) {
      const g = base + waveAt(wave, m / samples);
      largest = Math.max(largest, Math.abs(g - previous));
      previous = g;
    }
    expect(largest).toBeLessThan(0.004);
  });

  it("has four Fourier terms and no DC", () => {
    expect(wave.real).toHaveLength(5);
    expect(wave.real[0]).toBe(0);
    expect(wave.imag[0]).toBe(0);
  });
});

describe("levels", () => {
  it("raises the isochronic tone by the pulse's RMS gain, no more than 6 dB", () => {
    const level = isochronicLevel();
    expect(level).toBeGreaterThan(TONE_LEVEL);
    expect(level).toBeLessThan(TONE_LEVEL * 2);
  });

  it("turns the bed off at 0 and puts it 8 dB under the tones at 100", () => {
    expect(bedGain(0)).toBe(0);
    expect(bedGain(-5)).toBe(0);
    // Pink noise is −12 dBFS RMS; each tone's RMS is its level over √2.
    const bedRms = bedGain(100) * 10 ** (-12 / 20);
    const toneRms = TONE_LEVEL / Math.SQRT2;
    expect(20 * Math.log10(bedRms / toneRms)).toBeCloseTo(-8 + 20 * Math.log10(1.25), 6);
    expect(bedGain(150)).toBe(bedGain(100));
  });

  it("rises steadily with Noise bed", () => {
    for (let bed = 1; bed <= 100; bed++) {
      expect(bedGain(bed)).toBeGreaterThan(bedGain(bed - 1));
    }
  });
});

describe("wholePeriod", () => {
  it.each([
    [[195, 205], 0.2],
    [[200, 10], 0.1],
    [[197, 203], 1],
    [[196.35, 203.65], 20],
    [[100, 2], 0.5],
  ])("brings %j back in phase every %d s", (frequencies, period) => {
    expect(wholePeriod(frequencies)).toBeCloseTo(period, 12);
    for (const f of frequencies) {
      const cycles = f * wholePeriod(frequencies);
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-9);
    }
  });

  it("copes with values just off the grid", () => {
    expect(wholePeriod([195.00000001, 204.99999999])).toBeCloseTo(0.2, 12);
  });
});
