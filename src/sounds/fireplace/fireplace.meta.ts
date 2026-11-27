import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** What burns: softwood pops more and hisses with sap. */
const FIREPLACE_WOODS = [
  { value: "hardwood", label: "Hardwood" },
  { value: "softwood", label: "Softwood" },
] as const;

export const fireplaceMeta = defineSoundMeta({
  id: "fireplace",
  name: "Fireplace",
  description: "A crackling wood fire with the odd pop and hiss of sap.",
  categories: ["Cosy", "Nature"],
  // "fire" and "crackling" are in the description already.
  tags: ["hearth", "logs", "embers", "flames", "cabin", "winter", "campfire"],
  // About 0.47 % of real time at defaults, just inside "low".
  cost: "low",
  tint: "#c4703a",
  params: {
    size: { kind: "number", label: "Fire", min: 0, max: 100, step: 1, default: 55 },
    crackle: {
      kind: "number",
      label: "Crackle",
      min: 0,
      max: 100,
      step: 1,
      default: 50,
      unit: "%",
    },
    wood: { kind: "select", label: "Wood", options: FIREPLACE_WOODS, default: "hardwood" },
    room: { kind: "number", label: "Room", min: 0, max: 100, step: 1, default: 35 },
    seed: SEED_PARAM,
  },
});
