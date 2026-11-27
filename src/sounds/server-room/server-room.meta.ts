import { SEED_PARAM } from "../param-options";
import { defineSoundMeta } from "../types";

/** The most racks of fans, each a fan tone of its own. */
export const MAX_RACKS = 12;

export const serverRoomMeta = defineSoundMeta({
  id: "server-room",
  name: "Server Room",
  description: "The dense, shimmering fan roar of a room full of servers.",
  categories: ["Machines", "Focus", "Sci-fi"],
  // "fans" and "servers" are in the description already.
  tags: ["data centre", "computers", "datacenter", "hum", "office", "white noise"],
  cost: "low",
  tint: "#5f9e6e",
  params: {
    airflow: { kind: "number", label: "Airflow", min: 0, max: 100, step: 1, default: 60 },
    racks: { kind: "number", label: "Racks", min: 1, max: MAX_RACKS, step: 1, default: 6 },
    hvac: { kind: "number", label: "Cooling", min: 0, max: 100, step: 1, default: 45 },
    whine: { kind: "number", label: "Whine", min: 0, max: 100, step: 1, default: 15 },
    disks: { kind: "boolean", label: "Disk ticks", default: false },
    seed: SEED_PARAM,
  },
});
