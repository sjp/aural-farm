/**
 * The sleep timer's fade-out: a value curve whose gain falls linearly in
 * decibels, from 0 dB to −60 dB, then to silence. Loudness follows decibels
 * rather than gain, so this sounds like an even fade from start to end, where a
 * linear gain ramp hardly seems to move at first and then drops away at the end.
 */
import { dbToGain } from "./glide";

/** Where the even part of the fade ends, before the last step to silence. */
export const SLEEP_FADE_FLOOR_DB = -60;
/** Points in the curve: enough that each straight piece between them is a fraction of a dB. */
const CURVE_POINTS = 256;

/** The fade-out curve for `setValueCurveAtTime`, from 1 down to 0. */
export function sleepFadeCurve(points = CURVE_POINTS): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const steps = points - 2;
  for (let i = 0; i <= steps; i++) {
    curve[i] = dbToGain((SLEEP_FADE_FLOOR_DB * i) / steps);
  }
  curve[points - 1] = 0;
  return curve;
}

/**
 * The value of `curve`, set with `setValueCurveAtTime(curve, start, duration)`, at
 * time `t`: interpolated linearly between its points, as browsers do, holding the
 * first point before `start` and the last after the end.
 */
export function curveValue(
  curve: ArrayLike<number>,
  start: number,
  duration: number,
  t: number,
): number {
  const last = curve.length - 1;
  if (t <= start) {
    return curve[0];
  }
  if (t >= start + duration) {
    return curve[last];
  }
  const position = ((t - start) / duration) * last;
  const index = Math.floor(position);
  const a = curve[index];
  const b = curve[Math.min(index + 1, last)];
  return a + (b - a) * (position - index);
}
