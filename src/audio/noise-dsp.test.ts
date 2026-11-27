import { describe, expect, it } from "vitest";
import { hashFloat } from "./random";
import {
  NOISE_COLOURS,
  NOISE_RMS,
  NoiseGenerator,
  readNoiseOptions,
  type NoiseColour,
} from "./noise-dsp";

const QUANTUM = 128;

/** Renders `length` samples of `channel` from absolute sample `start`, a quantum at a time. */
function render(gen: NoiseGenerator, start: number, length: number, channel = 0): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += QUANTUM) {
    gen.render(channel, out.subarray(i, Math.min(i + QUANTUM, length)), start + i);
  }
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

/** In-place radix-2 FFT of (re, im). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] ?? 0) * wr - (im[b] ?? 0) * wi;
        const xi = (re[b] ?? 0) * wi + (im[b] ?? 0) * wr;
        re[b] = (re[a] ?? 0) - xr;
        im[b] = (im[a] ?? 0) - xi;
        re[a] = (re[a] ?? 0) + xr;
        im[a] = (im[a] ?? 0) + xi;
      }
    }
  }
}

/**
 * The slope of the power spectrum in dB per octave over 100 Hz–10 kHz: a Welch
 * average of Hann-windowed segments, then a least-squares line through the power
 * of each sixth-octave band (as power per Hz) against log2 of its frequency.
 */
function spectralSlope(signal: Float32Array, sampleRate: number): number {
  const size = 4096;
  const power = new Float64Array(size / 2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let start = 0; start + size <= signal.length; start += size / 2) {
    for (let i = 0; i < size; i++) {
      re[i] = (signal[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) {
      power[k] = (power[k] ?? 0) + (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let f = 100; f < 10000; f *= 2 ** (1 / 6)) {
    const lo = Math.ceil((f * size) / sampleRate);
    const hi = Math.floor((f * 2 ** (1 / 6) * size) / sampleRate);
    let sum = 0;
    for (let k = lo; k <= hi; k++) {
      sum += power[k] ?? 0;
    }
    xs.push(Math.log2(f));
    ys.push(10 * Math.log10(sum / (hi - lo + 1)));
  }
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * ((ys[i] ?? 0) - my);
    den += (x - mx) ** 2;
  });
  return num / den;
}

describe("NoiseGenerator", () => {
  it("makes white noise from a hash of the seed, stream, channel and absolute sample", () => {
    const out = render(new NoiseGenerator("white", 7, 3, 2, 48000), 1000, 4, 1);
    const scale = NOISE_RMS * Math.sqrt(3);
    out.forEach((v, i) => {
      expect(v).toBeCloseTo((hashFloat(7, 3, 1, 1000 + i) * 2 - 1) * scale, 6);
    });
  });

  it.each(NOISE_COLOURS)("is deterministic: %s repeats sample for sample", (colour) => {
    const a = render(new NoiseGenerator(colour, 1, 1, 1, 48000), 0, 4800);
    const b = render(new NoiseGenerator(colour, 1, 1, 1, 48000), 0, 4800);
    expect(b).toEqual(a);
    const other = render(new NoiseGenerator(colour, 2, 1, 1, 48000), 0, 4800);
    expect(other).not.toEqual(a);
  });

  it.each(NOISE_COLOURS)(
    "is time-addressable: %s rendered from block k matches a render from 0",
    (colour) => {
      const sr = 48000;
      const whole = render(new NoiseGenerator(colour, 5, 2, 1, sr), 0, sr);
      const k = 200 * QUANTUM;
      const late = render(new NoiseGenerator(colour, 5, 2, 1, sr), k, sr - k);
      // Pink and brown start with empty filters; after a moment they agree.
      const settle = sr / 4;
      let worst = 0;
      for (let i = settle; i < late.length; i++) {
        worst = Math.max(worst, Math.abs((late[i] ?? 0) - (whole[k + i] ?? 0)));
      }
      expect(worst).toBeLessThan(1e-4);
    },
  );

  it("white noise is time-addressable sample for sample, with no settling", () => {
    const whole = render(new NoiseGenerator("white", 5, 2, 1, 48000), 0, 48000);
    const k = 12345;
    const late = render(new NoiseGenerator("white", 5, 2, 1, 48000), k, 48000 - k);
    expect(late).toEqual(whole.subarray(k));
  });

  it.each([
    ["white", 0],
    ["pink", -3],
    ["brown", -6],
  ] as const)("has the expected spectral slope: %s about %d dB per octave", (colour, slope) => {
    for (const sr of [44100, 48000]) {
      const out = render(new NoiseGenerator(colour, 3, 1, 1, sr), 0, sr * 4);
      expect(Math.abs(spectralSlope(out, sr) - slope)).toBeLessThan(0.5);
    }
  });

  it.each(NOISE_COLOURS.flatMap((c) => [44100, 48000].map((sr) => [c, sr] as const)))(
    "comes out at −12 dBFS RMS: %s at %d Hz",
    (colour: NoiseColour, sr) => {
      const out = render(new NoiseGenerator(colour, 4, 1, 1, sr), 0, sr * 10);
      const db = 20 * Math.log10(rms(out.subarray(sr)));
      expect(Math.abs(db - -12)).toBeLessThan(0.5);
    },
  );

  it.each(NOISE_COLOURS)("decorrelates the stereo channels: %s", (colour) => {
    const gen = new NoiseGenerator(colour, 1, 1, 2, 48000);
    const left = render(gen, 0, 48000, 0);
    const right = render(gen, 0, 48000, 1);
    let cross = 0;
    for (let i = 0; i < left.length; i++) {
      cross += (left[i] ?? 0) * (right[i] ?? 0);
    }
    const correlation = cross / left.length / (rms(left) * rms(right));
    expect(Math.abs(correlation)).toBeLessThan(0.1);
  });

  it.each(NOISE_COLOURS)(
    "has no NaN or Infinity and a bounded peak at extreme positions: %s",
    (colour) => {
      for (const start of [-(2 ** 40), -1, 0, 2 ** 32 - 64, 2 ** 45]) {
        const out = render(new NoiseGenerator(colour, 999, 99, 2, 48000), start, 48000);
        expect(out.every((v) => Number.isFinite(v) && Math.abs(v) < 2)).toBe(true);
      }
    },
  );
});

describe("readNoiseOptions", () => {
  it("reads valid options", () => {
    expect(
      readNoiseOptions({ colour: "pink", seed: 3, stream: 2, channels: 2, offset: 1.5 }),
    ).toEqual({ colour: "pink", seed: 3, stream: 2, channels: 2, offset: 1.5 });
  });

  it.each([undefined, null, 4, { colour: "blue", seed: "x", channels: 5, offset: Number.NaN }])(
    "falls back to safe defaults for %j",
    (raw) => {
      expect(readNoiseOptions(raw)).toEqual({
        colour: "white",
        seed: 0,
        stream: 0,
        channels: 1,
        offset: 0,
      });
    },
  );
});
