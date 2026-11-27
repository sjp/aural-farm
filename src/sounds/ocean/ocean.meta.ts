import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** What the backwash drains over: sand fizzes, pebbles rattle as well. */
const OCEAN_SHORES = [
  { value: "sand", label: "Sand" },
  { value: "pebbles", label: "Pebbles" },
] as const;

export type OceanShore = (typeof OCEAN_SHORES)[number]["value"];

export const oceanMeta = defineSoundMeta({
  id: "ocean",
  name: "Ocean Waves",
  description: "Slow, irregular waves breaking and washing back on a shore.",
  categories: ["Nature", "Sleep"],
  tags: ["sea", "surf", "beach", "tide", "coast", "swell", "seaside"],
  // About 0.55 % of real time at defaults, a little over Rain: "medium", like it.
  cost: "medium",
  tint: "#3f8f9c",
  params: {
    period: {
      kind: "number",
      label: "Wave period",
      min: 6,
      max: 14,
      step: 0.5,
      default: 10,
      unit: "s",
    },
    size: { kind: "number", label: "Wave size", min: 0, max: 100, step: 1, default: 50 },
    distance: { kind: "number", label: "Distance", min: 0, max: 100, step: 1, default: 35 },
    shore: { kind: "select", label: "Shore", options: OCEAN_SHORES, default: "sand" },
    seed: SEED_PARAM,
  },
});
