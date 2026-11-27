import { describe, expect, it } from "vitest";
import { kWeightedLoudness } from "./analysis";
import { biquadCoefficients, filterSamples, responseDb } from "./biquad";
import { dbToGain } from "./glide";
import { NoiseGenerator } from "./noise-dsp";
import {
  GREY_EQ,
  LEVEL_DB,
  SHAPING,
  TILT_PIVOT,
  tiltDb,
  tiltGains,
  widthGains,
  type NoiseSoundColour,
} from "./noise-sound";

const RATE = 48000;
const COLOURS = ["white", "pink", "brown", "grey"] as const;
const DEFAULT_TONE: Readonly<Record<NoiseSoundColour, number>> = {
  white: 0,
  pink: 0,
  brown: -10,
  grey: 0,
};

/**
 * Renders `seconds` of a colour's static graph (no drift) in plain JS: the
 * shared noise kernel, then the same filters, width matrix and trim the sound
 * builds from Web Audio nodes.
 */
function render(colour: NoiseSoundColour, tone: number, width: number, seconds: number) {
  const generator = new NoiseGenerator(colour === "grey" ? "pink" : colour, 1, 1, 2, RATE);
  let channels: Float32Array[] = [0, 1].map((c) => {
    const samples = new Float32Array(seconds * RATE);
    generator.render(c, samples, 0);
    return samples;
  });
  for (const spec of SHAPING[colour]) {
    const coefficients = biquadCoefficients(spec, RATE);
    channels = channels.map((x) => filterSamples(coefficients, x));
  }
  const { direct, cross } = widthGains(width);
  const [left = new Float32Array(), right = new Float32Array()] = channels;
  const mixed = [
    left.map((v, i) => direct * v + cross * (right[i] ?? 0)),
    right.map((v, i) => direct * v + cross * (left[i] ?? 0)),
  ];
  const tilt = tiltGains(tiltDb(tone));
  const shelf = biquadCoefficients(
    { type: "highshelf", frequency: TILT_PIVOT, gain: tilt.shelf },
    RATE,
  );
  const gain = dbToGain(LEVEL_DB[colour]) * tilt.level;
  return mixed.map((x) => filterSamples(shelf, x).map((v) => v * gain));
}

function peakDb(channels: readonly Float32Array[], skip: number): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = skip; i < channel.length; i++) {
      peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    }
  }
  return 20 * Math.log10(peak);
}

describe("grey EQ", () => {
  // The intended curve: most of the low shelf's +10 dB at 100 Hz, flat near 1 kHz,
  // the full −6 dB dip at 3.5 kHz, and the start of the top lift by 10 kHz.
  it.each([
    [100, 8],
    [1000, 0],
    [3500, -6],
    [10000, 1.5],
  ])("is about the inverse equal-loudness curve at %s Hz (%s dB)", (frequency, expected) => {
    const total = GREY_EQ.reduce(
      (sum, spec) => sum + responseDb(biquadCoefficients(spec, RATE), frequency, RATE),
      0,
    );
    expect(Math.abs(total - expected)).toBeLessThanOrEqual(1);
  });
});

describe("tiltDb", () => {
  it.each([
    [-100, -6],
    [0, 0],
    [50, 3],
    [100, 6],
  ])("tilts tone %s by %s dB", (tone, expected) => {
    expect(tiltDb(tone)).toBeCloseTo(expected, 9);
  });
});

describe("tiltGains", () => {
  it.each([-6, -3, 0, 3, 6])("turns the lows by −%s dB and the highs by %s dB", (db) => {
    const { shelf, level } = tiltGains(db);
    const coefficients = biquadCoefficients(
      { type: "highshelf", frequency: TILT_PIVOT, gain: shelf },
      RATE,
    );
    const levelDb = 20 * Math.log10(level);
    expect(responseDb(coefficients, 20, RATE) + levelDb).toBeCloseTo(-db, 1);
    expect(responseDb(coefficients, 20000, RATE) + levelDb).toBeCloseTo(db, 1);
    expect(responseDb(coefficients, TILT_PIVOT, RATE) + levelDb).toBeCloseTo(0, 6);
  });
});

describe("widthGains", () => {
  it("passes the channels through at 100 % and sums them at 0 %", () => {
    expect(widthGains(100)).toEqual({ direct: 1, cross: 0 });
    const mono = widthGains(0);
    expect(mono.direct).toBeCloseTo(Math.SQRT1_2, 12);
    expect(mono.cross).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it.each([0, 10, 25, 50, 70, 90, 100])(
    "keeps the power of decorrelated channels constant at %s %%",
    (width) => {
      const { direct, cross } = widthGains(width);
      expect(direct ** 2 + cross ** 2).toBeCloseTo(1, 12);
    },
  );

  it("correlates the channels more as the width narrows", () => {
    // For decorrelated unit inputs, the outputs' correlation is 2·direct·cross.
    const correlation = (width: number) => {
      const { direct, cross } = widthGains(width);
      return 2 * direct * cross;
    };
    expect(correlation(0)).toBeCloseTo(1, 12);
    expect(correlation(50)).toBeGreaterThan(correlation(70));
    expect(correlation(100)).toBe(0);
  });

  it("clamps out-of-range widths", () => {
    expect(widthGains(150)).toEqual(widthGains(100));
    expect(widthGains(-5)).toEqual(widthGains(0));
  });
});

describe.each(COLOURS)("%s noise", (colour) => {
  it("is about −23 LUFS at default params", () => {
    const loudness = kWeightedLoudness(render(colour, DEFAULT_TONE[colour], 70, 20), RATE, 1);
    expect(Math.abs(loudness + 23)).toBeLessThan(0.5);
  });

  it.each([-100, 100])("peaks well under −3 dBFS at tone %s", (tone) => {
    expect(peakDb(render(colour, tone, 70, 20), RATE)).toBeLessThan(-5);
  });

  it("keeps its loudness as the width changes", () => {
    const wide = kWeightedLoudness(render(colour, 0, 100, 10), RATE, 1);
    const mono = kWeightedLoudness(render(colour, 0, 0, 10), RATE, 1);
    expect(Math.abs(wide - mono)).toBeLessThan(0.5);
  });
});
