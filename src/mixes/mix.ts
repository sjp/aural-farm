/**
 * The mix: up to `MAX_LAYERS` sounds, each with its own volume, mute and params,
 * under a master volume. The whole mix lives in the URL hash:
 *
 *   #master=60&layers=a,b&a.volume=80&a.pitch=330&b.muted=1&panel=hidden
 *
 * `panel=hidden` isn't part of the mix but is read and written alongside it.
 */
import { coerce, defaults, parseParams, serialiseParams } from "../sounds/params";
import { DEFAULT_SOUND_ID, sounds } from "../sounds/registry";
import type { NumberParam, ParamValues, SoundMeta } from "../sounds/types";

export const MAX_LAYERS = 8;

/** A layer's volume, 0–100. */
export const VOLUME_PARAM = {
  kind: "number",
  label: "Volume",
  min: 0,
  max: 100,
  step: 1,
  default: 70,
} as const satisfies NumberParam;

/** The master volume, 0–100. */
const MASTER_PARAM = {
  ...VOLUME_PARAM,
  label: "Master volume",
} as const satisfies NumberParam;

export interface Layer {
  /** The sound's id; a mix holds each sound at most once. */
  id: string;
  volume: number;
  muted: boolean;
  params: ParamValues;
}

export interface Mix {
  master: number;
  layers: Layer[];
  name?: string;
}

/** Everything the URL hash holds. */
export interface HashState {
  mix: Mix;
  panelHidden: boolean;
}

/** The sounds a mix can use: the registry, or a stand-in in tests. */
type Catalogue = readonly Pick<SoundMeta, "id" | "params">[];

export function defaultLayer(sound: Pick<SoundMeta, "id" | "params">): Layer {
  return {
    id: sound.id,
    volume: VOLUME_PARAM.default,
    muted: false,
    params: defaults(sound.params),
  };
}

/** A fresh visit's mix: the default sound alone, at its defaults. */
export function defaultMix(catalogue: Catalogue = sounds, defaultId = DEFAULT_SOUND_ID): Mix {
  const sound = catalogue.find((s) => s.id === defaultId);
  return { master: MASTER_PARAM.default, layers: sound ? [defaultLayer(sound)] : [] };
}

/**
 * Reads the hash. Unknown sounds, repeats and layers past `MAX_LAYERS` are dropped;
 * every value is coerced, and a missing or invalid one takes its default. With no
 * `layers` key at all, the mix is the default mix; `layers=` is an empty one.
 */
export function parseHash(
  hash: string,
  catalogue: Catalogue = sounds,
  defaultId = DEFAULT_SOUND_ID,
): HashState {
  const query = new URLSearchParams(hash.replace(/^#/, ""));
  const panelHidden = query.get("panel") === "hidden";
  const layerList = query.get("layers");
  if (layerList === null) {
    return { mix: defaultMix(catalogue, defaultId), panelHidden };
  }
  const chosen: Pick<SoundMeta, "id" | "params">[] = [];
  for (const id of layerList.split(",")) {
    const sound = catalogue.find((s) => s.id === id.trim());
    if (sound && !chosen.includes(sound) && chosen.length < MAX_LAYERS) {
      chosen.push(sound);
    }
  }
  // Each layer's raw values, by key; the first occurrence of a key wins.
  const raw = new Map(chosen.map((s) => [s.id, new Map<string, string>()]));
  for (const [key, value] of query) {
    const dot = key.indexOf(".");
    const values = dot > 0 ? raw.get(key.slice(0, dot)) : undefined;
    const name = key.slice(dot + 1);
    if (values && !values.has(name)) {
      values.set(name, value);
    }
  }
  const layers = chosen.map((sound): Layer => {
    const values = raw.get(sound.id) ?? new Map<string, string>();
    return {
      id: sound.id,
      volume: Number(coerce(VOLUME_PARAM, values.get("volume"))),
      muted: values.get("muted") === "1",
      params: parseParams(sound.params, values),
    };
  });
  return {
    mix: { master: Number(coerce(MASTER_PARAM, query.get("master") ?? undefined)), layers },
    panelHidden,
  };
}

/** Percent-encodes a hash key or value, keeping commas readable. */
function encode(text: string): string {
  return encodeURIComponent(text).replaceAll("%2C", ",");
}

/**
 * Writes the hash (with its leading `#`). The live form writes only values that
 * differ from their defaults, so it stays short; the `full` form, used for shared
 * links, spells out every value so the link keeps its sound if a default changes.
 */
export function serialiseHash(
  state: HashState,
  options: { full?: boolean } = {},
  catalogue: Catalogue = sounds,
): string {
  const full = options.full === true;
  const pairs: [string, string][] = [];
  const { mix } = state;
  if (full || mix.master !== MASTER_PARAM.default) {
    pairs.push(["master", String(mix.master)]);
  }
  pairs.push(["layers", mix.layers.map((l) => l.id).join(",")]);
  for (const layer of mix.layers) {
    const sound = catalogue.find((s) => s.id === layer.id);
    if (full || layer.volume !== VOLUME_PARAM.default) {
      pairs.push([`${layer.id}.volume`, String(layer.volume)]);
    }
    if (full || layer.muted) {
      pairs.push([`${layer.id}.muted`, layer.muted ? "1" : "0"]);
    }
    if (sound) {
      for (const [key, value] of serialiseParams(sound.params, layer.params, full)) {
        pairs.push([`${layer.id}.${key}`, value]);
      }
    }
  }
  if (state.panelHidden) {
    pairs.push(["panel", "hidden"]);
  }
  return `#${pairs.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&")}`;
}
