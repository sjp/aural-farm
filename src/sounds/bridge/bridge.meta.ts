import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** How busy the consoles are: each a mean rate of console phrases. */
const BRIDGE_ACTIVITY = [
  { value: "quiet", label: "Quiet" },
  { value: "normal", label: "Normal" },
  { value: "busy", label: "Busy" },
] as const;

export type BridgeActivity = (typeof BRIDGE_ACTIVITY)[number]["value"];

/** How often a door opens: each a mean rate of doors. */
const BRIDGE_DOORS = [
  { value: "off", label: "Off" },
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
] as const;

export type BridgeDoors = (typeof BRIDGE_DOORS)[number]["value"];

export const bridgeMeta = defineSoundMeta({
  id: "bridge",
  name: "Starship Bridge",
  description:
    "A quiet starship bridge: warm room tone, distant engines and the odd soft console chirp.",
  categories: ["Sci-fi", "Places"],
  // "console" and "starship" are in the description and name already.
  tags: ["spaceship", "computer", "beeps", "command deck", "space", "control room"],
  cost: "low",
  tint: "#8a7fd0",
  params: {
    activity: { kind: "select", label: "Activity", options: BRIDGE_ACTIVITY, default: "normal" },
    engine: { kind: "number", label: "Engine hum", min: 0, max: 100, step: 1, default: 35 },
    air: { kind: "number", label: "Ventilation", min: 0, max: 100, step: 1, default: 50 },
    doors: { kind: "select", label: "Doors", options: BRIDGE_DOORS, default: "off" },
    alert: { kind: "boolean", label: "Alert", default: false },
    seed: SEED_PARAM,
  },
});
