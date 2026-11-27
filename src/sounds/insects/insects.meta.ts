import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The most crickets near enough to pick out. */
export const MAX_CRICKETS = 12;

export const insectsMeta = defineSoundMeta({
  id: "insects",
  name: "Night Insects",
  description: "Crickets chirping on a warm summer night.",
  categories: ["Nature", "Sleep"],
  // "crickets", "chirping" and "summer" are in the description already.
  tags: ["evening", "countryside", "meadow", "katydid", "grasshopper", "outdoors"],
  cost: "low",
  tint: "#6c8f4e",
  params: {
    count: { kind: "number", label: "Crickets", min: 1, max: MAX_CRICKETS, step: 1, default: 5 },
    warmth: {
      kind: "number",
      label: "Warmth",
      min: 12,
      max: 28,
      step: 0.5,
      default: 20,
      unit: "°C",
    },
    distance: { kind: "number", label: "Distance", min: 0, max: 100, step: 1, default: 40 },
    katydids: { kind: "boolean", label: "Katydids", default: false },
    seed: SEED_PARAM,
  },
});
