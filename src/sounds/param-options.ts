/**
 * Param definitions and option lists shared by several sounds. Sound metadata
 * modules may import this file at runtime.
 */
import type { NumberParam, SelectOption } from "./types";

/** The "Variation" param: picks the seed for a sound's random choices. */
export const SEED_PARAM = {
  kind: "number",
  label: "Variation",
  min: 0,
  max: 999,
  step: 1,
  default: 1,
} as const satisfies NumberParam;

/** Basic oscillator shapes. */
export const WAVE_OPTIONS = [
  { value: "sine", label: "Sine" },
  { value: "triangle", label: "Triangle" },
] as const satisfies readonly SelectOption[];

/** The settings every noise colour shares. */
export const NOISE_PARAMS = {
  tone: { kind: "number", label: "Tone", min: -100, max: 100, step: 1, default: 0 },
  width: { kind: "number", label: "Width", min: 0, max: 100, step: 1, default: 70, unit: "%" },
  movement: {
    kind: "number",
    label: "Movement",
    min: 0,
    max: 100,
    step: 1,
    default: 20,
    unit: "%",
  },
  seed: SEED_PARAM,
} as const satisfies Record<string, NumberParam>;
