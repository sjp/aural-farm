/**
 * What the backdrop shows, frame by frame, without any WebGL: where the pools
 * drift, what colour they shine, how they breathe with the sound, and how often
 * a new frame is worth drawing. Everything here is plain maths, so it is tested
 * in Node; `backdrop.ts` turns its uniforms into pixels.
 */
import { hashFloat } from "../audio/random";
import { MAX_POOLS, mixRgb, type PoolColour, type Rgb } from "./colours";

/** The fastest the backdrop redraws, while something changes from frame to frame. */
export const FPS_CAP = 30;
/** The rate for the slow drift alone, when nothing else is changing. */
export const IDLE_FPS = 2;

/** Colour changes (layers, mutes, settings) ease over this long, in seconds. */
export const COLOUR_EASE_S = 2;

/** Level envelope attack and release, in seconds. */
export const LEVEL_ATTACK_S = 0.08;
export const LEVEL_RELEASE_S = 0.6;
/** The slow average the envelope is compared with, in seconds. */
const LEVEL_AVERAGE_S = 4;
/** How far the envelope swings the response per unit of relative level change. */
const RESPONSE_GAIN = 2;
/** The response at its extremes moves brightness this far either way… */
export const RESPONSE_BRIGHTNESS = 0.12;
/** …and the pools' size this far. */
const RESPONSE_SWELL = 0.05;
/** Below this average level, the sound counts as silent and the response rests. */
const SILENT_LEVEL = 1e-4;
/** A response this close to 0 has settled. */
const SETTLED = 0.002;

/** Floats per pool in `Uniforms.pools`: x, y, radius, strength. */
export const POOL_FLOATS = 4;

/**
 * A pool's position is value noise over time, made of two layers: a slow one with
 * a knot every `SLOW_KNOT_S`, and a quicker, smaller one at a rate that isn't a
 * simple fraction of it, so the paths never repeat. At most about 3 % of the
 * screen's height per second, which no one notices in one second.
 */
const SLOW_KNOT_S = 50;
const QUICK_KNOT_S = 23.3;
const SLOW_SHARE = 0.75;
const RANGE_X = 0.5;
const RANGE_Y = 0.32;
const RADIUS = 0.34;
const RADIUS_RANGE = 0.1;
const RADIUS_KNOT_S = 71;
/** The seed of the pools' paths. The look is the same on every visit. */
const PATH_SEED = 7;

type Mode = "glow" | "night";

/** How the backdrop looks: Glow or Night, and the Brightness setting (0–100). */
export interface Look {
  mode: Mode;
  brightness: number;
}

/** Glow's gain per Brightness unit: a pool shows 30 % of its colour at the default 50. */
const GLOW_GAIN = 0.3 / 50;
/** Night's gain per Brightness unit: about 6 % at most, at Brightness 100. */
const NIGHT_GAIN = 0.075 / 100;
/** The brightest a pixel gets: a soft ceiling, so overlapping pools never clip. */
const GLOW_CEILING = 0.9;
const NIGHT_CEILING = 0.06;
/** Night's warm colour, scaled so its luma is 1. */
const WARM: Rgb = [1.5, 0.9, 0.48];
/** How far Night shifts the colours towards `WARM`. */
const WARM_SHIFT = 0.75;

/** Floats in a displayed colour set: an RGB and a strength per pool, then the ceiling. */
const DISPLAY_FLOATS = MAX_POOLS * 4 + 1;

/** One frame's uniforms. */
export interface Uniforms {
  /**
   * x, y, radius and strength (0–1) per pool, the position and radius in units
   * of the screen's height from its centre.
   */
  pools: Float32Array<ArrayBuffer>;
  /** RGB per pool, as the pool shows at its centre. */
  colours: Float32Array<ArrayBuffer>;
  /** The soft ceiling a pixel's colour approaches. */
  ceiling: number;
}

/**
 * How long until the next frame, in ms, or null for no more frames until
 * something asks for one (`RenderLoop.invalidate`).
 */
export function frameInterval(state: {
  /** The page is visible and the backdrop is on. */
  shown: boolean;
  reducedMotion: boolean;
  /** The response to sound is running (or settling). */
  responding: boolean;
  /** A colour ease is running. */
  easing: boolean;
}): number | null {
  if (!state.shown || state.reducedMotion) {
    return null;
  }
  return 1000 / (state.responding || state.easing ? FPS_CAP : IDLE_FPS);
}

/** A one-pole smoother's coefficient for a step of `dt` seconds with time constant `tau`. */
const smoothing = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The level follower's state. */
interface LevelEnvelope {
  /** The level, smoothed with `LEVEL_ATTACK_S` up and `LEVEL_RELEASE_S` down. */
  level: number;
  /** The level's slow average. */
  average: number;
  /** −1 to 1: how far the level is above or below its average, scaled. */
  response: number;
  /** Whether it was following a level on the last step. */
  following: boolean;
}

export function createEnvelope(): LevelEnvelope {
  return { level: 0, average: 0, response: 0, following: false };
}

/**
 * Steps the envelope by `dt` seconds with the master level `input`, or with
 * `undefined` while the response is off, which eases it back to rest. The
 * response compares the level with its own slow average, so the throb shows
 * the same at any volume. Returns whether it is still moving.
 */
export function followLevel(
  envelope: LevelEnvelope,
  input: number | undefined,
  dt: number,
): boolean {
  if (input === undefined) {
    envelope.following = false;
    envelope.response *= 1 - smoothing(dt, LEVEL_RELEASE_S);
    if (Math.abs(envelope.response) < SETTLED) {
      envelope.response = 0;
    }
    return envelope.response !== 0;
  }
  if (!envelope.following) {
    // Start from the current level, so the first frames don't read as a swell.
    envelope.following = true;
    envelope.level = input;
    envelope.average = input;
  }
  const tau = input > envelope.level ? LEVEL_ATTACK_S : LEVEL_RELEASE_S;
  envelope.level += (input - envelope.level) * smoothing(dt, tau);
  envelope.average += (envelope.level - envelope.average) * smoothing(dt, LEVEL_AVERAGE_S);
  const target =
    envelope.average > SILENT_LEVEL
      ? clamp((envelope.level / envelope.average - 1) * RESPONSE_GAIN, -1, 1)
      : 0;
  // A silence eases the response back rather than dropping it.
  envelope.response =
    envelope.average > SILENT_LEVEL
      ? target
      : envelope.response * (1 - smoothing(dt, LEVEL_RELEASE_S));
  return true;
}

/** Smooth value noise in −1–1: hashed knots at whole `t`, joined with smoothstep. */
function valueNoise(stream: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hashFloat(PATH_SEED, stream, i) * 2 - 1;
  const b = hashFloat(PATH_SEED, stream, i + 1) * 2 - 1;
  return a + (b - a) * f * f * (3 - 2 * f);
}

/** Pool `index`'s centre and radius at `time` seconds, in screen heights. */
export function poolAt(index: number, time: number): [x: number, y: number, radius: number] {
  const s = index * 8;
  // Each stream starts at its own phase, so the pools don't all turn at once.
  const drift = (stream: number, knot: number) =>
    valueNoise(stream, time / knot + hashFloat(PATH_SEED, stream) * 1000);
  const path = (stream: number) =>
    SLOW_SHARE * drift(stream, SLOW_KNOT_S) + (1 - SLOW_SHARE) * drift(stream + 1, QUICK_KNOT_S);
  return [
    RANGE_X * path(s),
    RANGE_Y * path(s + 2),
    RADIUS + RADIUS_RANGE * drift(s + 4, RADIUS_KNOT_S),
  ];
}

/**
 * The pools' colours as shown, for `look`: each scaled by the brightness and
 * warmed in Night, then its strength; and last the ceiling.
 */
export function displayColours(
  pools: readonly PoolColour[],
  look: Look,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(DISPLAY_FLOATS);
  const night = look.mode === "night";
  const gain = clamp(look.brightness, 0, 100) * (night ? NIGHT_GAIN : GLOW_GAIN);
  for (let i = 0; i < MAX_POOLS; i++) {
    const pool = pools.at(i);
    if (!pool) {
      continue;
    }
    let colour = pool.colour;
    if (night) {
      const luma = 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
      colour = mixRgb(colour, [luma * WARM[0], luma * WARM[1], luma * WARM[2]], WARM_SHIFT);
    }
    out[i * 4] = colour[0] * gain;
    out[i * 4 + 1] = colour[1] * gain;
    out[i * 4 + 2] = colour[2] * gain;
    out[i * 4 + 3] = pool.strength;
  }
  out[DISPLAY_FLOATS - 1] = night ? NIGHT_CEILING : GLOW_CEILING;
  return out;
}

const smoothstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

interface Scene {
  /**
   * The colours to ease to; `instant` jumps there (for reduced motion). Returns
   * whether they differ from the current target.
   */
  setTarget: (pools: readonly PoolColour[], look: Look, instant: boolean) => boolean;
  /**
   * The uniforms at `time` seconds (`dt` since the last frame), with the master
   * level, or `undefined` while the response is off.
   */
  frame: (time: number, dt: number, level: number | undefined) => Uniforms;
  /** Whether the last frame was mid-ease, or the response still moving. */
  readonly easing: boolean;
  readonly responding: boolean;
}

export function createScene(): Scene {
  const uniforms: Uniforms = {
    pools: new Float32Array(MAX_POOLS * POOL_FLOATS),
    colours: new Float32Array(MAX_POOLS * 3),
    ceiling: GLOW_CEILING,
  };
  let shown: Float32Array<ArrayBuffer> | undefined;
  let from = new Float32Array(DISPLAY_FLOATS);
  let to = new Float32Array(DISPLAY_FLOATS);
  /** A new target waiting for the next frame, which knows the time. */
  let pending: { colours: Float32Array<ArrayBuffer>; instant: boolean } | undefined;
  let easeStart = 0;
  let easing = false;
  let responding = false;
  const envelope = createEnvelope();
  const current = new Float32Array(DISPLAY_FLOATS);

  return {
    setTarget(pools, look, instant) {
      const colours = displayColours(pools, look);
      const latest = pending?.colours ?? to;
      // An unchanged target (a re-render) leaves a running ease, or the rest, alone.
      if (shown && colours.every((v, i) => v === latest[i])) {
        return false;
      }
      pending = { colours, instant };
      return true;
    },
    frame(time, dt, level) {
      if (pending) {
        // The first target shows at once: there is nothing on screen to ease from.
        const jump = pending.instant || !shown;
        from = jump ? pending.colours : current.slice();
        to = pending.colours;
        easeStart = jump ? time - COLOUR_EASE_S : time;
        pending = undefined;
      }
      const t = smoothstep((time - easeStart) / COLOUR_EASE_S);
      easing = t < 1;
      for (let i = 0; i < DISPLAY_FLOATS; i++) {
        current[i] = from[i] + (to[i] - from[i]) * t;
      }
      shown = current;
      responding = followLevel(envelope, level, dt);
      const breath = 1 + RESPONSE_BRIGHTNESS * envelope.response;
      const swell = 1 + RESPONSE_SWELL * envelope.response;
      for (let i = 0; i < MAX_POOLS; i++) {
        const [x, y, radius] = poolAt(i, time);
        uniforms.pools[i * POOL_FLOATS] = x;
        uniforms.pools[i * POOL_FLOATS + 1] = y;
        uniforms.pools[i * POOL_FLOATS + 2] = radius * swell;
        uniforms.pools[i * POOL_FLOATS + 3] = current[i * 4 + 3];
        for (let c = 0; c < 3; c++) {
          uniforms.colours[i * 3 + c] = current[i * 4 + c] * breath;
        }
      }
      uniforms.ceiling = current[DISPLAY_FLOATS - 1];
      return uniforms;
    },
    get easing() {
      return easing;
    },
    get responding() {
      return responding;
    },
  };
}

const css = (x: number) => Math.round(clamp(x, 0, 1) * 255);

/**
 * A static CSS stand-in for the backdrop, where WebGL isn't available: the pools
 * as radial gradients where they start, over black.
 */
export function cssBackdrop(pools: readonly PoolColour[], look: Look): string {
  const colours = displayColours(pools, look);
  const layers: string[] = [];
  for (let i = 0; i < MAX_POOLS; i++) {
    const [x, y, radius] = poolAt(i, 0);
    const rgb = [0, 1, 2].map((c) => css(colours[i * 4 + c])).join(" ");
    const alpha = colours[i * 4 + 3].toFixed(2);
    // Screen-height units: the centre is at 50 % 50 %, and y points up.
    const at = `calc(50% + ${(x * 100).toFixed(1)}vh) calc(50% - ${(y * 100).toFixed(1)}vh)`;
    layers.push(
      `radial-gradient(circle at ${at}, rgb(${rgb} / ${alpha}) 0, transparent ${(radius * 150).toFixed(0)}vh)`,
    );
  }
  return [...layers, "#000"].join(", ");
}
