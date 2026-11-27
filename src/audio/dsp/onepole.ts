/**
 * One-pole filters and a parameter smoother: the cheapest tone shaping and
 * de-zippering for worklet kernels.
 */

/** The pole of a one-pole low-pass at `cutoff` Hz. */
function poleFor(cutoff: number, sampleRate: number): number {
  return Math.exp((-2 * Math.PI * Math.max(0, cutoff)) / sampleRate);
}

/** A one-pole low-pass (6 dB per octave) with unity gain at DC. */
export class OnePoleLowpass {
  value = 0;
  private readonly sampleRate: number;
  private pole = 0;

  constructor(sampleRate: number, cutoff: number) {
    this.sampleRate = sampleRate;
    this.setCutoff(cutoff);
  }

  setCutoff(cutoff: number): void {
    this.pole = poleFor(cutoff, this.sampleRate);
  }

  process(x: number): number {
    this.value = x + this.pole * (this.value - x);
    return this.value;
  }
}

/** A one-pole high-pass: the input minus its one-pole low-pass, so DC is removed. */
export class OnePoleHighpass {
  private readonly lowpass: OnePoleLowpass;

  constructor(sampleRate: number, cutoff: number) {
    this.lowpass = new OnePoleLowpass(sampleRate, cutoff);
  }

  setCutoff(cutoff: number): void {
    this.lowpass.setCutoff(cutoff);
  }

  process(x: number): number {
    return x - this.lowpass.process(x);
  }
}

/**
 * Glides a value towards its target exponentially, with time constant `seconds`,
 * so a parameter read once per block changes without zipper noise.
 */
export class Smoother {
  value: number;
  target: number;
  private coef: number;

  constructor(sampleRate: number, seconds: number, initial = 0) {
    this.coef = seconds > 0 ? Math.exp(-1 / (seconds * sampleRate)) : 0;
    this.value = initial;
    this.target = initial;
  }

  /** Jumps straight to `value`. */
  reset(value: number): void {
    this.value = value;
    this.target = value;
  }

  /** Advances one sample and returns the value. */
  next(): number {
    this.value = this.target + this.coef * (this.value - this.target);
    return this.value;
  }
}
