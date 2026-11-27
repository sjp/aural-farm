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
