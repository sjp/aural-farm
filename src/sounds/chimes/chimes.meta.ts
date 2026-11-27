import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The scale the tubes are tuned to, and what they are made of. */
const CHIME_TUNINGS = [
  { value: "major", label: "Pentatonic major" },
  { value: "minor", label: "Pentatonic minor" },
  { value: "in-scale", label: "Japanese-style in-scale" },
  { value: "bamboo", label: "Low bamboo" },
] as const;

export type ChimeTuning = (typeof CHIME_TUNINGS)[number]["value"];

/** The fewest and most tubes in a set. */
export const MIN_TUBES = 3;
export const MAX_TUBES = 8;

export const chimesMeta = defineSoundMeta({
  id: "chimes",
  name: "Wind Chimes",
  description: "Tuned metal tubes stirred into soft clusters by passing gusts.",
  categories: ["Tonal", "Nature"],
  tags: ["porch", "garden", "breeze", "bells", "meditation", "bamboo", "zen"],
  // At most 32 resonators, most of them decayed and skipped.
  cost: "low",
  tint: "#8fb3a8",
  params: {
    tuning: { kind: "select", label: "Tuning", options: CHIME_TUNINGS, default: "major" },
    tubes: { kind: "number", label: "Tubes", min: MIN_TUBES, max: MAX_TUBES, step: 1, default: 5 },
    wind: { kind: "number", label: "Wind", min: 0, max: 100, step: 1, default: 35 },
    space: { kind: "number", label: "Space", min: 0, max: 100, step: 1, default: 40 },
    seed: SEED_PARAM,
  },
});
