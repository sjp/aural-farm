import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The kinds of fan, each with its own air, blades and motor. */
const FAN_TYPES = [
  { value: "desk", label: "Desk fan" },
  { value: "ceiling", label: "Ceiling fan" },
  { value: "box", label: "Box fan" },
  { value: "air-conditioner", label: "Air conditioner" },
] as const;

export type FanType = (typeof FAN_TYPES)[number]["value"];

export const fanMeta = defineSoundMeta({
  id: "fan",
  name: "Fan",
  description: "A fan running through the night: desk, ceiling, box or air conditioner.",
  categories: ["Machines", "Sleep"],
  // "air conditioner" and "night" are in the description already.
  tags: ["white noise", "air conditioning", "bedroom", "whir", "masking", "breeze"],
  cost: "low",
  tint: "#93a9ad",
  params: {
    type: { kind: "select", label: "Fan", options: FAN_TYPES, default: "desk" },
    speed: { kind: "number", label: "Speed", min: 0, max: 100, step: 1, default: 50 },
    tone: { kind: "number", label: "Tone", min: 0, max: 100, step: 1, default: 40 },
    motor: { kind: "number", label: "Motor", min: 0, max: 100, step: 1, default: 25 },
    oscillate: { kind: "boolean", label: "Oscillate", default: false },
    seed: SEED_PARAM,
  },
});
