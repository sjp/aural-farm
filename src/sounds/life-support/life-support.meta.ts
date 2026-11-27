import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** How often a valve releases: each a mean rate of valve events. */
const LIFE_SUPPORT_VALVES = [
  { value: "off", label: "Off" },
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
  { value: "often", label: "Often" },
] as const;

export type LifeSupportValves = (typeof LIFE_SUPPORT_VALVES)[number]["value"];

export const lifeSupportMeta = defineSoundMeta({
  id: "life-support",
  name: "Life Support",
  description:
    "A space station's air recycler: steady airflow, slow pump cycles and the odd soft valve hiss.",
  categories: ["Sci-fi", "Machines"],
  // "space station", "air recycler", "pump" and "hiss" are in the description already.
  tags: ["spaceship", "ventilation", "plant room", "machinery", "oxygen", "hum"],
  cost: "low",
  tint: "#4fa092",
  params: {
    flow: { kind: "number", label: "Air flow", min: 0, max: 100, step: 1, default: 60 },
    pump: { kind: "number", label: "Pump", min: 0, max: 100, step: 1, default: 45 },
    pumpCycle: {
      kind: "number",
      label: "Pump cycle",
      min: 15,
      max: 60,
      step: 1,
      default: 28,
      unit: "s",
    },
    valves: { kind: "select", label: "Valves", options: LIFE_SUPPORT_VALVES, default: "rarely" },
    hum: { kind: "number", label: "Hum", min: 0, max: 100, step: 1, default: 25 },
    seed: SEED_PARAM,
  },
});
