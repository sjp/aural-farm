/**
 * Oscillators for worklet kernels: a phasor, a shared sine table and a
 * band-limited (PolyBLEP) saw. Prefer a native `OscillatorNode` outside a worklet.
 */

/** Entries in the sine table, a power of two; one more is stored for interpolation. */
export const SINE_TABLE_SIZE = 4096;

let table: Float32Array | undefined;

/** The shared sine table, built on first use: one cycle plus a wrap-around entry. */
export function sineTable(): Float32Array {
  if (!table) {
    table = new Float32Array(SINE_TABLE_SIZE + 1);
    for (let i = 0; i <= SINE_TABLE_SIZE; i++) {
      table[i] = Math.sin((2 * Math.PI * i) / SINE_TABLE_SIZE);
    }
  }
  return table;
}

/** sin(2π · phase), from the table with linear interpolation. Any phase works. */
export function sine(phase: number): number {
  const t = sineTable();
  const pos = (phase - Math.floor(phase)) * SINE_TABLE_SIZE;
  const i = Math.floor(pos);
  const a = t[i] ?? 0;
  return a + ((t[i + 1] ?? 0) - a) * (pos - i);
}

/** A phase accumulator in [0, 1). */
export class Phasor {
  phase: number;
  /** Phase advance per sample. */
  increment = 0;
  private readonly sampleRate: number;

  constructor(sampleRate: number, frequency = 0, phase = 0) {
    this.sampleRate = sampleRate;
    this.phase = phase - Math.floor(phase);
    this.setFrequency(frequency);
  }

  setFrequency(frequency: number): void {
    this.increment = frequency / this.sampleRate;
  }

  /** Returns the current phase and advances one sample. */
  next(): number {
    const p = this.phase;
    this.phase += this.increment;
    this.phase -= Math.floor(this.phase);
    return p;
  }
}

/** The PolyBLEP residual that smooths a unit step at phase 0, for phase increment `dt`. */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** A rising saw in [−1, 1] with PolyBLEP-smoothed resets, so it aliases far less. */
export class PolyBlepSaw {
  private readonly phasor: Phasor;

  constructor(sampleRate: number, frequency = 0, phase = 0) {
    this.phasor = new Phasor(sampleRate, frequency, phase);
  }

  setFrequency(frequency: number): void {
    this.phasor.setFrequency(frequency);
  }

  next(): number {
    const dt = this.phasor.increment;
    const p = this.phasor.next();
    return 2 * p - 1 - polyBlep(p, dt);
  }
}
