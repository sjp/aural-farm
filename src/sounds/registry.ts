/**
 * Every sound, as metadata plus a `load()` that imports its implementation on
 * demand, so only metadata ships in the entry chunk. The array order is the
 * hand-picked "Featured" order.
 */
import type { SoundDefinition, SoundMeta } from "./types";
import { airplaneMeta } from "./airplane/airplane.meta";
import { binauralMeta } from "./binaural/binaural.meta";
import { birdsongMeta } from "./birdsong/birdsong.meta";
import { bridgeMeta } from "./bridge/bridge.meta";
import { cityMeta } from "./city/city.meta";
import { bowlsMeta } from "./bowls/bowls.meta";
import { brownNoiseMeta } from "./brown-noise/brown-noise.meta";
import { chimesMeta } from "./chimes/chimes.meta";
import { clockMeta } from "./clock/clock.meta";
import { coffeeShopMeta } from "./coffee-shop/coffee-shop.meta";
import { droneMeta } from "./drone/drone.meta";
import { engineCoreMeta } from "./engine-core/engine-core.meta";
import { fanMeta } from "./fan/fan.meta";
import { fireplaceMeta } from "./fireplace/fireplace.meta";
import { greyNoiseMeta } from "./grey-noise/grey-noise.meta";
import { insectsMeta } from "./insects/insects.meta";
import { lifeSupportMeta } from "./life-support/life-support.meta";
import { oceanMeta } from "./ocean/ocean.meta";
import { pinkNoiseMeta } from "./pink-noise/pink-noise.meta";
import { quartersMeta } from "./quarters/quarters.meta";
import { rainMeta } from "./rain/rain.meta";
import { serverRoomMeta } from "./server-room/server-room.meta";
import { streamMeta } from "./stream/stream.meta";
import { thunderMeta } from "./thunder/thunder.meta";
import { trainMeta } from "./train/train.meta";
import { whiteNoiseMeta } from "./white-noise/white-noise.meta";
import { windMeta } from "./wind/wind.meta";

export interface SoundEntry extends SoundMeta {
  load: () => Promise<SoundDefinition>;
}

export const sounds: readonly SoundEntry[] = [
  {
    ...engineCoreMeta,
    load: () => import("./engine-core/engine-core").then((m) => m.engineCore),
  },
  { ...bridgeMeta, load: () => import("./bridge/bridge").then((m) => m.bridge) },
  { ...quartersMeta, load: () => import("./quarters/quarters").then((m) => m.quarters) },
  {
    ...lifeSupportMeta,
    load: () => import("./life-support/life-support").then((m) => m.lifeSupport),
  },
  { ...fanMeta, load: () => import("./fan/fan").then((m) => m.fan) },
  {
    ...serverRoomMeta,
    load: () => import("./server-room/server-room").then((m) => m.serverRoom),
  },
  { ...airplaneMeta, load: () => import("./airplane/airplane").then((m) => m.airplane) },
  { ...trainMeta, load: () => import("./train/train").then((m) => m.train) },
  { ...cityMeta, load: () => import("./city/city").then((m) => m.city) },
  {
    ...coffeeShopMeta,
    load: () => import("./coffee-shop/coffee-shop").then((m) => m.coffeeShop),
  },
  { ...rainMeta, load: () => import("./rain/rain").then((m) => m.rain) },
  { ...oceanMeta, load: () => import("./ocean/ocean").then((m) => m.ocean) },
  { ...streamMeta, load: () => import("./stream/stream").then((m) => m.stream) },
  { ...birdsongMeta, load: () => import("./birdsong/birdsong").then((m) => m.birdsong) },
  { ...insectsMeta, load: () => import("./insects/insects").then((m) => m.insects) },
  {
    ...fireplaceMeta,
    load: () => import("./fireplace/fireplace").then((m) => m.fireplace),
  },
  { ...clockMeta, load: () => import("./clock/clock").then((m) => m.clock) },
  { ...windMeta, load: () => import("./wind/wind").then((m) => m.wind) },
  { ...chimesMeta, load: () => import("./chimes/chimes").then((m) => m.chimes) },
  { ...bowlsMeta, load: () => import("./bowls/bowls").then((m) => m.bowls) },
  { ...droneMeta, load: () => import("./drone/drone").then((m) => m.drone) },
  { ...binauralMeta, load: () => import("./binaural/binaural").then((m) => m.binaural) },
  { ...thunderMeta, load: () => import("./thunder/thunder").then((m) => m.thunder) },
  {
    ...brownNoiseMeta,
    load: () => import("./brown-noise/brown-noise").then((m) => m.brownNoise),
  },
  { ...pinkNoiseMeta, load: () => import("./pink-noise/pink-noise").then((m) => m.pinkNoise) },
  {
    ...whiteNoiseMeta,
    load: () => import("./white-noise/white-noise").then((m) => m.whiteNoise),
  },
  { ...greyNoiseMeta, load: () => import("./grey-noise/grey-noise").then((m) => m.greyNoise) },
];

/** The sound a fresh visit's mix holds. */
export const DEFAULT_SOUND_ID = "engine-core";

if (!sounds.some((s) => s.id === DEFAULT_SOUND_ID)) {
  throw new Error(`The default sound "${DEFAULT_SOUND_ID}" isn't registered`);
}

export function getSound(id: string): SoundEntry | undefined {
  return sounds.find((s) => s.id === id);
}
