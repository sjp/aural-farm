/**
 * The shared drift kernel: smooth random motion in [−1, 1] for slow modulation
 * (swells, wander, flicker). It is value noise in time: knots every 1/`rate`
 * seconds with values from `hashFloat(seed, stream, octave, knot)`, joined by
 * Catmull-Rom curves, in 1–3 octaves. Each octave runs about twice as fast and
 * half as deep as the one before, at a ratio that isn't a simple fraction, so
 * their knots never line up.
 *
 * The value at absolute sample n is a pure function of n: it is computed on a
 * grid of `GRID` samples aligned to absolute sample 0 and interpolated linearly
 * between, which is far below audible change at drift rates and costs a few
 * hashes per grid point rather than per sample.
 */
import { HASH_START, hashStep, UINT32_SCALE } from "./random";

export const DRIFT_PROCESSOR = "aural-drift";

/** Grid spacing in samples. */
const GRID = 64;
/** Each octave's rate, as a multiple of the one before. */
const OCTAVE_RATIO = 2.137;
/** Catmull-Rom overshoots by up to 1.25 × the knot range, so knots stay within ±0.8. */
const KNOT_SCALE = 0.8;
export const MAX_DRIFT_OCTAVES = 3;

/** One drift's settings. */
export interface DriftSpec {
  stream: number;
  /** Knots per second of the slowest octave. */
  rate: number;
  /** 1–3. */
  octaves: number;
}

/** A drift processor's options: one drift per output channel, all from one seed. */
export interface DriftOptions {
  seed: number;
  drifts: DriftSpec[];
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

/** The most drifts one processor runs. */
export const MAX_DRIFT_CHANNELS = 16;

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const field = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;

function readDriftSpec(raw: unknown): DriftSpec {
  const octaves = Math.round(numberOr(field(raw, "octaves"), 1));
  return {
    stream: Math.trunc(numberOr(field(raw, "stream"), 0)),
    rate: Math.max(1e-6, numberOr(field(raw, "rate"), 0.1)),
    octaves: Math.min(MAX_DRIFT_OCTAVES, Math.max(1, octaves)),
  };
}

/**
 * Reads `processorOptions` from the main thread, falling back to safe defaults:
 * one drift when `drifts` is missing or empty, and at most `MAX_DRIFT_CHANNELS`.
 */
export function readDriftOptions(raw: unknown): DriftOptions {
  const drifts = field(raw, "drifts");
  const specs = Array.isArray(drifts) ? drifts.slice(0, MAX_DRIFT_CHANNELS) : [];
  return {
    seed: Math.trunc(numberOr(field(raw, "seed"), 0)),
    drifts:
      specs.length > 0
        ? specs.map((spec: unknown) => readDriftSpec(spec))
        : [readDriftSpec(undefined)],
    offset: numberOr(field(raw, "offset"), 0),
  };
}

export class DriftGenerator {
  private readonly sampleRate: number;
  private readonly octaves: number;
  /** Per octave: hash prefix, knots per second and weight. */
  private readonly prefixes: Uint32Array;
  private readonly rates: Float64Array;
  private readonly weights: Float64Array;
  /** The grid point whose value `gridValue` holds, and the next one's value. */
  private grid = Number.NaN;
  private gridValue = 0;
  private nextValue = 0;

  constructor(seed: number, stream: number, rate: number, octaves: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.octaves = Math.min(MAX_DRIFT_OCTAVES, Math.max(1, Math.round(octaves)));
    this.prefixes = new Uint32Array(this.octaves);
    this.rates = new Float64Array(this.octaves);
    this.weights = new Float64Array(this.octaves);
    const base = hashStep(hashStep(HASH_START, seed), stream);
    let total = 0;
    for (let o = 0; o < this.octaves; o++) {
      this.prefixes[o] = hashStep(base, o);
      this.rates[o] = rate * OCTAVE_RATIO ** o;
      const weight = 0.5 ** o;
      this.weights[o] = weight;
      total += weight;
    }
    for (let o = 0; o < this.octaves; o++) {
      this.weights[o] = ((this.weights[o] ?? 0) * KNOT_SCALE) / total;
    }
  }

  private knot(prefix: number, k: number): number {
    return hashStep(prefix, k) * UINT32_SCALE * 2 - 1;
  }

  /** The exact (unsampled) value at absolute time `t` seconds. */
  valueAtTime(t: number): number {
    let sum = 0;
    for (let o = 0; o < this.octaves; o++) {
      const prefix = this.prefixes[o] ?? 0;
      const x = t * (this.rates[o] ?? 0);
      const k = Math.floor(x);
      const f = x - k;
      const v0 = this.knot(prefix, k - 1);
      const v1 = this.knot(prefix, k);
      const v2 = this.knot(prefix, k + 1);
      const v3 = this.knot(prefix, k + 2);
      // Catmull-Rom through v1 (f = 0) and v2 (f = 1).
      const value =
        v1 +
        0.5 * f * (v2 - v0 + f * (2 * v0 - 5 * v1 + 4 * v2 - v3 + f * (3 * (v1 - v2) + v3 - v0)));
      sum += (this.weights[o] ?? 0) * value;
    }
    return sum;
  }

  /** The output at absolute sample `n`: grid values, linearly interpolated. */
  valueAt(n: number): number {
    const g = Math.floor(n / GRID);
    if (g !== this.grid) {
      this.gridValue = g === this.grid + 1 ? this.nextValue : this.gridPoint(g);
      this.nextValue = this.gridPoint(g + 1);
      this.grid = g;
    }
    return this.gridValue + (this.nextValue - this.gridValue) * ((n - g * GRID) / GRID);
  }

  private gridPoint(g: number): number {
    return this.valueAtTime((g * GRID) / this.sampleRate);
  }

  /** Fills `out` with the samples from absolute sample `start` on. */
  render(out: Float32Array, start: number): void {
    for (let i = 0; i < out.length; i++) {
      out[i] = this.valueAt(start + i);
    }
  }
}
