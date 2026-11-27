import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The clock: its beat and the ring of its case. */
const CLOCK_TYPES = [
  { value: "mantel", label: "Mantel clock" },
  { value: "wall", label: "Wall clock" },
  { value: "grandfather", label: "Grandfather clock" },
] as const;

export type ClockType = (typeof CLOCK_TYPES)[number]["value"];

export const clockMeta = defineSoundMeta({
  id: "clock",
  name: "Ticking Clock",
  description: "The steady, gentle tick-tock of a mechanical clock in a quiet room.",
  categories: ["Cosy", "Machines"],
  // "ticking", "clock" and "room" are in the name and description already.
  tags: ["tick tock", "pendulum", "grandfather", "study", "library", "time"],
  cost: "very low",
  tint: "#b9925a",
  params: {
    clock: { kind: "select", label: "Clock", options: CLOCK_TYPES, default: "mantel" },
    tone: { kind: "number", label: "Tone", min: 0, max: 100, step: 1, default: 35 },
    room: { kind: "number", label: "Room", min: 0, max: 100, step: 1, default: 40 },
    chime: { kind: "boolean", label: "Hourly chime", default: false },
    seed: SEED_PARAM,
  },
});
