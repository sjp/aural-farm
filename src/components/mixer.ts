/** Small helpers shared by the mixer's rows and panel. */

/** The id of a layer's name, which takes focus when the row is added or its neighbour removed. */
export const layerNameId = (id: string) => `layer-${id}-name`;

/** Maps an RMS level to a tint dot's brightness, 0–1: −60 dBFS and below is dark, −12 dBFS full. */
export function levelBrightness(rms: number): number {
  if (!(rms > 0)) {
    return 0;
  }
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 48));
}
