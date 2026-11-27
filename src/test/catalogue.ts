import type { SoundEntry } from "../sounds/registry";
import { testToneMeta } from "../sounds/test-tone/test-tone.meta";
import { defineSoundMeta } from "../sounds/types";

const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"];

/**
 * A stand-in registry for panel tests: Test Tone, then nine small sounds named
 * Alpha to India (ids "alpha" to "india"), each with one Level param.
 */
export function testCatalogue(): SoundEntry[] {
  const notLoadable = () => Promise.reject(new Error("Not loadable in tests"));
  const extra = NAMES.map((name, i): SoundEntry =>
    Object.assign(
      defineSoundMeta({
        id: name.toLowerCase(),
        name,
        description: `Test sound ${name}.`,
        categories: ["Tonal"],
        tags: [],
        cost: "very low",
        tint: `#${String(i + 1).repeat(6)}`,
        params: {
          level: { kind: "number", label: "Level", min: 0, max: 10, step: 1, default: 5 },
        },
      }),
      { load: notLoadable },
    ),
  );
  return [{ ...testToneMeta, load: notLoadable }, ...extra];
}
