/**
 * A state-variable filter after Andrew Simper (Cytomic): trapezoidal
 * integration, so it stays stable and smooth however fast its cutoff and Q move,
 * with low-pass, band-pass, high-pass and notch outputs from one update.
 *
 *   const svf = new Svf(sampleRate);
 *   svf.set(1200, 4);
 *   for (…) { svf.tick(x); out[i] = svf.band; }
 */

/** The cutoff stays below this fraction of the sample rate, where tan() would blow up. */
const MAX_CUTOFF_RATIO = 0.49;
const MIN_CUTOFF = 1;
const MIN_Q = 0.05;

export class Svf {
  /** Outputs of the last `tick`. */
  low = 0;
  /** Band-pass, normalised to a gain of 1 at the centre whatever the Q. */
  band = 0;
  high = 0;
  notch = 0;
  private readonly sampleRate: number;
  private k = Math.SQRT2;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private ic1 = 0;
  private ic2 = 0;

  constructor(sampleRate: number, cutoff = 1000, q = Math.SQRT1_2) {
    this.sampleRate = sampleRate;
    this.set(cutoff, q);
  }

  /** Sets the cutoff (or centre) in Hz and the resonance Q. Cheap enough to call per sample. */
  set(cutoff: number, q: number): void {
    const fc = Math.min(Math.max(cutoff, MIN_CUTOFF), this.sampleRate * MAX_CUTOFF_RATIO);
    const g = Math.tan((Math.PI * fc) / this.sampleRate);
    const k = 1 / Math.max(q, MIN_Q);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** Filters one sample, updating every output. */
  tick(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = this.k * v1;
    this.high = x - this.k * v1 - v2;
    this.notch = x - this.k * v1;
  }

  /** Clears the filter's memory. */
  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
    this.low = 0;
    this.band = 0;
    this.high = 0;
    this.notch = 0;
  }
}
