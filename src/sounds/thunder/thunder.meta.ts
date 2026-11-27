import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** How often a rumble comes: each a mean gap between rumbles. */
const THUNDER_OFTEN = [
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
  { value: "often", label: "Often" },
  { value: "storm", label: "Storm" },
] as const;

export type ThunderOften = (typeof THUNDER_OFTEN)[number]["value"];

export const thunderMeta = defineSoundMeta({
  id: "thunder",
  name: "Distant Thunder",
  description: "Rare, soft rumbles of a storm far away.",
  categories: ["Nature"],
  // "storm" and "rumbles" are in the description already.
  tags: ["thunderstorm", "lightning", "weather", "night", "rolling", "tempest"],
  // About 0.16 % of real time over a minute at defaults (one rumble), and about 0.3 %
  // in the kernel while a rumble sounds: "low".
  cost: "low",
  tint: "#5d5a85",
  params: {
    often: { kind: "select", label: "How often", options: THUNDER_OFTEN, default: "sometimes" },
    distance: { kind: "number", label: "Distance", min: 0, max: 100, step: 1, default: 15 },
    roll: { kind: "number", label: "Roll", min: 0, max: 100, step: 1, default: 50 },
    seed: SEED_PARAM,
  },
});
