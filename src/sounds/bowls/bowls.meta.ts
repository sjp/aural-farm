import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The key the bowl set is tuned to: its deepest bowl's note, in octave 3. */
const BOWL_KEYS = [
  { value: "c", label: "C" },
  { value: "d", label: "D" },
  { value: "e", label: "E" },
  { value: "f", label: "F" },
  { value: "g", label: "G" },
  { value: "a", label: "A" },
  { value: "b", label: "B" },
] as const;

export type BowlKey = (typeof BOWL_KEYS)[number]["value"];

/** The most bowls in a set. */
export const MAX_BOWLS = 5;
/** The shortest and longest average time between strikes, in seconds. */
export const MIN_INTERVAL = 10;
export const MAX_INTERVAL = 60;

export const bowlsMeta = defineSoundMeta({
  id: "bowls",
  name: "Singing Bowls",
  description: "Struck metal bowls whose long, wavering tones hang in the air.",
  categories: ["Tonal"],
  tags: ["meditation", "bell", "gong", "mindfulness", "yoga", "calm", "resonance"],
  // At most 40 resonators, each skipped once it has died away.
  cost: "low",
  tint: "#c09a50",
  params: {
    root: { kind: "select", label: "Key", options: BOWL_KEYS, default: "d" },
    bowls: { kind: "number", label: "Bowls", min: 1, max: MAX_BOWLS, step: 1, default: 3 },
    interval: {
      kind: "number",
      label: "Strike every",
      min: MIN_INTERVAL,
      max: MAX_INTERVAL,
      step: 1,
      default: 25,
      unit: "s",
    },
    rub: { kind: "boolean", label: "Rim singing", default: false },
    space: { kind: "number", label: "Space", min: 0, max: 100, step: 1, default: 45 },
    seed: SEED_PARAM,
  },
});
