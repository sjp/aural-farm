/**
 * Wind's pure maths: the curves its wave shapers apply to the gust drift and the
 * wind speed, the whistle's pitch, and each setting's filters. No Web Audio here,
 * so it is unit-testable in Node.
 *
 * The wind speed is strength (0, still, to 1, a gale) plus gusts that lift it
 * by up to about 1 more, and a slow trend either way. The graph carries it
 * divided by `SPEED_MAX`, so the shapers, which read their input on −1..1, see
 * it on 0..1; their curves hold their value at speed 0 for negative inputs.
 */
import type { WindSetting } from "./wind.meta";

/** The highest speed the shapers read; any more reads as this. */
export const SPEED_MAX = 3;

/** Points in each shaper curve: plenty for curves this smooth (linear between points). */
const CURVE_POINTS = 1025;

/** Gusts: a drift's dip below this reads as a lull, and the curve's power. */
const LULL = -0.2;
const GUST_POWER = 1.6;
/**
 * How far a gust at full `gustiness` lifts the speed above the strength. The
 * gust curve is 0 about a quarter of the time, passes 0.3 a tenth of the time
 * and 0.5 about one time in a hundred: so at full gustiness the stronger gusts
 * lift the speed by 0.6–1.
 */
export const GUST_DEPTH = 2;
/** The slow trend's swing on the speed: ±0.08, about ±15 % of a moderate wind. */
export const TREND_SWING = 0.08;

/** How far the body's bands rise at full brightness: +60 %. */
const COLOUR_RISE = 0.6;
/** How far each band's own drift moves it, in cents: ±12 %. */
export const BAND_SWING_CENTS = 1200 * Math.log2(1.12);
/** The whistles' ceiling in Hz, and how far they would rise at full brightness: +35 %. */
export const WHISTLE_MAX = 1600;
const WHISTLE_RISE = 0.35;

/** The body's level at speed 0 against speed 1: −24 dB, so a light breeze is still heard. */
const BODY_FLOOR = 10 ** (-24 / 20);
/** Above speed 1 the level rises this much more slowly: a gale is louder, but not by much. */
const GALE_POWER = 0.2;

/** A band-pass of the body. */
interface Band {
  centre: number;
  q: number;
}

/** Each setting's filters and whistles. */
interface SettingSpec {
  /** The body's two band-passes: centre in Hz (at speed 0, before its drift) and Q. */
  bands: readonly [Band, Band];
  /** The body's low-pass, in Hz, or none where the bands roll off soon enough. */
  lowpass: number | undefined;
  /** The whistles: base frequency in Hz, level in dB, pan. */
  whistles: readonly { base: number; db: number; pan: number }[];
  /** A rustle of leaves on gusts. */
  rustle: boolean;
  /** A send to the shared room reverb, in dB, or none. */
  roomDb: number | undefined;
}

export const SETTINGS: Readonly<Record<WindSetting, SettingSpec>> = {
  field: {
    // Broad and airy: a broad low band, and the bands roll off softly above, with no low-pass.
    bands: [
      { centre: 350, q: 0.5 },
      { centre: 1100, q: 1.1 },
    ],
    lowpass: undefined,
    whistles: [{ base: 900, db: -6, pan: 0.25 }],
    rustle: false,
    roomDb: undefined,
  },
  trees: {
    bands: [
      { centre: 450, q: 0.6 },
      { centre: 1600, q: 1.1 },
    ],
    lowpass: 6500,
    whistles: [{ base: 1200, db: -10, pan: -0.25 }],
    rustle: true,
    roomDb: undefined,
  },
  // Through the walls: muffled, with a moan at the gaps and a fainter one above it.
  house: {
    bands: [
      { centre: 180, q: 0.8 },
      { centre: 600, q: 1.1 },
    ],
    lowpass: 1800,
    whistles: [
      { base: 650, db: 0, pan: 0.3 },
      { base: 650 * 1.47, db: -6, pan: -0.35 },
    ],
    rustle: false,
    roomDb: -22,
  },
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** A shaper curve: `fn` of the input, on −1..1. */
function curve(fn: (x: number) => number): Float32Array<ArrayBuffer> {
  const values = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    values[i] = fn((2 * i) / (CURVE_POINTS - 1) - 1);
  }
  return values;
}

/** A shaper curve of the speed, read from the speed ÷ `SPEED_MAX`; negative input reads as still. */
const speedCurve = (fn: (speed: number) => number) => curve((x) => fn(Math.max(0, x) * SPEED_MAX));

/**
 * The gust at drift value `x` (−1..1): 0 in a lull (x below −0.2), rising as a
 * rounded power above it, 1 at x = 1. So gusts are occasional surges rather
 * than a wobble.
 */
export function gust(x: number): number {
  const lifted = Math.max(0, Math.min(1, x) - LULL);
  return lifted ** GUST_POWER / (1 - LULL) ** GUST_POWER;
}

/** The gust shaper's curve. */
export const gustCurve = () => curve(gust);

/**
 * How bright the wind is at `speed`, 0..1: rising with the speed and easing
 * off towards a gale, so gusts still brighten a strong wind.
 */
export function brightness(speed: number): number {
  const x = clamp01(speed / 2);
  return 1 - (1 - x) * (1 - x);
}

/**
 * The body's level at `speed`: −24 dB still, 0 dB at speed 1, its power rising
 * roughly with the speed squared, and only a little more in a gale.
 */
export function bodyLevel(speed: number): number {
  const s = Math.max(0, speed);
  return s <= 1 ? BODY_FLOOR + (1 - BODY_FLOOR) * s : s ** GALE_POWER;
}

/** How far the body's bands rise at `speed`, in cents. */
export function colourCents(speed: number): number {
  return 1200 * Math.log2(1 + COLOUR_RISE * brightness(speed));
}

/** The highest whistle's base frequency, in Hz. */
const HIGHEST_WHISTLE = Math.max(
  ...Object.values(SETTINGS).flatMap((spec) => spec.whistles.map((w) => w.base)),
);
/**
 * Every whistle's full rise, as a ratio: +35 %, or less where that would take
 * the highest whistle past 1.6 kHz. One rise for all, so one signal bends them
 * all.
 */
const WHISTLE_RANGE = Math.min(1 + WHISTLE_RISE, WHISTLE_MAX / HIGHEST_WHISTLE);

/** How far the whistles have risen at `speed`, in cents. */
export function whistleCents(speed: number): number {
  return 1200 * Math.log2(1 + (WHISTLE_RANGE - 1) * brightness(speed));
}

/** A whistle's frequency from `base` at `speed`, in Hz: never above 1.6 kHz. */
export function whistleFrequency(base: number, speed: number): number {
  return base * 2 ** (whistleCents(speed) / 1200);
}

/**
 * The leaves' flutter at drift value `x` (−1..1): peaks sharpened by a cube,
 * so the rustle comes in quick bursts rather than a steady hiss.
 */
export function flutter(x: number): number {
  return clamp01((x + 1) / 1.8) ** 3;
}

/**
 * The shaper curves, from the speed ÷ `SPEED_MAX` (or for `flutter`, the
 * drift). The body's level is scaled by `trim`, the sound's output level, and
 * the flutter by the leaves' level.
 */
export const bodyLevelCurve = (trim: number) => speedCurve((speed) => trim * bodyLevel(speed));
export const colourCurve = () => speedCurve(colourCents);
export const whistleCurve = () => speedCurve(whistleCents);
export const flutterCurve = (scale: number) => curve((x) => scale * flutter(x));
