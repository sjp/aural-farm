import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** What the rain lands on: each sets how the drops sound and shapes the wash. */
export const RAIN_SURFACES = [
  { value: "ground", label: "Open ground" },
  { value: "leaves", label: "Leaves" },
  { value: "roof", label: "Roof" },
  { value: "window", label: "Window" },
  { value: "tent", label: "Tent" },
] as const;

export type RainSurface = (typeof RAIN_SURFACES)[number]["value"];

export const rainMeta = defineSoundMeta({
  id: "rain",
  name: "Rain",
  description: "Steady rain on open ground, leaves, a roof, a window or a tent.",
  categories: ["Nature", "Sleep", "Cosy"],
  tags: ["storm", "drizzle", "downpour", "shower", "patter", "drops", "weather"],
  // About 0.5–0.6 % of real time at defaults: a little over a plain noise colour.
  cost: "medium",
  tint: "#6f8aa3",
  params: {
    intensity: {
      kind: "number",
      label: "Intensity",
      min: 0,
      max: 100,
      step: 1,
      default: 45,
      unit: "%",
    },
    surface: { kind: "select", label: "Surface", options: RAIN_SURFACES, default: "ground" },
    distance: { kind: "number", label: "Distance", min: 0, max: 100, step: 1, default: 30 },
    bubbles: { kind: "number", label: "Plinks", min: 0, max: 100, step: 1, default: 40, unit: "%" },
    seed: SEED_PARAM,
  },
});
