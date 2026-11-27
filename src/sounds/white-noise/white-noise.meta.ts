import { NOISE_PARAMS } from "../param-options";
import { defineSoundMeta } from "../types";

export const whiteNoiseMeta = defineSoundMeta({
  id: "white-noise",
  name: "White Noise",
  description: "A bright, airy hiss, like an untuned radio.",
  categories: ["Noise", "Focus"],
  tags: ["static", "masking", "tinnitus", "shush"],
  cost: "low",
  tint: "#d8d8d8",
  params: NOISE_PARAMS,
});
