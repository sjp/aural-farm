import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The beat's presets, named by the frequency band each falls in, and Custom. */
const BEAT_PRESETS = [
  { value: "delta", label: "Delta 2 Hz" },
  { value: "theta", label: "Theta 6 Hz" },
  { value: "alpha", label: "Alpha 10 Hz" },
  { value: "beta", label: "Beta 18 Hz" },
  { value: "custom", label: "Custom" },
] as const;

export type BeatPreset = (typeof BEAT_PRESETS)[number]["value"];

const MODES = [
  { value: "binaural", label: "Binaural (headphones)" },
  { value: "isochronic", label: "Isochronic (no headphones)" },
] as const;

export type BinauralMode = (typeof MODES)[number]["value"];

export const binauralMeta = defineSoundMeta({
  id: "binaural",
  name: "Binaural Beats",
  description: "Two steady tones, one in each ear, that blend into a slow pulse.",
  categories: ["Tonal", "Focus"],
  tags: ["headphones", "sine", "isochronic", "stereo", "oscillator", "hertz"],
  // Two native oscillators and the shared noise worklet's stereo pink for the bed,
  // which costs most of it (about 0.24 % in all; 0.18 % with a mono bed).
  cost: "low",
  tint: "#6a9bc0",
  hint: "Use headphones",
  params: {
    preset: { kind: "select", label: "Beat", options: BEAT_PRESETS, default: "alpha" },
    beat: {
      kind: "number",
      label: "Custom beat",
      min: 1,
      max: 30,
      step: 0.1,
      default: 10,
      unit: "Hz",
    },
    carrier: {
      kind: "number",
      label: "Tone",
      min: 100,
      max: 400,
      step: 1,
      default: 200,
      unit: "Hz",
      scale: "log",
    },
    mode: { kind: "select", label: "Mode", options: MODES, default: "binaural" },
    bed: { kind: "number", label: "Noise bed", min: 0, max: 100, step: 1, default: 20 },
    seed: SEED_PARAM,
  },
});
