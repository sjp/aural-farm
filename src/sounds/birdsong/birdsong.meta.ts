import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The times of day, busiest first: each sets how many birds sing and how often. */
export const BIRDSONG_TIMES = [
  { value: "dawn", label: "Dawn chorus" },
  { value: "morning", label: "Morning" },
  { value: "day", label: "Daytime" },
] as const;

export type BirdsongTime = (typeof BIRDSONG_TIMES)[number]["value"];

export const birdsongMeta = defineSoundMeta({
  id: "birdsong",
  name: "Birdsong",
  description: "Songbirds singing nearby and far off, from a dawn chorus to a quiet afternoon.",
  categories: ["Nature"],
  // "dawn" and "chorus" are in the description already.
  tags: ["birds", "morning", "garden", "spring", "woodland", "tweeting"],
  // About 0.32 % of real time at defaults, 0.4 % for a dawn chorus at full activity.
  cost: "low",
  tint: "#b5a24a",
  params: {
    time: { kind: "select", label: "Time of day", options: BIRDSONG_TIMES, default: "morning" },
    density: { kind: "number", label: "Activity", min: 0, max: 100, step: 1, default: 50 },
    distance: { kind: "number", label: "Distance", min: 0, max: 100, step: 1, default: 40 },
    seed: SEED_PARAM,
  },
});
