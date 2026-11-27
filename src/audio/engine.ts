/**
 * The audio engine: turns a `Mix` into a running Web Audio graph and keeps it in
 * step as the mix changes, without clicks.
 *
 *   layer: sound → level (volume × mute) → fade ─┐
 *   layer: sound → level (volume × mute) → fade ─┤
 *                                                 └→ master level → master fade
 *        → high-pass 25 Hz → limiter → trim −1 dB → output (→ destination)
 *
 * Each sound is crash-isolated: a throw in `create` or `update`, or a crashed
 * worklet, fails that layer alone, and `retry` builds it again. The context is
 * created on the first `play()` and suspended once a pause has faded out, so
 * nothing runs while paused. It keeps playing when the tab is hidden.
 *
 * Fades and glides are scheduled on the audio clock. Work that has to wait for
 * the clock (disposing a removed layer, suspending after a pause) polls it with a
 * timer, so a throttled timer in a background tab only makes it late, never early.
 */
import { describeError } from "../lib/errors";
import type { Layer, Mix } from "../mixes/mix";
import { createLatest, type SoundLoader } from "../sounds/loader";
import { coerce } from "../sounds/params";
import { getSound } from "../sounds/registry";
import type { ParamValues, SoundDefinition, SoundInstance } from "../sounds/types";

export type EngineState =
  /** No context yet: nothing has asked to play. */
  | "idle"
  /** Waiting for the context to start. */
  | "starting"
  | "playing"
  /** Fading out before suspending. */
  | "pausing"
  | "paused"
  /** The browser refused to start audio without a user gesture. */
  | "blocked"
  /** The system took the audio away, as during a phone call. */
  | "interrupted"
  /** The audio context couldn't be created. */
  | "failed";

export type LayerState = "loading" | "ready" | `failed: ${string}`;

/** Time constant of volume, mute and master glides, in seconds. */
const GLIDE_TAU = 0.08;
/** A new layer fades in over this many seconds. */
export const LAYER_FADE_IN = 1.5;
/** A removed layer fades out over this many seconds before it is disposed. */
export const LAYER_FADE_OUT = 1;
/** `play()` fades the master in over this many seconds. */
export const PLAY_FADE_IN = 1;
/** `pause()` fades the master out over this many seconds, then suspends. */
export const PAUSE_FADE_OUT = 0.4;
/** How long `play()` waits for the context to start before calling it blocked. */
export const BLOCKED_AFTER_MS = 500;
/** The shortest wait between checks of the audio clock. */
const MIN_POLL_MS = 20;

const HIGHPASS_HZ = 25;
const HIGHPASS_Q = 0.7;
const TRIM_DB = -1;

interface EngineOptions {
  /** Makes the context, on the first `play()`. Injected so tests can pass a fake. */
  createContext: () => AudioContext;
  loader: SoundLoader;
  onState: (state: EngineState) => void;
  onLayerState: (id: string, state: LayerState) => void;
  /** Connects the master output to the speakers; the default goes to `ctx.destination`. */
  connectOutput?: (ctx: AudioContext, output: AudioNode) => void;
  /** Finds a sound's registry entry; the default is the registry. */
  findSound?: typeof getSound;
}

export interface AudioEngine {
  /** Starts or resumes playback, and resolves to the state it reached. */
  play: () => Promise<EngineState>;
  /** Fades out, then suspends the context. Layers stay built, so resuming is instant. */
  pause: () => void;
  /** Brings the running graph in line with `mix`. */
  setMix: (mix: Mix) => void;
  /** Builds a failed layer again. */
  retry: (id: string) => void;
  /** Stops everything and closes the context. */
  dispose: () => void;
  readonly state: EngineState;
  readonly context: AudioContext | undefined;
}

/** A linear gain fade, tracked so that a new fade can start from wherever the last one is. */
interface Fade {
  from: number;
  to: number;
  start: number;
  end: number;
}

const still = (value: number): Fade => ({ from: value, to: value, start: 0, end: 0 });

function fadeValue(fade: Fade, t: number): number {
  if (t >= fade.end) {
    return fade.to;
  }
  if (t <= fade.start) {
    return fade.from;
  }
  return fade.from + ((fade.to - fade.from) * (t - fade.start)) / (fade.end - fade.start);
}

/** Ramps `param` from its current point on `fade` to `to` over `seconds`. */
function fadeParam(param: AudioParam, fade: Fade, to: number, seconds: number, now: number): Fade {
  const from = fadeValue(fade, now);
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.linearRampToValueAtTime(to, now + seconds);
  return { from, to, start: now, end: now + seconds };
}

/** A perceptual volume curve: 0–100 to a gain of 0–1. */
const volumeGain = (volume: number) => (volume / 100) ** 2;

const layerGain = (layer: Layer) => (layer.muted ? 0 : volumeGain(layer.volume));

/** The layer's params, coerced against the sound's own schema. */
function soundParams(definition: SoundDefinition, values: ParamValues): ParamValues {
  const params: ParamValues = {};
  for (const [key, def] of Object.entries(definition.params)) {
    params[key] = coerce(def, values[key]);
  }
  return params;
}

function sameParams(a: ParamValues, b: ParamValues): boolean {
  return Object.keys(a).every((key) => a[key] === b[key]);
}

/** Reads the state afresh: it changes behind TypeScript's back across an await. */
const isRunning = (ctx: BaseAudioContext) => ctx.state === "running";

const seedOf = (params: ParamValues) => (typeof params.seed === "number" ? params.seed : 0);

/** A built (or building) layer: its gain stages and the running sound. */
interface Voice {
  level: GainNode;
  fade: GainNode;
  fadeState: Fade;
  levelTarget: number;
  /** Undefined while an async `create` is still running. */
  instance: SoundInstance | undefined;
  /** The params the sound was last given. */
  params: ParamValues;
  released: boolean;
}

interface LayerEntry {
  id: string;
  layer: Layer;
  state: LayerState | undefined;
  definition: SoundDefinition | undefined;
  load: ReturnType<typeof createLatest<SoundDefinition>>;
  voice: Voice | undefined;
}

interface MasterChain {
  level: GainNode;
  fade: GainNode;
}

export function createAudioEngine(options: EngineOptions): AudioEngine {
  const { loader, onState, onLayerState } = options;
  const findSound = options.findSound ?? getSound;
  const connectOutput =
    options.connectOutput ??
    ((ctx: AudioContext, output: AudioNode) => {
      output.connect(ctx.destination);
    });

  let state: EngineState = "idle";
  let context: AudioContext | undefined;
  let master: MasterChain | undefined;
  let masterFade = still(0);
  let mix: Mix = { master: 100, layers: [] };
  /** Whether the user wants sound: set by `play()`, cleared by `pause()`. */
  let wantPlaying = false;
  /** Bumped by every play and pause, so a stale continuation can tell it is stale. */
  let transition = 0;
  let disposed = false;
  const layers = new Map<string, LayerEntry>();
  /** Removed layers still fading out. */
  const leaving = new Set<Voice>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const setState = (next: EngineState) => {
    if (state !== next) {
      state = next;
      onState(next);
    }
  };

  const setLayerState = (entry: LayerEntry, next: LayerState) => {
    if (entry.state !== next) {
      entry.state = next;
      onLayerState(entry.id, next);
    }
  };

  /** Resolves when `promise` settles or after `ms`, whichever comes first. */
  const settleWithin = async (promise: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = later(ms, resolve);
    });
    try {
      await Promise.race([promise.catch(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    }
  };

  /** Whether a play or pause that took `token` has been overtaken (or the engine disposed). */
  const stale = (token: number) => disposed || token !== transition;

  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  /** Runs `fn` once the audio clock passes `time`, or straight away if the clock has stopped. */
  const whenClockPasses = (time: number, fn: () => void) => {
    const check = () => {
      if (disposed || !context) {
        return;
      }
      const remaining = time - context.currentTime;
      if (remaining <= 0 || context.state !== "running") {
        fn();
      } else {
        later(Math.max(MIN_POLL_MS, remaining * 1000), check);
      }
    };
    check();
  };

  /** Disposes a voice's sound (guarded: a throwing dispose can't break the others) and gains. */
  const release = (voice: Voice) => {
    if (voice.released) {
      return;
    }
    voice.released = true;
    leaving.delete(voice);
    try {
      voice.instance?.dispose();
    } catch {
      // The sound is going away either way; its gains are disconnected below.
    }
    voice.level.disconnect();
    voice.fade.disconnect();
  };

  const fail = (entry: LayerEntry, error: unknown) => {
    if (entry.voice) {
      release(entry.voice);
      entry.voice = undefined;
    }
    setLayerState(entry, `failed: ${describeError(error)}`);
  };

  const applyParams = (entry: LayerEntry) => {
    const { voice, definition } = entry;
    if (!context || !voice?.instance || !definition) {
      return;
    }
    const params = soundParams(definition, entry.layer.params);
    if (sameParams(params, voice.params)) {
      return;
    }
    voice.params = params;
    try {
      voice.instance.update(params, context.currentTime);
    } catch (error) {
      fail(entry, error);
    }
  };

  const applyLevel = (entry: LayerEntry) => {
    const { voice } = entry;
    const target = layerGain(entry.layer);
    if (!context || !voice || voice.levelTarget === target) {
      return;
    }
    voice.levelTarget = target;
    voice.level.gain.setTargetAtTime(target, context.currentTime, GLIDE_TAU);
  };

  /** Takes a freshly created sound into the mix and fades it in. */
  const attach = (entry: LayerEntry, voice: Voice, instance: SoundInstance) => {
    if (disposed || !context || voice.released || entry.voice !== voice) {
      // The layer went away (or was rebuilt) while the sound was being created.
      try {
        instance.dispose();
      } catch {
        // Nothing else holds it.
      }
      return;
    }
    voice.instance = instance;
    voice.fadeState = fadeParam(
      voice.fade.gain,
      voice.fadeState,
      1,
      LAYER_FADE_IN,
      context.currentTime,
    );
    setLayerState(entry, "ready");
    // Params may have changed while an async create ran.
    applyParams(entry);
  };

  const build = (entry: LayerEntry) => {
    const ctx = context;
    const { definition } = entry;
    if (disposed || !ctx || !master || !definition || entry.voice) {
      return;
    }
    const level = ctx.createGain();
    const levelTarget = layerGain(entry.layer);
    level.gain.value = levelTarget;
    const fade = ctx.createGain();
    fade.gain.value = 0;
    level.connect(fade).connect(master.level);
    const params = soundParams(definition, entry.layer.params);
    const voice: Voice = {
      level,
      fade,
      fadeState: still(0),
      levelTarget,
      instance: undefined,
      params,
      released: false,
    };
    entry.voice = voice;
    const onError = (error: unknown) => {
      if (entry.voice === voice) {
        fail(entry, error);
      }
    };
    let created: SoundInstance | Promise<SoundInstance>;
    try {
      created = definition.create(ctx, level, {
        params,
        seed: seedOf(params),
        startAt: ctx.currentTime,
        onError,
      });
    } catch (error) {
      onError(error);
      return;
    }
    if (created instanceof Promise) {
      void settle(entry, voice, created, onError);
    } else {
      attach(entry, voice, created);
    }
  };

  /** Attaches an async `create`'s sound once it resolves, or fails the layer. */
  const settle = async (
    entry: LayerEntry,
    voice: Voice,
    created: Promise<SoundInstance>,
    onError: (error: unknown) => void,
  ) => {
    let instance: SoundInstance;
    try {
      instance = await created;
    } catch (error) {
      onError(error);
      return;
    }
    attach(entry, voice, instance);
  };

  const loaded = (entry: LayerEntry, definition: SoundDefinition) => {
    entry.definition = definition;
    if (context) {
      build(entry);
    } else {
      setLayerState(entry, "ready");
    }
  };

  const startLoad = (entry: LayerEntry) => {
    const sound = findSound(entry.id);
    if (!sound) {
      setLayerState(entry, `failed: Unknown sound "${entry.id}"`);
      return;
    }
    const cached = loader.get(entry.id);
    if (cached) {
      loaded(entry, cached);
      return;
    }
    setLayerState(entry, "loading");
    entry.load.run(
      loader.load(sound),
      (definition) => {
        loaded(entry, definition);
      },
      (error) => {
        setLayerState(entry, `failed: ${describeError(error)}`);
      },
    );
  };

  const addLayer = (layer: Layer) => {
    const entry: LayerEntry = {
      id: layer.id,
      layer,
      state: undefined,
      definition: undefined,
      load: createLatest<SoundDefinition>(),
      voice: undefined,
    };
    layers.set(layer.id, entry);
    startLoad(entry);
  };

  const removeLayer = (entry: LayerEntry) => {
    layers.delete(entry.id);
    entry.load.cancel();
    const { voice } = entry;
    entry.voice = undefined;
    if (!voice) {
      return;
    }
    if (!context || !voice.instance || context.state !== "running") {
      release(voice);
      return;
    }
    voice.fadeState = fadeParam(
      voice.fade.gain,
      voice.fadeState,
      0,
      LAYER_FADE_OUT,
      context.currentTime,
    );
    leaving.add(voice);
    whenClockPasses(voice.fadeState.end, () => {
      release(voice);
    });
  };

  /** Creates the context and the master chain, or returns undefined (and fails) if it can't. */
  const ensureContext = (): AudioContext | undefined => {
    if (context) {
      return context;
    }
    let ctx: AudioContext | undefined;
    try {
      ctx = options.createContext();
      const level = ctx.createGain();
      level.gain.value = volumeGain(mix.master);
      const fade = ctx.createGain();
      fade.gain.value = 0;
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = HIGHPASS_HZ;
      highpass.Q.value = HIGHPASS_Q;
      // A limiter, as a safety net: default mixes should hardly touch it.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      const trim = ctx.createGain();
      trim.gain.value = 10 ** (TRIM_DB / 20);
      level.connect(fade).connect(highpass).connect(limiter).connect(trim);
      connectOutput(ctx, trim);
      master = { level, fade };
    } catch (error) {
      console.error("Couldn't start audio:", error);
      ctx?.close().catch(() => undefined);
      setState("failed");
      return undefined;
    }
    context = ctx;
    masterFade = still(0);
    ctx.addEventListener("statechange", onContextState);
    for (const entry of layers.values()) {
      build(entry);
    }
    return ctx;
  };

  const startPlaying = () => {
    if (!context || !master || state === "playing") {
      return;
    }
    masterFade = fadeParam(master.fade.gain, masterFade, 1, PLAY_FADE_IN, context.currentTime);
    setState("playing");
  };

  /** Silences the master at once: only while the context isn't running, so it can't click. */
  const silence = () => {
    if (context && master) {
      const now = context.currentTime;
      master.fade.gain.cancelScheduledValues(now);
      master.fade.gain.setValueAtTime(0, now);
      masterFade = still(0);
    }
  };

  function onContextState() {
    if (disposed || !context) {
      return;
    }
    // Safari adds "interrupted", which the DOM types don't list.
    const contextState: string = context.state;
    if (contextState === "running") {
      if (wantPlaying) {
        startPlaying();
      } else if (state === "paused") {
        // A resume that was pending when the user paused has gone through: nothing
        // should run while paused.
        context.suspend().catch(() => undefined);
      }
    } else if (
      wantPlaying &&
      (contextState === "interrupted" || (contextState === "suspended" && state === "playing"))
    ) {
      silence();
      setState("interrupted");
    }
  }

  const play = async (): Promise<EngineState> => {
    if (disposed) {
      return state;
    }
    wantPlaying = true;
    const token = ++transition;
    const ctx = ensureContext();
    if (!ctx) {
      return state;
    }
    if (ctx.state === "running") {
      startPlaying();
      return state;
    }
    if (state !== "blocked" && state !== "interrupted") {
      setState("starting");
    }
    // Some browsers leave resume() pending, rather than rejecting, until a user
    // gesture; give it a moment, then report that playback is blocked.
    await settleWithin(ctx.resume(), BLOCKED_AFTER_MS);
    if (stale(token)) {
      return state;
    }
    if (isRunning(ctx)) {
      startPlaying();
    } else {
      setState("blocked");
    }
    return state;
  };

  const pause = () => {
    wantPlaying = false;
    const token = ++transition;
    const ctx = context;
    if (disposed || !ctx || !master || state === "paused" || state === "pausing") {
      return;
    }
    if (ctx.state !== "running") {
      // Not sounding (blocked, interrupted or still starting): nothing to fade.
      silence();
      setState("paused");
      if (ctx.state === "suspended") {
        return;
      }
      ctx.suspend().catch(() => undefined);
      return;
    }
    masterFade = fadeParam(master.fade.gain, masterFade, 0, PAUSE_FADE_OUT, ctx.currentTime);
    setState("pausing");
    whenClockPasses(masterFade.end, () => {
      if (token === transition) {
        void suspend(ctx, token);
      }
    });
  };

  /** Suspends after a pause's fade, unless a play or another pause came first. */
  const suspend = async (ctx: AudioContext, token: number) => {
    try {
      await ctx.suspend();
    } catch {
      return;
    }
    if (!stale(token)) {
      setState("paused");
      // The clock has stopped, so layers still fading out can go now.
      for (const voice of Array.from(leaving)) {
        release(voice);
      }
    }
  };

  const setMix = (next: Mix) => {
    if (disposed) {
      return;
    }
    const previous = mix;
    mix = next;
    if (context && master && next.master !== previous.master) {
      master.level.gain.setTargetAtTime(volumeGain(next.master), context.currentTime, GLIDE_TAU);
    }
    const ids = new Set(next.layers.map((l) => l.id));
    for (const entry of Array.from(layers.values())) {
      if (!ids.has(entry.id)) {
        removeLayer(entry);
      }
    }
    for (const layer of next.layers) {
      const entry = layers.get(layer.id);
      if (!entry) {
        addLayer(layer);
      } else if (entry.layer !== layer) {
        const before = entry.layer;
        entry.layer = layer;
        if (before.volume !== layer.volume || before.muted !== layer.muted) {
          applyLevel(entry);
        }
        if (before.params !== layer.params) {
          applyParams(entry);
        }
      }
    }
  };

  const retry = (id: string) => {
    const entry = layers.get(id);
    if (disposed || entry?.state?.startsWith("failed") !== true) {
      return;
    }
    if (entry.definition && context) {
      setLayerState(entry, "loading");
      build(entry);
    } else if (entry.definition) {
      setLayerState(entry, "ready");
    } else {
      startLoad(entry);
    }
  };

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    wantPlaying = false;
    transition++;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    for (const entry of layers.values()) {
      entry.load.cancel();
      if (entry.voice) {
        release(entry.voice);
      }
    }
    layers.clear();
    for (const voice of Array.from(leaving)) {
      release(voice);
    }
    if (context) {
      context.removeEventListener("statechange", onContextState);
      context.close().catch(() => undefined);
    }
  };

  return {
    play,
    pause,
    setMix,
    retry,
    dispose,
    get state() {
      return state;
    },
    get context() {
      return context;
    },
  };
}
