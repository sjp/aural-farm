import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The heart rate's range, in beats per minute. */
export const MIN_RATE = 50;
export const MAX_RATE = 90;

export const heartbeatMeta = defineSoundMeta({
  id: "heartbeat",
  name: "Heartbeat",
  description: "A slow, muffled heartbeat with the gentle whoosh of blood flow.",
  categories: ["Sleep"],
  tags: ["baby", "womb", "pulse", "infant", "newborn", "lullaby", "calm"],
  // Two short voices a second and a filtered noise, from one worklet.
  cost: "very low",
  tint: "#b06a6a",
  params: {
    rate: {
      kind: "number",
      label: "Rate",
      min: MIN_RATE,
      max: MAX_RATE,
      step: 1,
      default: 64,
      unit: "bpm",
    },
    muffle: { kind: "number", label: "Muffle", min: 0, max: 100, step: 1, default: 65 },
    bed: { kind: "number", label: "Flow", min: 0, max: 100, step: 1, default: 50 },
    seed: SEED_PARAM,
  },
});
