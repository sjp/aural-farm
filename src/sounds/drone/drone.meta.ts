import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The key every voicing is rooted on. */
const DRONE_KEYS = [
  { value: "c", label: "C" },
  { value: "cs", label: "C♯" },
  { value: "d", label: "D" },
  { value: "eb", label: "E♭" },
  { value: "e", label: "E" },
  { value: "f", label: "F" },
  { value: "fs", label: "F♯" },
  { value: "g", label: "G" },
  { value: "ab", label: "A♭" },
  { value: "a", label: "A" },
  { value: "bb", label: "B♭" },
  { value: "b", label: "B" },
] as const;

export type DroneKey = (typeof DRONE_KEYS)[number]["value"];

export const droneMeta = defineSoundMeta({
  id: "drone",
  name: "Drone Pad",
  description: "A warm, slowly shifting chord that drifts under everything else.",
  categories: ["Tonal", "Focus"],
  tags: ["ambient", "synth", "meditation", "atmosphere", "harmony"],
  // Thirty wave-table voices, only half of them sounding between chord changes.
  cost: "low",
  tint: "#7a6fb0",
  params: {
    key: { kind: "select", label: "Key", options: DRONE_KEYS, default: "d" },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 100, step: 1, default: 35 },
    movement: { kind: "number", label: "Movement", min: 0, max: 100, step: 1, default: 40 },
    space: { kind: "number", label: "Space", min: 0, max: 100, step: 1, default: 55 },
    seed: SEED_PARAM,
  },
});
