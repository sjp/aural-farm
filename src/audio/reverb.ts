/**
 * Shared reverb. Each context gets one convolver per kind, whose impulse is
 * generated procedurally (seeded noise, decaying faster in the highs than the
 * lows) the first time a sound asks for it. Sounds feed it through sends:
 *
 *   const send = createSend(ctx, scope, voices, out, "room", -24);
 *   glide(send.gain, dbToGain(-18), when, 0.1);
 *
 * In the engine, a send goes to the layer's reverb bus, which follows the
 * layer's own volume, mute and fades before reaching the shared convolver, so
 * muting a layer stops its reverb too (the tail already in the convolver rings
 * out). Without an engine (a sound rendered on its own), a send gets a convolver
 * of its own that shares the impulse and feeds `out`.
 */
import { dbToGain } from "./glide";
import { createRng, hash32 } from "./random";
import type { AudioScope } from "./scope";

export const REVERB_KINDS = ["room", "hall", "outdoor", "metal"] as const;
export type ReverbKind = (typeof REVERB_KINDS)[number];

interface ReverbSpec {
  /** Time for the mid band to fall 60 dB, in seconds. */
  rt60: number;
  /** The low and high bands' decay times, relative to the mid band's. */
  lowDecay: number;
  highDecay: number;
  /** Silence before the reverb starts, then its fade-in, in seconds. */
  predelay: number;
  fadeIn: number;
  /** Discrete early reflections (time range in seconds), and the diffuse tail's level. */
  reflections: number;
  reflectionSpan: readonly [number, number];
  diffuse: number;
  /** Decaying resonances (Hz range) and their level relative to the diffuse tail. */
  resonances: number;
  resonanceRange: readonly [number, number];
  resonanceLevel: number;
}

const SPECS: Record<ReverbKind, ReverbSpec> = {
  room: {
    rt60: 0.6,
    lowDecay: 1.1,
    highDecay: 0.6,
    predelay: 0.004,
    fadeIn: 0.002,
    reflections: 0,
    reflectionSpan: [0, 0],
    diffuse: 1,
    resonances: 0,
    resonanceRange: [0, 0],
    resonanceLevel: 0,
  },
  hall: {
    rt60: 2.8,
    lowDecay: 1.2,
    highDecay: 0.5,
    predelay: 0.02,
    fadeIn: 0.01,
    reflections: 0,
    reflectionSpan: [0, 0],
    diffuse: 1,
    resonances: 0,
    resonanceRange: [0, 0],
    resonanceLevel: 0,
  },
  // Open air: a few sparse echoes off distant surfaces, then a thin, dark tail.
  outdoor: {
    rt60: 1.5,
    lowDecay: 1,
    highDecay: 0.3,
    predelay: 0.015,
    fadeIn: 0.04,
    reflections: 6,
    reflectionSpan: [0.02, 0.12],
    diffuse: 0.5,
    resonances: 0,
    resonanceRange: [0, 0],
    resonanceLevel: 0,
  },
  // A hard-walled metal space: bright, with a few ringing modes.
  metal: {
    rt60: 1.2,
    lowDecay: 0.9,
    highDecay: 0.8,
    predelay: 0.003,
    fadeIn: 0.001,
    reflections: 0,
    reflectionSpan: [0, 0],
    diffuse: 1,
    resonances: 4,
    resonanceRange: [380, 2400],
    resonanceLevel: 0.25,
  },
};

/** The impulse never runs longer than this, in seconds. */
const MAX_LENGTH = 3;
/** ln(1000): an amplitude decay of 60 dB. */
const LN_60DB = Math.log(1000);
/** Crossovers between the low, mid and high bands, in Hz. */
const LOW_CROSSOVER = 500;
const HIGH_CROSSOVER = 4000;

/** How long `kind`'s impulse is, in seconds. */
export function reverbLength(kind: ReverbKind): number {
  const spec = SPECS[kind];
  return Math.min(MAX_LENGTH, spec.predelay + spec.rt60 * 1.1);
}

/**
 * The stereo impulse response for `kind` at `sampleRate`: seeded noise split
 * into three bands, each decaying exponentially at its own rate, plus the kind's
 * early reflections and resonances. Each channel is normalised to unit energy,
 * so the reverb of noise comes out at about the noise's level. The channels use
 * different noise, so the reverb is wide.
 */
export function reverbImpulse(
  kind: ReverbKind,
  sampleRate: number,
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const spec = SPECS[kind];
  const length = Math.round(reverbLength(kind) * sampleRate);
  const start = Math.round(spec.predelay * sampleRate);
  const fadeIn = Math.max(1, spec.fadeIn * sampleRate);
  const lowPole = Math.exp((-2 * Math.PI * LOW_CROSSOVER) / sampleRate);
  const highPole = Math.exp((-2 * Math.PI * HIGH_CROSSOVER) / sampleRate);
  // Per-sample amplitude multipliers for each band's decay.
  const decay = (rt60: number) => Math.exp(-LN_60DB / (rt60 * sampleRate));
  const lowStep = decay(spec.rt60 * spec.lowDecay);
  const midStep = decay(spec.rt60);
  const highStep = decay(spec.rt60 * spec.highDecay);
  const kindIndex = REVERB_KINDS.indexOf(kind);

  const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  channels.forEach((data, channel) => {
    const rng = createRng(hash32(kindIndex, channel, 0x7e7b));
    let low = 0;
    let lowAndMid = 0;
    let lowEnv = spec.diffuse;
    let midEnv = spec.diffuse;
    let highEnv = spec.diffuse;
    for (let i = start; i < length; i++) {
      const noise = rng.next() * 2 - 1;
      low = noise + lowPole * (low - noise);
      lowAndMid = noise + highPole * (lowAndMid - noise);
      const high = noise - lowAndMid;
      const mid = lowAndMid - low;
      const onset = Math.min(1, (i - start) / fadeIn);
      data[i] = onset * (low * lowEnv + mid * midEnv + high * highEnv);
      lowEnv *= lowStep;
      midEnv *= midStep;
      highEnv *= highStep;
    }
    const [earliest, latest] = spec.reflectionSpan;
    for (let r = 0; r < spec.reflections; r++) {
      const at = Math.round((spec.predelay + rng.range(earliest, latest)) * sampleRate);
      const gain = rng.range(0.3, 0.7) * (r % 2 === 0 ? 1 : -1);
      // A short smeared click (a few samples) rather than a single sample, so it isn't harsh.
      for (let k = 0; k < 8 && at + k < length; k++) {
        data[at + k] = (data[at + k] ?? 0) + gain * Math.exp(-k / 2);
      }
    }
    const [lowest, highest] = spec.resonanceRange;
    const ringStep = decay(spec.rt60 * 0.8);
    for (let m = 0; m < spec.resonances; m++) {
      const frequency = lowest * (highest / lowest) ** rng.next();
      const phase = rng.next() * 2 * Math.PI;
      const level = spec.resonanceLevel * rng.range(0.6, 1);
      let env = level;
      for (let i = start; i < length; i++) {
        const onset = Math.min(1, (i - start) / fadeIn);
        data[i] =
          (data[i] ?? 0) +
          onset * env * Math.sin((2 * Math.PI * frequency * (i - start)) / sampleRate + phase);
        env *= ringStep;
      }
    }
    let energy = 0;
    for (const v of data) {
      energy += v * v;
    }
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i++) {
      data[i] = (data[i] ?? 0) * scale;
    }
  });
  return channels;
}

const buffers = new WeakMap<BaseAudioContext, Map<ReverbKind, AudioBuffer>>();
const convolvers = new WeakMap<BaseAudioContext, Map<ReverbKind, ConvolverNode>>();

/** `kind`'s impulse as an AudioBuffer, generated once per context. */
function reverbBuffer(ctx: BaseAudioContext, kind: ReverbKind): AudioBuffer {
  let byKind = buffers.get(ctx);
  if (!byKind) {
    byKind = new Map();
    buffers.set(ctx, byKind);
  }
  let buffer = byKind.get(kind);
  if (!buffer) {
    const [left, right] = reverbImpulse(kind, ctx.sampleRate);
    buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    byKind.set(kind, buffer);
  }
  return buffer;
}

/** A convolver playing `kind`'s impulse as given (not renormalised by the browser). */
function makeConvolver(ctx: BaseAudioContext, kind: ReverbKind): ConvolverNode {
  const convolver = ctx.createConvolver();
  // Must be set before the buffer, which is when the browser applies it.
  convolver.normalize = false;
  convolver.buffer = reverbBuffer(ctx, kind);
  return convolver;
}

/**
 * The context's shared convolver for `kind`, made on first use. It lives as long
 * as the context; whoever asks first connects its output (the engine, to the
 * master bus).
 */
export function getReverb(ctx: BaseAudioContext, kind: ReverbKind): ConvolverNode {
  let byKind = convolvers.get(ctx);
  if (!byKind) {
    byKind = new Map();
    convolvers.set(ctx, byKind);
  }
  let convolver = byKind.get(kind);
  if (!convolver) {
    convolver = makeConvolver(ctx, kind);
    byKind.set(kind, convolver);
  }
  return convolver;
}

/** Where a layer's sends go, by the layer input (`out`) its sound was given. */
const routes = new WeakMap<AudioNode, (kind: ReverbKind) => AudioNode>();

/**
 * Registers the reverb bus for the layer whose sound feeds `out`: `route(kind)`
 * gives the node a send of that kind connects to. The engine calls this for each
 * layer.
 */
export function routeReverb(out: AudioNode, route: (kind: ReverbKind) => AudioNode): void {
  routes.set(out, route);
}

/**
 * A send from `source` to the `kind` reverb of the layer that `out` feeds, at
 * `levelDb`. Returns the send's gain node (registered with `scope`); glide its
 * `gain` to change the level.
 */
export function createSend(
  ctx: BaseAudioContext,
  scope: AudioScope,
  source: AudioNode,
  out: AudioNode,
  kind: ReverbKind,
  levelDb: number,
): GainNode {
  const send = scope.add(new GainNode(ctx, { gain: dbToGain(levelDb) }));
  source.connect(send);
  const route = routes.get(out);
  if (route) {
    send.connect(route(kind));
  } else {
    send.connect(scope.add(makeConvolver(ctx, kind))).connect(out);
  }
  return send;
}
