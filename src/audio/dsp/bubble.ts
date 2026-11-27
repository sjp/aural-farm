/**
 * The ring of a small air bubble trapped under water, for event kernels (rain
 * on puddles, a babbling stream): a sine at the bubble's resonance that decays
 * exponentially and glides upwards as the bubble rises and shrinks, after a
 * 1 ms raised-cosine attack so it never clicks.
 *
 *   const voice = new BubbleVoice(sampleRate);
 *   voice.start(0.2, minnaertFrequency(0.0015), 30, 0.004, 4500);
 *   while (voice.active) out[i++] += voice.next();
 *
 * Its frequency is `f0 × (1 + sweep × t)`, held at `maxFrequency` once it gets
 * there, and its amplitude `peak × exp(−t / decay)`; it ends once that has
 * fallen to `BUBBLE_END_DB`. It allocates nothing, and its samples depend only on
 * its start arguments and the samples since its start.
 */
import { sine } from "./osc";

/** A bubble's ring ends at this level relative to its peak, in dB. */
const BUBBLE_END_DB = -60;
/** The raised-cosine attack, in seconds. */
export const BUBBLE_ATTACK = 0.001;

/** How many time constants an exponential decay takes to reach `BUBBLE_END_DB`: ln(1000). */
export const BUBBLE_LIFE = Math.log(10 ** (-BUBBLE_END_DB / 20));

/**
 * The Minnaert resonance of an air bubble of `radius` metres in water near the
 * surface: about 3.26 / r Hz (3.26 kHz for a 1 mm bubble).
 */
export function minnaertFrequency(radius: number): number {
  return 3.26 / radius;
}

export class BubbleVoice {
  /** The envelope's level now (without the attack's rise), to choose which voice to steal. */
  level = 0;
  /** Whether the voice is sounding. */
  active = false;
  private readonly sampleRate: number;
  private peak = 0;
  private phase = 0;
  /** Phase advance per sample, its growth per sample, and its ceiling. */
  private increment = 0;
  private incrementStep = 0;
  private maxIncrement = 0;
  /** The decay's current value (from 1) and its per-sample multiplier. */
  private envelope = 0;
  private coef = 0;
  /** Samples since the start, the attack's length and the voice's whole length. */
  private position = 0;
  private attackSamples = 1;
  private endSamples = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** The frequency the next sample plays at, in Hz. */
  get frequency(): number {
    return this.increment * this.sampleRate;
  }

  /**
   * Starts a ring at `frequency` Hz peaking near `peak`, its frequency rising by
   * `sweep` × `frequency` per second up to at most `maxFrequency`, decaying with
   * time constant `decay` seconds.
   */
  start(
    peak: number,
    frequency: number,
    sweep: number,
    decay: number,
    maxFrequency = Number.POSITIVE_INFINITY,
  ): void {
    const sr = this.sampleRate;
    const ceiling = Math.min(maxFrequency, sr / 2);
    this.peak = peak;
    this.phase = 0;
    this.maxIncrement = ceiling / sr;
    this.increment = Math.min(frequency, ceiling) / sr;
    this.incrementStep = Math.max(0, (frequency * sweep) / (sr * sr));
    this.envelope = 1;
    this.coef = decay > 0 ? Math.exp(-1 / (decay * sr)) : 0;
    this.position = 0;
    this.attackSamples = Math.max(1, Math.round(BUBBLE_ATTACK * sr));
    this.endSamples = Math.max(1, Math.ceil(Math.max(0, decay) * BUBBLE_LIFE * sr));
    this.level = peak;
    this.active = true;
  }

  /** Returns the current sample and advances one sample; 0 once the ring has ended. */
  next(): number {
    if (!this.active) {
      return 0;
    }
    const n = this.position;
    let value = this.peak * this.envelope * sine(this.phase);
    if (n < this.attackSamples) {
      // 0.5 × (1 − cos(π n / attack)), from the sine table.
      value *= 0.5 - 0.5 * sine(0.25 + n / (2 * this.attackSamples));
    }
    this.phase += this.increment;
    if (this.phase >= 1) {
      this.phase -= 1;
    }
    this.increment = Math.min(this.increment + this.incrementStep, this.maxIncrement);
    this.envelope *= this.coef;
    this.position = n + 1;
    this.level = this.peak * this.envelope;
    if (this.position >= this.endSamples) {
      this.stop();
    }
    return value;
  }

  /** Silences the voice at once (as when it is stolen). */
  stop(): void {
    this.active = false;
    this.level = 0;
  }
}
