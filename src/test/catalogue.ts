import { SEED_PARAM } from "../sounds/param-options";
import type { SoundEntry } from "../sounds/registry";
import { defineSoundMeta } from "../sounds/types";

/** The test catalogue's default sound: the id a hash without `layers` holds. */
export const TEST_TONE_ID = "test-tone";

/** A stand-in sound with one param of each kind: a log slider, a select and a toggle. */
const testToneMeta = defineSoundMeta({
  id: TEST_TONE_ID,
  name: "Test Tone",
  description: "A quiet, steady tone for checking the controls and the mix.",
  categories: ["Tonal"],
  tags: ["beep", "oscillator", "calibration"],
  cost: "very low",
  tint: "#888888",
  params: {
    pitch: {
      kind: "number",
      label: "Pitch",
      min: 110,
      max: 880,
      step: 1,
      default: 220,
      unit: "Hz",
      scale: "log",
    },
    wave: {
      kind: "select",
      label: "Wave",
      options: [
        { value: "sine", label: "Sine" },
        { value: "triangle", label: "Triangle" },
      ],
      default: "sine",
    },
    soft: { kind: "boolean", label: "Soft", default: false },
    seed: SEED_PARAM,
  },
});

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
