/**
 * Low-frequency oscillators phase-aligned to absolute time, so a sound's pulses
 * and throbs land at the same moments however it is rendered (live, or offline
 * in chunks). A native `OscillatorNode` does the work: it can't start mid-cycle,
 * so the phase is applied by rotating the waveform's Fourier coefficients.
 *
 *   const lfo = createLfo(ctx, scope, { frequency: 0.4, wave: pulse, startAt: init.startAt });
 *   lfo.connect(depth).connect(filter.frequency);
 */
import { glide } from "./glide";
import type { AudioScope } from "./scope";

/**
 * A periodic waveform as Fourier coefficients, as `PeriodicWave` takes them:
 * x(φ) = Σₖ real[k] · cos(2πkφ) + imag[k] · sin(2πkφ) for k ≥ 1, where φ is the
 * phase in cycles. Index 0 (DC) is ignored.
 */
export interface Wave {
  real: readonly number[];
  imag: readonly number[];
}

/** A sine, rising through zero at phase 0. */
export const SINE_WAVE: Wave = { real: [0, 0], imag: [0, 1] };

/** Time constant of a frequency glide, in seconds. */
const FREQUENCY_TAU = 0.1;

/** The waveform's value at `phase` (in cycles). */
export function waveAt(wave: Wave, phase: number): number {
  let sum = 0;
  const harmonics = Math.max(wave.real.length, wave.imag.length);
  for (let k = 1; k < harmonics; k++) {
    const angle = 2 * Math.PI * k * phase;
    sum += (wave.real[k] ?? 0) * Math.cos(angle) + (wave.imag[k] ?? 0) * Math.sin(angle);
  }
  return sum;
}

/** The same waveform started `phase` cycles in: `waveAt(rotated, φ) = waveAt(wave, φ + phase)`. */
export function rotateWave(wave: Wave, phase: number): Wave {
  const harmonics = Math.max(wave.real.length, wave.imag.length);
  const real = [0];
  const imag = [0];
  for (let k = 1; k < harmonics; k++) {
    const a = wave.real[k] ?? 0;
    const b = wave.imag[k] ?? 0;
    const angle = 2 * Math.PI * k * phase;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    real.push(a * c + b * s);
    imag.push(b * c - a * s);
  }
  return { real, imag };
}

/** Samples per cycle when building and measuring a waveform. */
const RESOLUTION = 2048;

/**
 * The periodic function `shape` (phase in cycles, 0 to 1), band-limited to its
 * first `harmonics` Fourier terms. The truncated series is scaled to span
 * exactly 1; add `offset` (a `ConstantSourceNode`, or a gain's base value) to
 * map it onto 0..1, since a `PeriodicWave` has no DC term.
 */
export function fourierWave(
  shape: (phase: number) => number,
  harmonics: number,
): Wave & { offset: number } {
  const real = [0];
  const imag = [0];
  for (let k = 1; k <= harmonics; k++) {
    let a = 0;
    let b = 0;
    for (let m = 0; m < RESOLUTION; m++) {
      const phase = m / RESOLUTION;
      const x = shape(phase);
      a += x * Math.cos(2 * Math.PI * k * phase);
      b += x * Math.sin(2 * Math.PI * k * phase);
    }
    real.push((2 * a) / RESOLUTION);
    imag.push((2 * b) / RESOLUTION);
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let m = 0; m < RESOLUTION; m++) {
    const v = waveAt({ real, imag }, m / RESOLUTION);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const span = max - min;
  return {
    real: real.map((v) => v / span),
    imag: imag.map((v) => v / span),
    offset: -min / span,
  };
}

/**
 * An asymmetric raised pulse: a raised-cosine rise over the first `rise` of the
 * cycle (0 to 1), then a raised-cosine fall over the rest, band-limited to
 * `harmonics` Fourier terms and scaled as `fourierWave` scales it.
 */
export function pulseWave(rise: number, harmonics: number): Wave & { offset: number } {
  const r = Math.min(0.95, Math.max(0.05, rise));
  return fourierWave(
    (phase) =>
      phase < r
        ? 0.5 - 0.5 * Math.cos((Math.PI * phase) / r)
        : 0.5 + 0.5 * Math.cos((Math.PI * (phase - r)) / (1 - r)),
    harmonics,
  );
}

interface LfoOptions {
  /** Cycles per second. */
  frequency: number;
  /** The waveform; a sine by default. */
  wave?: Wave;
  /** The sound's `init.startAt`: the absolute time the context's current time stands for. */
  startAt: number;
}

/**
 * An oscillator at `frequency`, started now, whose phase at absolute time
 * `startAt` is `fract(frequency · startAt)`, as if it had run since absolute time
 * 0, so it can run at audio rates as a tone. The wave isn't normalised: its values are those of `wave`. The oscillator is
 * registered with `scope`.
 */
export function createLfo(
  ctx: BaseAudioContext,
  scope: AudioScope,
  options: LfoOptions,
): OscillatorNode {
  const { frequency, startAt } = options;
  // The oscillator runs at its frequency param's single-precision value, so the
  // phase follows that: the double would drift from it by up to a few
  // hundredths of a cycle over an hour at audio rates.
  const cycles = Math.fround(frequency) * startAt;
  const rotated = rotateWave(options.wave ?? SINE_WAVE, cycles - Math.floor(cycles));
  const periodicWave = new PeriodicWave(ctx, {
    real: [...rotated.real],
    imag: [...rotated.imag],
    disableNormalization: true,
  });
  const osc = scope.addSource(new OscillatorNode(ctx, { frequency, periodicWave }));
  osc.start(ctx.currentTime);
  return osc;
}

/**
 * Glides an LFO to a new frequency. Its phase then no longer follows absolute
 * time, which is fine for a live param change.
 */
export function setLfoFrequency(lfo: OscillatorNode, frequency: number, when: number): void {
  glide(lfo.frequency, frequency, when, FREQUENCY_TAU);
}
