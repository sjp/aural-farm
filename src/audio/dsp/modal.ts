/**
 * A bank of decaying sinusoid resonators, for struck objects in event kernels
 * (a cup on a saucer, a chime's tube, a bowl): each mode rings at its own
 * frequency and dies away exponentially over its own decay time.
 *
 *   const bank = new ModalBank(sampleRate, 4);
 *   bank.setMode(0, 2200, 0.5, 1);       // Hz, seconds to −60 dB, amplitude
 *   bank.setMode(1, 5100, 0.3, 0.4);
 *   bank.strike(0.1);                    // an impulse; strike again to add to the ring
 *   bank.render(out, 0, 128);            // adds the ringing modes into out[0..128)
 *
 * Each mode is a recursive two-pole oscillator, y[n] = c1·y[n−1] − c2·y[n−2],
 * so a sample costs two multiplies and an add per mode, with no table or
 * sine. After a `strike(gain)`, a mode's output is `gain × amplitude ×
 * r^n × sin(ω(n + 1))`: a sine from zero phase, so it never steps, falling
 * 60 dB over its decay time. Strikes add to what is already ringing.
 *
 * `strike(gain, elapsed)` sets the ring as it stands `elapsed` samples after
 * the strike, in closed form, so a kernel starting a render afresh picks up a
 * strike already ringing exactly as if it had rendered it from the start: the
 * output depends only on the strikes' times, never on when rendering began.
 * For a softer onset than an impulse, drive the bank with a short pulse
 * through `tick(input)` instead (a pulse of total area 1 rings a mode at about
 * its amplitude, less for modes above the pulse's bandwidth).
 *
 * A mode whose ring has fallen below −90 dBFS is skipped until struck again, so
 * a bank that has died away costs nothing. Modes at or above 0.45 × the sample
 * rate, or with amplitude 0, never sound. Allocates nothing after construction.
 */

/** A mode whose ring has fallen below this (−90 dBFS) is skipped. */
const SILENT = 10 ** (-90 / 20);
/** Modes at or above this fraction of the sample rate are dropped. */
export const MODAL_MAX_RATIO = 0.45;
/** The shortest decay time a mode takes, in seconds, so a decay of 0 can't divide by zero. */
const SHORTEST_DECAY = 0.001;
/** ln(1000): an exponential decay falls 60 dB over this many time constants. */
const LN_1000 = Math.log(1000);

export class ModalBank {
  /** How many modes are set (at most the capacity). */
  count = 0;
  private readonly sampleRate: number;
  /** Per mode: the recursion's coefficients, its impulse gain, its amplitude and pole radius. */
  private readonly c1: Float64Array;
  private readonly c2: Float64Array;
  private readonly omega: Float64Array;
  private readonly radius: Float64Array;
  private readonly amplitude: Float64Array;
  /** Per mode: the last two outputs, and an upper bound on its ring's amplitude now. */
  private readonly y1: Float64Array;
  private readonly y2: Float64Array;
  private readonly envelope: Float64Array;

  constructor(sampleRate: number, capacity: number) {
    this.sampleRate = sampleRate;
    this.c1 = new Float64Array(capacity);
    this.c2 = new Float64Array(capacity);
    this.omega = new Float64Array(capacity);
    this.radius = new Float64Array(capacity);
    this.amplitude = new Float64Array(capacity);
    this.y1 = new Float64Array(capacity);
    this.y2 = new Float64Array(capacity);
    this.envelope = new Float64Array(capacity);
  }

  /** How many modes the bank can hold. */
  get capacity(): number {
    return this.c1.length;
  }

  /**
   * Sets mode `index` (below the capacity; `count` grows to include it) to ring
   * at `frequency` Hz, falling 60 dB in `decay` seconds, at `amplitude` per unit
   * strike. Set a mode while it is silent: changing one that rings jumps its
   * level slightly.
   */
  setMode(index: number, frequency: number, decay: number, amplitude: number): void {
    if (index < 0 || index >= this.capacity) {
      return;
    }
    const sr = this.sampleRate;
    const audible = frequency > 0 && frequency < MODAL_MAX_RATIO * sr && Number.isFinite(amplitude);
    const omega = audible ? (2 * Math.PI * frequency) / sr : 0;
    const r = Math.exp(-LN_1000 / (Math.max(SHORTEST_DECAY, decay) * sr));
    this.omega[index] = omega;
    this.radius[index] = r;
    this.c1[index] = 2 * r * Math.cos(omega);
    this.c2[index] = r * r;
    this.amplitude[index] = audible ? amplitude : 0;
    this.count = Math.max(this.count, index + 1);
  }

  /** Clears every mode and anything ringing. */
  clear(): void {
    this.silence();
    this.count = 0;
  }

  /** Stops anything ringing at once, keeping the modes. */
  silence(): void {
    this.y1.fill(0);
    this.y2.fill(0);
    this.envelope.fill(0);
  }

  /**
   * Strikes every mode with an impulse of `gain`, as the ring stands `elapsed`
   * samples after it (0: the next sample rendered is the strike's first).
   */
  strike(gain: number, elapsed = 0): void {
    const e = Math.max(0, elapsed);
    for (let m = 0; m < this.count; m++) {
      const a = gain * this.amplitude[m];
      if (a === 0) {
        continue;
      }
      // The impulse response A·r^n·sin(ω(n + 1)), at n = e − 1 and e − 2.
      const r = this.radius[m];
      const w = this.omega[m];
      const decayed = a * r ** e;
      this.y1[m] += (decayed / r) * Math.sin(w * e);
      this.y2[m] += (decayed / (r * r)) * Math.sin(w * (e - 1));
      this.envelope[m] += Math.abs(decayed);
    }
  }

  /** An upper bound on the bank's amplitude now: 0 once everything has died away. */
  get level(): number {
    let sum = 0;
    for (let m = 0; m < this.count; m++) {
      sum += this.envelope[m];
    }
    return sum;
  }

  /** Whether any mode is still ringing. */
  get ringing(): boolean {
    for (let m = 0; m < this.count; m++) {
      if (this.envelope[m] > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * One sample: every mode driven by `input` (an impulse of `x` is
   * `strike(x)`), summed. For soft onsets; `render` is cheaper for a free ring.
   */
  tick(input = 0): number {
    let sum = 0;
    for (let m = 0; m < this.count; m++) {
      const a = this.amplitude[m];
      if (this.envelope[m] === 0 && (input === 0 || a === 0)) {
        continue;
      }
      const y =
        input * a * Math.sin(this.omega[m]) + this.c1[m] * this.y1[m] - this.c2[m] * this.y2[m];
      this.y2[m] = this.y1[m];
      this.y1[m] = y;
      sum += y;
      this.envelope[m] = this.envelope[m] * this.radius[m] + Math.abs(input * a);
      if (this.envelope[m] < SILENT) {
        this.envelope[m] = 0;
        this.y1[m] = 0;
        this.y2[m] = 0;
      }
    }
    return sum;
  }

  /** Adds the ringing modes, times `gain`, into `out` from `from` to `to`. */
  render(out: Float32Array, from: number, to: number, gain = 1): void {
    const n = to - from;
    if (n <= 0) {
      return;
    }
    for (let m = 0; m < this.count; m++) {
      if (this.envelope[m] === 0) {
        continue;
      }
      const c1 = this.c1[m];
      const c2 = this.c2[m];
      let y1 = this.y1[m];
      let y2 = this.y2[m];
      for (let i = from; i < to; i++) {
        const y = c1 * y1 - c2 * y2;
        y2 = y1;
        y1 = y;
        out[i] += gain * y;
      }
      const envelope = this.envelope[m] * this.radius[m] ** n;
      if (envelope < SILENT) {
        this.envelope[m] = 0;
        this.y1[m] = 0;
        this.y2[m] = 0;
      } else {
        this.envelope[m] = envelope;
        this.y1[m] = y1;
        this.y2[m] = y2;
      }
    }
  }
}
