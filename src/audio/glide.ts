/**
 * Click-free param changes and level conversions. Sounds glide every continuous
 * param rather than setting `.value` on a running node.
 */

/**
 * Glides `param` towards `target` from `when`, with time constant `tau`. Any
 * automation still scheduled from `when` on is cancelled first, holding the value
 * there, so a glide that interrupts another (a dragged slider) carries on smoothly
 * from wherever the param had got to. Use a `tau` of 0.05–0.15 s for gain and
 * pitch, and 0.3–1 s for timbre.
 */
export function glide(param: AudioParam, target: number, when: number, tau: number): void {
  // Firefox has no cancelAndHoldAtTime: hold the current value by hand instead.
  const { cancelAndHoldAtTime } = param as Partial<Pick<AudioParam, "cancelAndHoldAtTime">>;
  if (cancelAndHoldAtTime) {
    param.cancelAndHoldAtTime(when);
  } else {
    const held = param.value;
    param.cancelScheduledValues(when);
    param.setValueAtTime(held, when);
  }
  param.setTargetAtTime(target, when, tau);
}

/** Decibels to a linear gain: 0 dB is 1, −6 dB about 0.5. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** A linear gain to decibels; silence is −Infinity. */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
}
