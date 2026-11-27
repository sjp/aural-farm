import { NOISE_PARAMS } from "../param-options";
import { defineSoundMeta } from "../types";

export const greyNoiseMeta = defineSoundMeta({
  id: "grey-noise",
  name: "Grey Noise",
  description: "A full, rounded hush that sounds about equally loud from low to high.",
  categories: ["Noise"],
  tags: ["gray", "equal-loudness", "masking", "neutral"],
  cost: "very low",
  tint: "#9a9aa6",
  params: NOISE_PARAMS,
});
