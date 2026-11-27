import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The time of day: how busy the city is, and how bright its rumble. */
const CITY_TIMES = [
  { value: "night", label: "Night" },
  { value: "day", label: "Day" },
] as const;

export type CityTime = (typeof CITY_TIMES)[number]["value"];

/** How often a far-off horn or siren sounds. */
const CITY_SIGNALS = [
  { value: "off", label: "Off" },
  { value: "rare", label: "Rare" },
  { value: "occasional", label: "Occasional" },
] as const;

export type CitySignals = (typeof CITY_SIGNALS)[number]["value"];

export const cityMeta = defineSoundMeta({
  id: "city",
  name: "Distant City",
  description: "The far-off rumble of a city, with the odd car passing below.",
  categories: ["Places"],
  // "city", "rumble" and "car" are in the name and description already.
  tags: ["urban", "traffic", "night", "window", "balcony", "street", "town"],
  cost: "low",
  tint: "#b08a5a",
  params: {
    time: { kind: "select", label: "Time", options: CITY_TIMES, default: "night" },
    traffic: { kind: "number", label: "Traffic", min: 0, max: 100, step: 1, default: 50 },
    rumble: { kind: "number", label: "Rumble", min: 0, max: 100, step: 1, default: 60 },
    signals: { kind: "select", label: "Horns, sirens", options: CITY_SIGNALS, default: "off" },
    space: { kind: "number", label: "Space", min: 0, max: 100, step: 1, default: 50 },
    seed: SEED_PARAM,
  },
});
