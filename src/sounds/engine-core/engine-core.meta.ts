import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

export const engineCoreMeta = defineSoundMeta({
  id: "engine-core",
  name: "Starship Engine Core",
  description: "The deep, steady hum and slow throb of a starship's engine room.",
  categories: ["Sci-fi", "Machines"],
  tags: ["warp", "reactor", "spaceship", "drone", "pulse", "rumble"],
  cost: "medium",
  tint: "#4f7fd8",
  params: {
    power: { kind: "number", label: "Power", min: 0, max: 100, step: 1, default: 55, unit: "%" },
    pitch: {
      kind: "number",
      label: "Pitch",
      min: 32,
      max: 72,
      step: 0.5,
      default: 48,
      unit: "Hz",
      scale: "log",
    },
    pulseRate: {
      kind: "number",
      label: "Pulse rate",
      min: 0.3,
      max: 1.6,
      step: 0.01,
      default: 0.82,
      unit: "Hz",
    },
    pulseDepth: {
      kind: "number",
      label: "Pulse depth",
      min: 0,
      max: 100,
      step: 1,
      default: 45,
      unit: "%",
    },
    room: { kind: "number", label: "Room", min: 0, max: 100, step: 1, default: 40, unit: "%" },
    hiss: { kind: "number", label: "Hiss", min: 0, max: 100, step: 1, default: 30, unit: "%" },
    seed: SEED_PARAM,
  },
});
