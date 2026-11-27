import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

export const streamMeta = defineSoundMeta({
  id: "stream",
  name: "Stream",
  description: "A babbling brook or a broad river running over stones.",
  categories: ["Nature", "Focus"],
  // "brook", "river" and "babbling" are in the description already.
  tags: ["creek", "beck", "burn", "water", "trickle", "forest"],
  // About 0.57 % of real time at defaults, 1.15 % for a fast river: its bubble voices.
  cost: "medium",
  tint: "#4fa39a",
  params: {
    flow: { kind: "number", label: "Flow", min: 0, max: 100, step: 1, default: 45, unit: "%" },
    size: { kind: "number", label: "Size", min: 0, max: 100, step: 1, default: 30 },
    distance: { kind: "number", label: "Distance", min: 0, max: 100, step: 1, default: 25 },
    seed: SEED_PARAM,
  },
});
