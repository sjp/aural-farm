import { NOISE_PARAMS } from "../param-options";
import { defineSoundMeta } from "../types";

export const pinkNoiseMeta = defineSoundMeta({
  id: "pink-noise",
  name: "Pink Noise",
  description: "A soft, even hush, like rain on a roof.",
  categories: ["Noise", "Sleep", "Focus"],
  tags: ["masking", "balanced", "steady", "shush"],
  cost: "low",
  tint: "#d89aa8",
  params: NOISE_PARAMS,
});
