/**
 * Equal-power panning: the left and right gains for a position from −1 (left) to
 * 1 (right), whose squares sum to 1, so a voice keeps its loudness as it moves.
 * At the centre both are √½ (−3 dB).
 */

const angle = (pan: number) => ((Math.min(1, Math.max(-1, pan)) + 1) * Math.PI) / 4;

export function panLeft(pan: number): number {
  return Math.cos(angle(pan));
}

export function panRight(pan: number): number {
  return Math.sin(angle(pan));
}
