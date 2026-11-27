import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** What the wind blows past. */
const WIND_SETTINGS = [
  { value: "field", label: "Open field" },
  { value: "trees", label: "Through trees" },
  { value: "house", label: "Around a house" },
] as const;

export type WindSetting = (typeof WIND_SETTINGS)[number]["value"];

export const windMeta = defineSoundMeta({
  id: "wind",
  name: "Wind",
  description: "Wind in the open, through trees or around a house, with gusts.",
  categories: ["Nature"],
  tags: ["breeze", "gale", "storm", "draught", "blustery", "weather"],
  // About 0.59 % of real time at defaults, the shared noise and drift being 0.35 % of
  // that: "medium", like Ocean Waves.
  cost: "medium",
  tint: "#8aa0a8",
  params: {
    strength: { kind: "number", label: "Strength", min: 0, max: 100, step: 1, default: 40 },
    gustiness: { kind: "number", label: "Gusts", min: 0, max: 100, step: 1, default: 50 },
    setting: { kind: "select", label: "Setting", options: WIND_SETTINGS, default: "field" },
    whistle: { kind: "number", label: "Whistle", min: 0, max: 100, step: 1, default: 20 },
    seed: SEED_PARAM,
  },
});
