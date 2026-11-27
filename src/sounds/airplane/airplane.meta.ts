import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** Where the seat is: the balance of airflow and engine noise. */
const AIRPLANE_SEATS = [
  { value: "front", label: "Front" },
  { value: "wing", label: "Over wing" },
  { value: "rear", label: "Rear" },
] as const;

export type AirplaneSeat = (typeof AIRPLANE_SEATS)[number]["value"];

/** How often a soft cabin chime sounds. */
const AIRPLANE_CHIMES = [
  { value: "off", label: "Off" },
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
] as const;

export type AirplaneChime = (typeof AIRPLANE_CHIMES)[number]["value"];

export const airplaneMeta = defineSoundMeta({
  id: "airplane",
  name: "Airplane Cabin",
  description:
    "The steady roar of a jet cabin at cruise, with faint engine hum and an overhead air vent.",
  categories: ["Places", "Sleep", "Machines"],
  // "jet", "cabin" and "engine" are in the name and description already.
  tags: ["flight", "plane", "travel", "red-eye", "brown noise", "airliner"],
  cost: "low",
  tint: "#6d8fb5",
  params: {
    seat: { kind: "select", label: "Seat", options: AIRPLANE_SEATS, default: "wing" },
    engines: { kind: "number", label: "Engines", min: 0, max: 100, step: 1, default: 30 },
    vent: { kind: "number", label: "Air vent", min: 0, max: 100, step: 1, default: 35 },
    chime: { kind: "select", label: "Chime", options: AIRPLANE_CHIMES, default: "off" },
    seed: SEED_PARAM,
  },
});
