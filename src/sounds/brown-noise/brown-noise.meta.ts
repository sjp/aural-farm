import { NOISE_PARAMS } from "../param-options";
import { defineSoundMeta } from "../types";

export const brownNoiseMeta = defineSoundMeta({
  id: "brown-noise",
  name: "Brown Noise",
  description: "A deep, soft roar, like a distant waterfall or the hum of a plane cabin.",
  categories: ["Noise", "Sleep"],
  tags: ["red", "rumble", "masking", "low"],
  cost: "very low",
  tint: "#8a6a4f",
  // A touch darker than the other colours by default.
  params: { ...NOISE_PARAMS, tone: { ...NOISE_PARAMS.tone, default: -10 } },
});
