/**
 * Every sound, as metadata plus a `load()` that imports its implementation on
 * demand, so only metadata ships in the entry chunk. The array order is the
 * hand-picked "Featured" order.
 */
import type { SoundDefinition, SoundMeta } from "./types";
import { testToneMeta } from "./test-tone/test-tone.meta";

interface SoundEntry extends SoundMeta {
  load: () => Promise<SoundDefinition>;
}

export const sounds: readonly SoundEntry[] = [
  { ...testToneMeta, load: () => import("./test-tone/test-tone").then((m) => m.testTone) },
];

/** The sound a fresh visit's mix holds. */
export const DEFAULT_SOUND_ID = "test-tone";

export function getSound(id: string): SoundEntry | undefined {
  return sounds.find((s) => s.id === id);
}
