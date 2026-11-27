/**
 * The backdrop's colours: each layer's tint, weighted by how loud the mixer makes
 * it, turned into the colours of a few soft pools of light.
 */
import { layerGain } from "../audio/mix-graph";
import type { Mix } from "../mixes/mix";

/** A colour as red, green and blue in 0–1 (sRGB, as CSS gives it). */
export type Rgb = readonly [number, number, number];

/** A tint and how much of it there is: the layer's effective gain. */
interface TintWeight {
  tint: string;
  gain: number;
}

/** One pool's colour and how strongly it shines, 0–1. */
export interface PoolColour {
  colour: Rgb;
  strength: number;
}

/** The backdrop always shows at least this many pools… */
export const MIN_POOLS = 3;
/** …and at most this many: past it, the closest tints share a pool. */
export const MAX_POOLS = 5;

/** How much of its colour a pool shows at the default Brightness, in Glow. */
const DEFAULT_GAIN = 0.3;

/** What an empty or paused mix fades to: a grey that shows as about #202024 at the default Brightness. */
export const NEUTRAL: Rgb = scaleRgb(parseHex("#202024"), 1 / DEFAULT_GAIN);

/** A mix whose gains add up to this much (one layer at volume 50) shows its tints fully. */
const FULL_PRESENCE_GAIN = 0.25;
/** The weakest pool still shines this strongly, relative to the strongest. */
const MIN_STRENGTH = 0.4;
/** Gains below this count as silent. */
const SILENT = 1e-6;

/** Reads `#rrggbb`; anything else reads as black. */
export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    return [0, 0, 0];
  }
  const [, r = "0", g = "0", b = "0"] = match;
  return [Number.parseInt(r, 16) / 255, Number.parseInt(g, 16) / 255, Number.parseInt(b, 16) / 255];
}

function scaleRgb(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Each layer's tint and effective gain (volume × mute × solo), in mix order.
 * Muting everything silences every layer.
 */
export function tintWeights(
  mix: Mix,
  tints: ReadonlyMap<string, string>,
  solo: ReadonlySet<string>,
  masterMuted: boolean,
): TintWeight[] {
  const soloActive = mix.layers.some((l) => solo.has(l.id));
  return mix.layers.flatMap((layer) => {
    const tint = tints.get(layer.id);
    if (tint === undefined) {
      return [];
    }
    const soloed = !soloActive || solo.has(layer.id);
    return [{ tint, gain: masterMuted || !soloed ? 0 : layerGain(layer) }];
  });
}

interface Group {
  colour: Rgb;
  weight: number;
  slots: number;
}

/** Merges the two closest groups until at most `MAX_POOLS` remain; the merge keeps the earlier place. */
function mergeClosest(groups: Group[]): void {
  while (groups.length > MAX_POOLS) {
    let best = { i: 0, j: 1, d: Infinity };
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = distance(groups[i].colour, groups[j].colour);
        if (d < best.d) {
          best = { i, j, d };
        }
      }
    }
    const a = groups[best.i];
    const b = groups[best.j];
    const weight = a.weight + b.weight;
    groups[best.i] = { colour: mixRgb(a.colour, b.colour, b.weight / weight), weight, slots: 1 };
    groups.splice(best.j, 1);
  }
}

/**
 * The pools' colours for a mix: always `MAX_POOLS` entries, of which the first
 * `MIN_POOLS`–`MAX_POOLS` shine and the rest have strength 0.
 *
 * - Silent layers don't count. With none left, the shining pools are `NEUTRAL`.
 * - Past `MAX_POOLS` layers, the closest tints merge (a weighted mean).
 * - With fewer tints than `MIN_POOLS`, the heaviest take the spare pools.
 * - Pools follow mix order, so adding a layer at the end leaves the first pools be.
 * - A pool's strength follows its share of the gain; a quiet mix (less than one
 *   layer at half volume) blends towards `NEUTRAL`.
 */
export function poolColours(layers: readonly TintWeight[]): PoolColour[] {
  const sounding = layers.filter((l) => l.gain > SILENT);
  const groups: Group[] = sounding.map((l) => ({
    colour: parseHex(l.tint),
    weight: l.gain,
    slots: 1,
  }));
  mergeClosest(groups);
  const pools: PoolColour[] = [];
  if (groups.length === 0) {
    for (let i = 0; i < MAX_POOLS; i++) {
      pools.push({ colour: NEUTRAL, strength: i < MIN_POOLS ? 1 : 0 });
    }
    return pools;
  }
  for (let spare = MIN_POOLS - groups.length; spare > 0; spare--) {
    let heaviest: Group | undefined;
    for (const group of groups) {
      if (!heaviest || group.weight / group.slots > heaviest.weight / heaviest.slots) {
        heaviest = group;
      }
    }
    if (heaviest) {
      heaviest.slots++;
    }
  }
  const total = sounding.reduce((sum, l) => sum + l.gain, 0);
  const presence = Math.min(1, total / FULL_PRESENCE_GAIN);
  const perSlot = Math.max(...groups.map((g) => g.weight / g.slots));
  for (const group of groups) {
    const share = MIN_STRENGTH + (1 - MIN_STRENGTH) * (group.weight / group.slots / perSlot);
    const colour = mixRgb(NEUTRAL, group.colour, presence);
    const strength = 1 + (share - 1) * presence;
    for (let i = 0; i < group.slots; i++) {
      pools.push({ colour, strength });
    }
  }
  while (pools.length < MAX_POOLS) {
    pools.push({ colour: pools.at(-1)?.colour ?? NEUTRAL, strength: 0 });
  }
  return pools;
}
