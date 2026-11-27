import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

export const quartersMeta = defineSoundMeta({
  id: "quarters",
  name: "Crew Quarters",
  description:
    "A starship cabin at night: soft vent rumble and a faint engine hum through the hull.",
  categories: ["Sci-fi", "Sleep", "Cosy"],
  // "cabin", "night", "rumble" and "hull" are in the description already.
  tags: ["spaceship", "bunk", "berth", "bedroom", "space", "dark"],
  cost: "low",
  tint: "#7a6a9e",
  params: {
    air: { kind: "number", label: "Ventilation", min: 0, max: 100, step: 1, default: 60 },
    hum: { kind: "number", label: "Engine hum", min: 0, max: 100, step: 1, default: 35 },
    hull: { kind: "number", label: "Hull", min: 0, max: 100, step: 1, default: 40 },
    warmth: { kind: "number", label: "Warmth", min: 0, max: 100, step: 1, default: 60 },
    seed: SEED_PARAM,
  },
});
