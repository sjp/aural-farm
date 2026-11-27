import { describe, expect, it } from "vitest";
import {
  bandEnergyDb,
  clickScore,
  dcOffset,
  interChannelCorrelation,
  kWeightedLoudness,
  maxDifferenceAfter,
  monoLossDb,
  peakDb,
  rmsDb,
  spectralSlope,
  windowedLoudness,
} from "./analysis";
import { filterSamples } from "./biquad";
import { createRng } from "./random";

const RATE = 48000;

/** A sine at `frequency` whose RMS is `levelDb` dBFS. */
function sine(frequency: number, levelDb: number, seconds = 2): Float32Array {
  const amplitude = Math.SQRT2 * 10 ** (levelDb / 20);
  return Float32Array.from(
    { length: seconds * RATE },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE),
  );
}

describe("kWeightedLoudness", () => {
  it("reads a 997 Hz sine at −20 dBFS RMS as about −20 LUFS", () => {
    expect(kWeightedLoudness([sine(997, -20)], RATE, 0.5)).toBeCloseTo(-20, 1);
  });

  it("sums the channels' power", () => {
    const tone = sine(997, -20);
    expect(kWeightedLoudness([tone, tone], RATE, 0.5)).toBeCloseTo(-20 + 10 * Math.log10(2), 1);
  });

  it("weights low frequencies down and high ones up", () => {
    expect(kWeightedLoudness([sine(30, -20)], RATE, 1)).toBeLessThan(-25);
    expect(kWeightedLoudness([sine(4000, -20)], RATE, 0.5)).toBeGreaterThan(-17);
  });

  it("only measures 48 kHz audio", () => {
    expect(() => kWeightedLoudness([sine(997, -20)], 44100)).toThrow("48000");
  });
});

/** Seeded white noise, uniform in ±`amplitude`. */
function noise(seed: number, seconds = 2, amplitude = 0.5): Float32Array {
  const rng = createRng(seed);
  return Float32Array.from({ length: seconds * RATE }, () => amplitude * (rng.next() * 2 - 1));
}

describe("windowedLoudness", () => {
  it("reads a steady sine the same in every window", () => {
    const levels = windowedLoudness([sine(997, -20, 4)], RATE, 1, 0.5, 0.5);
    expect(levels).toHaveLength(6);
    for (const level of levels) {
      expect(level).toBeCloseTo(-20, 1);
    }
  });

  it("follows a step in level", () => {
    const quiet = sine(997, -30, 2);
    const loud = sine(997, -20, 2);
    const step = new Float32Array(quiet.length + loud.length);
    step.set(quiet);
    step.set(loud, quiet.length);
    const levels = windowedLoudness([step], RATE, 0.5, 0.5, 0.5);
    expect(levels[0]).toBeCloseTo(-30, 0);
    expect(levels.at(-1)).toBeCloseTo(-20, 0);
  });
});

describe("peakDb and rmsDb", () => {
  it("read a sine at a known level", () => {
    const tone = sine(440, -12);
    expect(rmsDb(tone)).toBeCloseTo(-12, 2);
    expect(peakDb(tone)).toBeCloseTo(-9, 1);
  });

  it("read silence as −Infinity", () => {
    expect(peakDb(new Float32Array(10))).toBe(-Infinity);
    expect(rmsDb(new Float32Array(10))).toBe(-Infinity);
  });
});

describe("dcOffset", () => {
  it("is the mean, so a sine has none", () => {
    expect(Math.abs(dcOffset(sine(100, -6)))).toBeLessThan(1e-6);
    expect(dcOffset(sine(100, -6).map((v) => v + 0.01))).toBeCloseTo(0.01, 6);
  });
});

describe("bandEnergyDb", () => {
  it("finds a sine's power in its band and not elsewhere", () => {
    const tone = sine(1000, -20);
    expect(bandEnergyDb(tone, RATE, 900, 1100)).toBeCloseTo(-20, 1);
    expect(bandEnergyDb(tone, RATE, 0, 500)).toBeLessThan(-80);
    expect(bandEnergyDb(tone, RATE, 2000, 24000)).toBeLessThan(-80);
  });

  it("adds up to the RMS level over the whole band", () => {
    const white = noise(1);
    expect(bandEnergyDb(white, RATE, 0, RATE)).toBeCloseTo(rmsDb(white), 1);
  });

  it("splits white noise by bandwidth", () => {
    const white = noise(2);
    const half = bandEnergyDb(white, RATE, 0, 12000);
    expect(half).toBeCloseTo(rmsDb(white) - 3, 0);
  });

  it("handles signals shorter than one segment", () => {
    expect(bandEnergyDb(sine(1000, -20, 0.1), RATE, 800, 1200)).toBeCloseTo(-20, 0);
  });
});

describe("spectralSlope", () => {
  it("reads white noise as flat", () => {
    expect(Math.abs(spectralSlope(noise(3, 4), RATE, 100, 10000))).toBeLessThan(0.3);
  });

  it("reads a one-pole lowpass as about −6 dB per octave above its corner", () => {
    // A first-order lowpass at 100 Hz, as a biquad with b2 = a2 = 0.
    const pole = Math.exp((-2 * Math.PI * 100) / RATE);
    const lowpass = { b0: 1 - pole, b1: 0, b2: 0, a1: -pole, a2: 0 };
    const red = filterSamples(lowpass, noise(4, 4));
    expect(spectralSlope(red, RATE, 1000, 8000)).toBeCloseTo(-6, 0);
  });
});

describe("interChannelCorrelation and monoLossDb", () => {
  const l = noise(5);
  const r = noise(6);

  it("read identical channels as mono", () => {
    expect(interChannelCorrelation(l, l)).toBeCloseTo(1, 6);
    expect(monoLossDb(l, l)).toBeCloseTo(0, 6);
  });

  it("read unrelated channels as uncorrelated, losing 3 dB in mono", () => {
    expect(Math.abs(interChannelCorrelation(l, r))).toBeLessThan(0.02);
    expect(monoLossDb(l, r)).toBeCloseTo(3, 1);
  });

  it("read inverted channels as cancelling", () => {
    expect(
      interChannelCorrelation(
        l,
        l.map((v) => -v),
      ),
    ).toBeCloseTo(-1, 6);
    expect(
      monoLossDb(
        l,
        l.map((v) => -v),
      ),
    ).toBe(Infinity);
  });
});

describe("clickScore", () => {
  /** Dark background noise (12 dB per octave above 500 Hz), quiet above 6 kHz but not silent. */
  const background = () => {
    const pole = Math.exp((-2 * Math.PI * 500) / RATE);
    const lowpass = { b0: 1 - pole, b1: 0, b2: 0, a1: -pole, a2: 0 };
    return filterSamples(lowpass, filterSamples(lowpass, noise(7, 3, 0.3)));
  };

  it("scores clean audio near 0", () => {
    expect(clickScore(background(), RATE, 1.5)).toBeLessThan(3);
  });

  it("scores an injected one-sample click high", () => {
    const signal = background();
    signal[Math.round(1.5 * RATE)] = 0.5;
    expect(clickScore(signal, RATE, 1.5)).toBeGreaterThan(20);
    expect(clickScore(signal, RATE, 0.7)).toBeLessThan(3);
  });

  it("doesn't score a smooth change in brightness", () => {
    // Background, then from 1.5 s on, a gradual crossfade to white noise over 0.5 s.
    const dark = background();
    const bright = noise(8, 3, 0.3);
    const mixed = dark.map((v, i) => {
      const t = Math.min(1, Math.max(0, (i / RATE - 1.5) / 0.5));
      return Math.cos((t * Math.PI) / 2) * v + Math.sin((t * Math.PI) / 2) * (bright[i] ?? 0);
    });
    expect(clickScore(mixed, RATE, 1.5)).toBeLessThan(3);
  });

  it("scores a step in a low sine", () => {
    // A 50 Hz sine whose level jumps from nothing to −10 dBFS in one sample.
    const tone = sine(50, -10, 2).map((v, i) => (i < RATE ? 0 : v));
    expect(clickScore(tone, RATE, 1)).toBeGreaterThan(20);
  });
});

describe("maxDifferenceAfter", () => {
  const a = [noise(9), noise(10)];

  it("reads identical renders as −Infinity", () => {
    expect(
      maxDifferenceAfter(
        a,
        a.map((c) => c.slice()),
        RATE,
        0.5,
      ),
    ).toBe(-Infinity);
  });

  it("reads a tiny difference far below the signal", () => {
    const b = a.map((c) => c.map((v) => v * 1.001));
    expect(maxDifferenceAfter(a, b, RATE, 0.5)).toBeCloseTo(-60, 0);
  });

  it("reads a shifted signal as about as loud as the signal", () => {
    const shifted = a.map((c) => {
      const out = new Float32Array(c.length);
      out.set(c.subarray(0, c.length - 1), 1);
      return out;
    });
    expect(maxDifferenceAfter(a, shifted, RATE, 0.5)).toBeCloseTo(3, 0);
  });

  it("ignores a difference within the settle time and reports the worst channel", () => {
    const b = a.map((c) => c.slice());
    const left = b[0] ?? new Float32Array(0);
    left.fill(0, 0, RATE / 4);
    expect(maxDifferenceAfter(a, b, RATE, 0.5)).toBe(-Infinity);
    const right = b[1] ?? new Float32Array(0);
    right[RATE] += 1;
    expect(maxDifferenceAfter(a, b, RATE, 0.5)).toBeGreaterThan(-60);
  });
});
