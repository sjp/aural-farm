/** Small helpers shared by the mixer's rows and panel. */
import { MAX_LAYERS } from "../mixes/mix";
import type { SoundEntry } from "../sounds/registry";

/** Says why no more sounds can be added to a full mix. */
export const FULL_MIX_HINT = `${String(MAX_LAYERS)} sounds is the most a mix can hold`;

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

/** The peek bar's summary of a mix: its sounds' names joined with " + ". */
export function mixSummary(
  layers: readonly { id: string }[],
  sounds: readonly SoundEntry[],
): string {
  const names = layers.flatMap((layer) => sounds.find((s) => s.id === layer.id)?.name ?? []);
  return names.length === 0 ? "No sounds yet" : names.join(" + ");
}
