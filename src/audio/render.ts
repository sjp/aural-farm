/**
 * A whole mix built into any context, live or offline, as the engine plays it
 * once every layer has faded in: each layer's sound through its layer gain into
 * the master chain, and its reverb sends through a bus at the same gain into
 * the context's shared convolvers. There are no fades, solo or master mute, and
 * muted layers aren't built at all.
 *
 * For a fresh `OfflineAudioContext`, `startAt` is the absolute time its first
 * sample stands for: sounds are time-addressable, so renders from different
 * `startAt`s line up.
 */
import type { Mix } from "../mixes/mix";
import { getSound } from "../sounds/registry";
import type { SoundInstance } from "../sounds/types";
import {
  createMasterChain,
  layerGain,
  seedOf,
  soundParams,
  volumeGain,
  type MasterChain,
} from "./mix-graph";
import { getReverb, routeReverb, type ReverbKind } from "./reverb";

interface MixGraph {
  /** The master chain, whose output is connected to the context's destination. */
  master: MasterChain;
  /** Stops and disconnects every sound and gain the mix built. */
  dispose: () => void;
}

interface BuildOptions {
  startAt: number;
  /** Reports a sound's failure after it was built, such as a crashed worklet. */
  onError?: (error: unknown) => void;
  /** Finds a sound's registry entry; the default is the registry. */
  findSound?: typeof getSound;
}

/**
 * Builds `mix` into `ctx`, loading each sound, and connects the master chain to
 * `ctx.destination`. Rejects (having released what it built) if a sound is
 * unknown or fails to build.
 */
export async function buildMix(
  ctx: BaseAudioContext,
  mix: Mix,
  options: BuildOptions,
): Promise<MixGraph> {
  const findSound = options.findSound ?? getSound;
  const master = createMasterChain(ctx);
  master.level.gain.value = volumeGain(mix.master);
  master.output.connect(ctx.destination);
  const instances: SoundInstance[] = [];
  const gains: GainNode[] = [];
  const returns = new Set<ReverbKind>();
  const dispose = () => {
    for (const instance of instances.splice(0)) {
      instance.dispose();
    }
    for (const gain of gains.splice(0)) {
      gain.disconnect();
    }
    master.output.disconnect();
  };
  try {
    for (const layer of mix.layers) {
      const gain = layerGain(layer);
      if (gain === 0) {
        continue;
      }
      const entry = findSound(layer.id);
      if (!entry) {
        throw new Error(`No sound "${layer.id}"`);
      }
      const definition = await entry.load();
      const level = ctx.createGain();
      level.gain.value = gain;
      level.connect(master.level);
      gains.push(level);
      const buses = new Map<ReverbKind, GainNode>();
      routeReverb(level, (kind) => {
        let bus = buses.get(kind);
        if (!bus) {
          bus = ctx.createGain();
          bus.gain.value = gain;
          const convolver = getReverb(ctx, kind);
          if (!returns.has(kind)) {
            convolver.connect(master.level);
            returns.add(kind);
          }
          bus.connect(convolver);
          buses.set(kind, bus);
          gains.push(bus);
        }
        return bus;
      });
      const params = soundParams(definition, layer.params);
      const init = { params, seed: seedOf(params), startAt: options.startAt };
      instances.push(
        await definition.create(
          ctx,
          level,
          options.onError ? { ...init, onError: options.onError } : init,
        ),
      );
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { master, dispose };
}

/** The sample rate offline renders use unless told otherwise. */
const RENDER_RATE = 48000;

interface RenderOptions extends BuildOptions {
  /** How long to render, in seconds. */
  seconds: number;
  /** Default `RENDER_RATE`. */
  sampleRate?: number;
  /** Makes the offline context (stereo); tests pass a stand-in. */
  createContext?: (length: number, sampleRate: number) => OfflineAudioContext;
  /** Called once the mix is built, before rendering starts, e.g. to schedule suspends. */
  prepare?: (ctx: OfflineAudioContext, graph: MixGraph) => void;
}

/**
 * Renders `seconds` of `mix` in a fresh stereo `OfflineAudioContext`, through
 * the master chain, and releases the graph. Its first sample stands for
 * absolute time `startAt`. Rejects if the mix can't be built.
 */
export async function renderMix(mix: Mix, options: RenderOptions): Promise<AudioBuffer> {
  const { seconds, sampleRate = RENDER_RATE, createContext, prepare, ...build } = options;
  const length = Math.round(seconds * sampleRate);
  const ctx = createContext
    ? createContext(length, sampleRate)
    : new OfflineAudioContext(2, length, sampleRate);
  const graph = await buildMix(ctx, mix, build);
  try {
    prepare?.(ctx, graph);
    return await ctx.startRendering();
  } finally {
    graph.dispose();
  }
}
