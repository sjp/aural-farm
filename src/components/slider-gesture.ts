/** How far a touch moves before it counts as a drag of the slider or a scroll, in px. */
export const TOUCH_SLOP_PX = 8;
/** The thumb's width under a coarse pointer, as in the stylesheet. */
const TOUCH_THUMB_PX = 28;

/** What a touch is doing: not yet moved far enough to tell, sliding the value, or scrolling. */
export type TouchIntent = "undecided" | "slide" | "scroll";

/** What a touch that has moved `dx`, `dy` from where it started is doing. */
export function touchIntent(dx: number, dy: number): TouchIntent {
  const across = Math.abs(dx);
  const along = Math.abs(dy);
  if (Math.max(across, along) < TOUCH_SLOP_PX) {
    return "undecided";
  }
  return across > along ? "slide" : "scroll";
}

/**
 * The slider value under `x`, for a track from `left` that is `width` wide: the
 * thumb's centre travels from half a thumb in from either end. Snapped to `step`
 * unless it is "any".
 */
export function valueAtX(
  x: number,
  track: { left: number; width: number },
  range: { min: number; max: number; step: number | "any" },
  thumb = TOUCH_THUMB_PX,
): number {
  const travel = track.width - thumb;
  const fraction = travel > 0 ? Math.min(1, Math.max(0, (x - track.left - thumb / 2) / travel)) : 0;
  const { min, max, step } = range;
  const raw = min + fraction * (max - min);
  if (step === "any") {
    return raw;
  }
  const snapped = min + Math.round((raw - min) / step) * step;
  // Rounds away floating-point dust such as 0.30000000000000004.
  return Math.min(max, Number(snapped.toPrecision(12)));
}
