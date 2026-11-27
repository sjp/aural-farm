/**
 * The maths of the browser's `BiquadFilterNode`, outside the browser: its
 * coefficients as the Web Audio spec defines them (the Audio EQ Cookbook, with Q
 * in dB for lowpass and highpass, and shelves at a fixed slope of 1), its
 * magnitude response, and a plain filter loop. Tests use these to check a sound's
 * filter settings and to measure what its graph does to a signal.
 */

/** The filter types sounds use, with their settings as a `BiquadFilterNode` takes them. */
export interface BiquadSpec {
  type: "lowpass" | "highpass" | "lowshelf" | "highshelf" | "peaking";
  /** Hz. */
  frequency: number;
  /** dB, for shelves and peaking. */
  gain?: number;
  /** Peaking: the bandwidth Q. Lowpass and highpass: resonance in dB. Shelves ignore it. */
  Q?: number;
}

/** Normalised coefficients: `a0` is 1. */
export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The `Q` of a Butterworth lowpass or highpass, in the dB the node takes: 1/√2 as dB. */
export const BUTTERWORTH_Q = 20 * Math.log10(Math.SQRT1_2);

export function biquadCoefficients(spec: BiquadSpec, sampleRate: number): BiquadCoefficients {
  const w0 = (2 * Math.PI * spec.frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const gain = spec.gain ?? 0;
  const q = spec.Q ?? 1;
  const A = 10 ** (gain / 40);
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  switch (spec.type) {
    case "lowpass":
    case "highpass": {
      const alpha = sin / (2 * 10 ** (q / 20));
      const sign = spec.type === "lowpass" ? -1 : 1;
      b0 = (1 + sign * cos) / 2;
      b1 = -sign * (1 + sign * cos);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case "peaking": {
      const alpha = sin / (2 * q);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    }
    case "lowshelf":
    case "highshelf": {
      // Slope S = 1: alpha = sin(w0)/2 · √2.
      const k = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
      const sign = spec.type === "lowshelf" ? 1 : -1;
      b0 = A * (A + 1 - sign * (A - 1) * cos + k);
      b1 = 2 * sign * A * (A - 1 - sign * (A + 1) * cos);
      b2 = A * (A + 1 - sign * (A - 1) * cos - k);
      a0 = A + 1 + sign * (A - 1) * cos + k;
      a1 = -2 * sign * (A - 1 + sign * (A + 1) * cos);
      a2 = A + 1 + sign * (A - 1) * cos - k;
      break;
    }
    default:
      spec.type satisfies never;
      return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** The gain, in dB, of `c` at `frequency` Hz. */
export function responseDb(c: BiquadCoefficients, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  // |b0 + b1 z⁻¹ + b2 z⁻²|² / |1 + a1 z⁻¹ + a2 z⁻²|² at z = e^{jw}.
  const power = (x0: number, x1: number, x2: number) => {
    const re = x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w);
    const im = x1 * Math.sin(w) + x2 * Math.sin(2 * w);
    return re * re + im * im;
  };
  return 10 * Math.log10(power(c.b0, c.b1, c.b2) / power(1, c.a1, c.a2));
}

/** Runs `input` through the filter `c` from rest (transposed direct form II). */
export function filterSamples(c: BiquadCoefficients, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] ?? 0;
    const y = c.b0 * x + s1;
    s1 = c.b1 * x - c.a1 * y + s2;
    s2 = c.b2 * x - c.a2 * y;
    out[i] = y;
  }
  return out;
}
