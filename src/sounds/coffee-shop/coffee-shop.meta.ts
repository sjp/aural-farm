import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The most people talking at once. */
export const MAX_CROWD = 12;

export const coffeeShopMeta = defineSoundMeta({
  id: "coffee-shop",
  name: "Coffee Shop",
  description: "The warm murmur of a busy café, with the clink of cups.",
  categories: ["Places", "Focus", "Cosy"],
  // "murmur", "busy" and "cups" are in the description already.
  tags: ["cafe", "chatter", "crowd", "restaurant", "study", "bustle", "talk"],
  // About 0.4 % of real time at the defaults, 0.55 % with twelve people talking.
  cost: "medium",
  tint: "#a0704f",
  params: {
    crowd: { kind: "number", label: "Crowd", min: 2, max: MAX_CROWD, step: 1, default: 6 },
    clatter: { kind: "number", label: "Clatter", min: 0, max: 100, step: 1, default: 40 },
    room: { kind: "number", label: "Room size", min: 0, max: 100, step: 1, default: 55 },
    seed: SEED_PARAM,
  },
});
