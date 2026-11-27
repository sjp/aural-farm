/**
 * Per-sample envelopes for events in worklet kernels: a linear attack, an optional
 * hold, then an exponential decay. They allocate nothing, and can start part-way
 * through (`elapsed`), so a kernel that picks up an event that began before its
 * first sample (a render chunk's start) lands on the same values as one that
 * rendered the event from its beginning.
 */

/**
 * The per-sample multiplier of an exponential decay with time constant `seconds`
 * (the time to fall to 1/e). Zero or less decays at once.
 */
export function expDecayCoef(seconds: number, sampleRate: number): number {
  return seconds > 0 ? Math.exp(-1 / (seconds * sampleRate)) : 0;
}

/**
 * The value at `t` seconds after the start of an envelope rising linearly to
 * `peak` over `attack`, holding for `hold`, then decaying with time constant
 * `decay`. Zero before the start.
 */
export function envelopeAt(
  t: number,
  peak: number,
  attack: number,
  hold: number,
  decay: number,
): number {
  if (t < 0) {
    return 0;
  }
  if (t < attack) {
    return (peak * t) / attack;
  }
  if (t < attack + hold) {
    return peak;
  }
  return decay > 0 ? peak * Math.exp(-(t - attack - hold) / decay) : 0;
}

const IDLE = 0;
const ATTACK = 1;
const HOLD = 2;
const DECAY = 3;

export class Envelope {
  /** The value `next()` last returned. */
  value = 0;
  /** Whether the envelope is sounding. It ends once it has decayed below its floor. */
  active = false;
  private readonly sampleRate: number;
  /** The level, relative to the peak, at which the decay counts as silent. */
  private readonly floorRatio: number;
  private stage = IDLE;
  private peak = 0;
  /** Samples into the attack or hold. */
  private position = 0;
  private attackSamples = 0;
  private holdSamples = 0;
  /** The decay's next value, and its per-sample multiplier. */
  private level = 0;
  private coef = 0;
  private floor = 0;

  /** @param endDb the level, relative to the peak, at which the envelope ends */
  constructor(sampleRate: number, endDb = -80) {
    this.sampleRate = sampleRate;
    this.floorRatio = 10 ** (endDb / 20);
  }

  /** Starts an attack-decay envelope, `elapsed` seconds in. */
  attackDecay(peak: number, attack: number, decay: number, elapsed = 0): void {
    this.attackHoldRelease(peak, attack, 0, decay, elapsed);
  }

  /**
   * Starts an attack-hold-release envelope, `elapsed` seconds in. Sample i after
   * the start is `envelopeAt(i / sampleRate, …)`, with the stage lengths rounded
   * to whole samples.
   */
  attackHoldRelease(
    peak: number,
    attack: number,
    hold: number,
    release: number,
    elapsed = 0,
  ): void {
    const sr = this.sampleRate;
    this.peak = peak;
    this.attackSamples = Math.max(0, Math.round(attack * sr));
    this.holdSamples = Math.max(0, Math.round(hold * sr));
    this.coef = expDecayCoef(release, sr);
    this.floor = Math.abs(peak) * this.floorRatio;
    this.active = true;
    let skip = Math.max(0, Math.round(elapsed * sr));
    if (skip < this.attackSamples) {
      this.stage = ATTACK;
      this.position = skip;
      return;
    }
    skip -= this.attackSamples;
    if (skip < this.holdSamples) {
      this.stage = HOLD;
      this.position = skip;
      return;
    }
    skip -= this.holdSamples;
    this.stage = DECAY;
    this.level = peak * this.coef ** skip;
  }

  /** Returns the current sample's value and advances one sample. */
  next(): number {
    switch (this.stage) {
      case ATTACK: {
        this.value = (this.peak * this.position) / this.attackSamples;
        this.position++;
        if (this.position >= this.attackSamples) {
          this.enter(this.holdSamples > 0 ? HOLD : DECAY);
        }
        return this.value;
      }
      case HOLD: {
        this.value = this.peak;
        this.position++;
        if (this.position >= this.holdSamples) {
          this.enter(DECAY);
        }
        return this.value;
      }
      case DECAY: {
        this.value = this.level;
        this.level *= this.coef;
        if (Math.abs(this.level) <= this.floor || this.coef === 0) {
          this.stage = IDLE;
          this.active = false;
        }
        return this.value;
      }
      default:
        this.value = 0;
        return 0;
    }
  }

  /** Silences the envelope at once (as when its voice is stolen). */
  stop(): void {
    this.stage = IDLE;
    this.active = false;
    this.value = 0;
  }

  private enter(stage: number): void {
    this.stage = stage;
    this.position = 0;
    this.level = this.peak;
  }
}
