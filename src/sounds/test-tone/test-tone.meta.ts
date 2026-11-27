import { SEED_PARAM, WAVE_OPTIONS } from "../param-options";
import { defineSoundMeta } from "../types";

export const testToneMeta = defineSoundMeta({
  id: "test-tone",
  name: "Test Tone",
  description: "A quiet, steady tone for checking the controls and the mix.",
  categories: ["Tonal"],
  tags: ["beep", "oscillator", "calibration"],
  cost: "very low",
  tint: "#888888",
  params: {
    pitch: {
      kind: "number",
      label: "Pitch",
      min: 110,
      max: 880,
      step: 1,
      default: 220,
      unit: "Hz",
      scale: "log",
    },
    wave: { kind: "select", label: "Wave", options: WAVE_OPTIONS, default: "sine" },
    soft: { kind: "boolean", label: "Soft", default: false },
    seed: SEED_PARAM,
  },
});
