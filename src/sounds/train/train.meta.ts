import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The track: jointed rails clack at every joint, welded rails run smooth. */
const TRAIN_TRACKS = [
  { value: "jointed", label: "Jointed track (clackety)" },
  { value: "welded", label: "Welded track (smooth)" },
] as const;

export type TrainTrack = (typeof TRAIN_TRACKS)[number]["value"];

/** How often the train rattles over points. */
const TRAIN_POINTS = [
  { value: "off", label: "Off" },
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
] as const;

export type TrainPoints = (typeof TRAIN_POINTS)[number]["value"];

export const trainMeta = defineSoundMeta({
  id: "train",
  name: "Train Carriage",
  description: "Inside a train carriage: steady rumble and the gentle rhythm of the rails.",
  categories: ["Places", "Machines"],
  // "train", "carriage" and "rails" are in the name and description already.
  tags: ["railway", "rail", "journey", "travel", "clickety-clack", "sleeper"],
  cost: "low",
  tint: "#94806a",
  params: {
    speed: {
      kind: "number",
      label: "Speed",
      min: 40,
      max: 160,
      step: 1,
      default: 90,
      unit: "km/h",
    },
    track: { kind: "select", label: "Track", options: TRAIN_TRACKS, default: "jointed" },
    clacks: { kind: "number", label: "Clacks", min: 0, max: 100, step: 1, default: 55 },
    points: { kind: "select", label: "Points", options: TRAIN_POINTS, default: "rarely" },
    seed: SEED_PARAM,
  },
});
