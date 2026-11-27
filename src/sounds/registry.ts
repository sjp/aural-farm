/**
 * Every sound, as metadata plus a `load()` that imports its implementation on
 * demand, so only metadata ships in the entry chunk. The array order is the
 * hand-picked "Featured" order.
 */
import type { SoundDefinition, SoundMeta } from "./types";
import { brownNoiseMeta } from "./brown-noise/brown-noise.meta";
import { greyNoiseMeta } from "./grey-noise/grey-noise.meta";
import { pinkNoiseMeta } from "./pink-noise/pink-noise.meta";
import { whiteNoiseMeta } from "./white-noise/white-noise.meta";

export interface SoundEntry extends SoundMeta {
  load: () => Promise<SoundDefinition>;
}

export const sounds: readonly SoundEntry[] = [
  {
    ...brownNoiseMeta,
    load: () => import("./brown-noise/brown-noise").then((m) => m.brownNoise),
  },
  { ...pinkNoiseMeta, load: () => import("./pink-noise/pink-noise").then((m) => m.pinkNoise) },
  {
    ...whiteNoiseMeta,
    load: () => import("./white-noise/white-noise").then((m) => m.whiteNoise),
  },
  { ...greyNoiseMeta, load: () => import("./grey-noise/grey-noise").then((m) => m.greyNoise) },
];

/** The sound a fresh visit's mix holds. */
export const DEFAULT_SOUND_ID = "brown-noise";

export function getSound(id: string): SoundEntry | undefined {
  return sounds.find((s) => s.id === id);
}
