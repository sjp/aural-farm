/**
 * The audio engine: turns a `Mix` into a running Web Audio graph and keeps it in
 * step as the mix changes, without clicks.
 *
 *   layer: sound → level (volume × mute) → solo → fade ─┐
 *   layer: sound → level (volume × mute) → solo → fade ─┤
 *   shared reverb (one convolver per kind) ──────────────┤
 *                                                        └→ master level
 *        → master mute → master fade → sleep timer → high-pass 25 Hz → limiter
 *        → trim −1 dB → output (→ destination, or → media stream → <audio> element)
 *
 * A sound's reverb sends go to its layer's reverb bus: for each kind it uses, a
 * level, solo and fade gain chain that copies the layer's own automation, feeding
 * the shared convolver. So a layer's volume, mute, solo and fades apply to what
 * it sends to the reverb as well.
 *
 * Solo and muting everything are listening aids that live outside the `Mix`: while
 * any layer in the mix is soloed, the solo gains of the others glide to zero.
 *
 * Levels for a meter come from one small analyser per layer, tapped after its fade.
 * The analysers exist only while something watches levels (`watchLevels`). The
 * master level (for the backdrop) comes from one more, tapped at the output, which
 * likewise exists only while watched (`watchMasterLevel`).
 *
 * Each sound is crash-isolated: a throw in `create` or `update`, or a crashed
 * worklet, fails that layer alone, and `retry` builds it again. The context is
 * created on the first `play()` and suspended once a pause has faded out, so
 * nothing runs while paused. It keeps playing when the tab is hidden.
 *
 * With a media element (`mediaElement`), the output plays through it, which is
 * what phones need to treat the sound as media (see `chooseOutputRoute`). The
 * element plays while the engine does and is paused once a pause has suspended
 * the context. If something outside the app pauses it (the system handing the
 * audio to another app, a lock-screen control that bypasses Media Session), the
 * engine pauses too and stays paused, since the user chose that. The context's
 * own interruptions (Safari's "interrupted", as during a phone call) resume by
 * themselves when the context runs again.
 *
 * Fades and glides are scheduled on the audio clock. Work that has to wait for
 * the clock (disposing a removed layer, suspending after a pause) polls it with a
 * timer, so a throttled timer in a background tab only makes it late, never early.
 */
import { describeError } from "../lib/errors";
import type { Layer, Mix } from "../mixes/mix";
import { createLatest, type SoundLoader } from "../sounds/loader";
import { getSound } from "../sounds/registry";
import type { ParamValues, SoundDefinition, SoundInstance } from "../sounds/types";
import {
  createMasterChain,
  layerGain,
  seedOf,
  soundParams,
  volumeGain,
  type MasterChain,
} from "./mix-graph";
import type { MediaOutputElement } from "./output";
import { getReverb, routeReverb, type ReverbKind } from "./reverb";

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

/** Whether `state` counts as playing, so that a toggle should pause. */
export function isPlaying(state: EngineState): boolean {
  return state === "playing" || state === "starting";
}

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
/** Samples a level analyser looks at: about 5 ms, enough for a meter. */
const LEVEL_FFT_SIZE = 256;
/** Samples the master level analyser looks at: about 11 ms, a little steadier. */
const MASTER_LEVEL_FFT_SIZE = 512;

interface EngineOptions {
  /** Makes the context, on the first `play()`. Injected so tests can pass a fake. */
  createContext: () => AudioContext;
  loader: SoundLoader;
  onState: (state: EngineState) => void;
  onLayerState: (id: string, state: LayerState) => void;
  /** Connects the master output to the speakers; the default goes to `ctx.destination`. */
  connectOutput?: (ctx: AudioContext, output: AudioNode) => void;
  /**
   * Asked once, when the context is made: an element to play the output through
   * instead of `connectOutput`, or undefined for none.
   */
  mediaElement?: (() => MediaOutputElement | undefined) | undefined;
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
  /**
   * Solos these layers: while any of them is in the mix, every other layer is
   * silent. An empty set clears the solo. It isn't part of the mix.
   */
  setSolo: (ids: ReadonlySet<string>) => void;
  /** Silences (or restores) the master output without touching the master volume. */
  setMasterMuted: (muted: boolean) => void;
  /**
   * Starts measuring layer levels for `getLevel`, and returns a function that stops.
   * The analysers exist only while at least one watcher is active.
   */
  watchLevels: () => () => void;
  /** A layer's current RMS level after its gains (0 = silent, 1 = full scale). */
  getLevel: (id: string) => number;
  /**
   * Starts measuring the master output for `getMasterLevel`, and returns a function
   * that stops. Its one analyser exists only while at least one watcher is active.
   */
  watchMasterLevel: () => () => void;
  /** The master output's current RMS level (0 = silent, 1 = full scale). */
  getMasterLevel: () => number;
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

function sameParams(a: ParamValues, b: ParamValues): boolean {
  return Object.keys(a).every((key) => a[key] === b[key]);
}

/** An analyser's current RMS level, read into `samples` (as long as its `fftSize`). */
function rmsOf(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/** Reads the state afresh: it changes behind TypeScript's back across an await. */
const isRunning = (ctx: BaseAudioContext) => ctx.state === "running";

/** One reverb kind's bus for a layer: gains that follow the layer's level, solo and fade. */
interface WetBus {
  level: GainNode;
  solo: GainNode;
  fade: GainNode;
}

/** A built (or building) layer: its gain stages and the running sound. */
interface Voice {
  level: GainNode;
  solo: GainNode;
  fade: GainNode;
  /** Present only while levels are watched. */
  analyser: AnalyserNode | undefined;
  /** The layer's reverb buses, made when its sound first sends to each kind. */
  wet: Map<ReverbKind, WetBus>;
  fadeState: Fade;
  levelTarget: number;
  soloTarget: number;
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
  /** The element the output plays through, if any. */
  let element: MediaOutputElement | undefined;
  /** Set when the element refused to play (no user gesture), until the next `play()`. */
  let elementRefused = false;
  /** Reverb kinds whose shared convolver feeds the master bus. */
  const reverbReturns = new Set<ReverbKind>();
  let mix: Mix = { master: 100, layers: [] };
  /** Whether the user wants sound: set by `play()`, cleared by `pause()`. */
  let wantPlaying = false;
  /** Bumped by every play and pause, so a stale continuation can tell it is stale. */
  let transition = 0;
  let disposed = false;
  const layers = new Map<string, LayerEntry>();
  /** Removed layers still fading out. */
  const leaving = new Set<Voice>();
  let solo: ReadonlySet<string> = new Set();
  let masterMuted = false;
  /** How many `watchLevels` callers are active. */
  let levelWatchers = 0;
  /** Scratch space for reading an analyser, shared by every layer. */
  const levelSamples = new Float32Array(LEVEL_FFT_SIZE);
  /** How many `watchMasterLevel` callers are active. */
  let masterWatchers = 0;
  let masterAnalyser: AnalyserNode | undefined;
  const masterSamples = new Float32Array(MASTER_LEVEL_FFT_SIZE);
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
    voice.solo.disconnect();
    voice.fade.disconnect();
    voice.analyser?.disconnect();
    voice.analyser = undefined;
    for (const bus of voice.wet.values()) {
      bus.level.disconnect();
      bus.solo.disconnect();
      bus.fade.disconnect();
    }
  };

  /** Whether `id`'s layer should sound, given the solo: 1 if so, 0 if not. */
  const soloGain = (id: string) => {
    const active = [...solo].some((soloed) => layers.has(soloed));
    return !active || solo.has(id) ? 1 : 0;
  };

  const attachAnalyser = (voice: Voice) => {
    if (!context || voice.analyser || voice.released) {
      return;
    }
    const analyser = context.createAnalyser();
    analyser.fftSize = LEVEL_FFT_SIZE;
    voice.fade.connect(analyser);
    voice.analyser = analyser;
  };

  const attachMasterAnalyser = () => {
    if (!context || !master || masterAnalyser || masterWatchers === 0 || disposed) {
      return;
    }
    masterAnalyser = context.createAnalyser();
    masterAnalyser.fftSize = MASTER_LEVEL_FFT_SIZE;
    master.output.connect(masterAnalyser);
  };

  const detachMasterAnalyser = () => {
    if (!masterAnalyser) {
      return;
    }
    master?.output.disconnect(masterAnalyser);
    masterAnalyser.disconnect();
    masterAnalyser = undefined;
  };

  const detachAnalyser = (voice: Voice) => {
    const { analyser } = voice;
    if (!analyser) {
      return;
    }
    voice.analyser = undefined;
    if (!voice.released) {
      voice.fade.disconnect(analyser);
    }
    analyser.disconnect();
  };

  /** Fades a voice (and its reverb buses) to `to` over `seconds`. */
  const fadeVoice = (voice: Voice, to: number, seconds: number, now: number) => {
    const from = voice.fadeState;
    voice.fadeState = fadeParam(voice.fade.gain, from, to, seconds, now);
    for (const bus of voice.wet.values()) {
      fadeParam(bus.fade.gain, from, to, seconds, now);
    }
  };

  /** The input of `voice`'s reverb bus for `kind`, made on first use. */
  const wetInput = (voice: Voice, kind: ReverbKind): AudioNode => {
    const existing = voice.wet.get(kind);
    if (existing) {
      return existing.level;
    }
    if (voice.released) {
      // A send made by a sound that is going away: its gains are disconnected already.
      return voice.level;
    }
    const ctx = context;
    if (!ctx || !master) {
      throw new Error("The audio engine has no context");
    }
    const now = ctx.currentTime;
    const level = ctx.createGain();
    level.gain.value = voice.level.gain.value;
    level.gain.setTargetAtTime(voice.levelTarget, now, GLIDE_TAU);
    const soloStage = ctx.createGain();
    soloStage.gain.value = voice.solo.gain.value;
    soloStage.gain.setTargetAtTime(voice.soloTarget, now, GLIDE_TAU);
    const fade = ctx.createGain();
    fade.gain.value = fadeValue(voice.fadeState, now);
    if (voice.fadeState.end > now) {
      fade.gain.setValueAtTime(fadeValue(voice.fadeState, now), now);
      fade.gain.linearRampToValueAtTime(voice.fadeState.to, voice.fadeState.end);
    }
    const convolver = getReverb(ctx, kind);
    if (!reverbReturns.has(kind)) {
      convolver.connect(master.level);
      reverbReturns.add(kind);
    }
    level.connect(soloStage).connect(fade).connect(convolver);
    voice.wet.set(kind, { level, solo: soloStage, fade });
    return level;
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
    for (const bus of voice.wet.values()) {
      bus.level.gain.setTargetAtTime(target, context.currentTime, GLIDE_TAU);
    }
  };

  const applySolo = (entry: LayerEntry) => {
    const { voice } = entry;
    const target = soloGain(entry.id);
    if (!context || !voice || voice.soloTarget === target) {
      return;
    }
    voice.soloTarget = target;
    voice.solo.gain.setTargetAtTime(target, context.currentTime, GLIDE_TAU);
    for (const bus of voice.wet.values()) {
      bus.solo.gain.setTargetAtTime(target, context.currentTime, GLIDE_TAU);
    }
  };

  const applySoloToAll = () => {
    for (const entry of layers.values()) {
      applySolo(entry);
    }
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
    fadeVoice(voice, 1, LAYER_FADE_IN, context.currentTime);
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
    const soloStage = ctx.createGain();
    const soloTarget = soloGain(entry.id);
    soloStage.gain.value = soloTarget;
    const fade = ctx.createGain();
    fade.gain.value = 0;
    level.connect(soloStage).connect(fade).connect(master.level);
    const params = soundParams(definition, entry.layer.params);
    const voice: Voice = {
      level,
      solo: soloStage,
      fade,
      analyser: undefined,
      wet: new Map(),
      fadeState: still(0),
      levelTarget,
      soloTarget,
      instance: undefined,
      params,
      released: false,
    };
    entry.voice = voice;
    if (levelWatchers > 0) {
      attachAnalyser(voice);
    }
    routeReverb(level, (kind) => wetInput(voice, kind));
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
    fadeVoice(voice, 0, LAYER_FADE_OUT, context.currentTime);
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
      const chain = createMasterChain(ctx);
      chain.level.gain.value = volumeGain(mix.master);
      chain.mute.gain.value = masterMuted ? 0 : 1;
      chain.fade.gain.value = 0;
      const media = options.mediaElement?.();
      if (media) {
        const stream = ctx.createMediaStreamDestination();
        chain.output.connect(stream);
        media.srcObject = stream.stream;
        element = media;
      } else {
        connectOutput(ctx, chain.output);
      }
      master = chain;
    } catch (error) {
      console.error("Couldn't start audio:", error);
      ctx?.close().catch(() => undefined);
      setState("failed");
      return undefined;
    }
    context = ctx;
    masterFade = still(0);
    ctx.addEventListener("statechange", onContextState);
    element?.addEventListener("pause", onElementPause);
    attachMasterAnalyser();
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

  /** Blocks playback after the element refused to play, unless a play or pause came since. */
  const elementRefusedPlay = (token: number) => {
    if (stale(token) || !wantPlaying) {
      return;
    }
    elementRefused = true;
    silence();
    setState("blocked");
    if (context?.state === "running") {
      context.suspend().catch(() => undefined);
    }
  };

  /**
   * Starts the media element, if there is one. If it refuses (it needs a user
   * gesture), playback is blocked, as when the context refuses to start, and the
   * context is suspended so that nothing runs unheard.
   */
  const playElement = (): Promise<unknown> => {
    if (!element) {
      return Promise.resolve();
    }
    elementRefused = false;
    const token = transition;
    return element.play().catch(() => {
      elementRefusedPlay(token);
    });
  };

  /** Follows the element when something outside the engine pauses it. */
  function onElementPause() {
    // Skip the event of the engine's own pause, and one that arrives after a play
    // has started the element again.
    if (disposed || !context || !wantPlaying || element?.paused !== true || elementRefused) {
      return;
    }
    const contextState: string = context.state;
    if (contextState === "interrupted") {
      // Part of the context's interruption, which resumes the element when it ends.
      return;
    }
    pause();
  }

  function onContextState() {
    if (disposed || !context) {
      return;
    }
    // Safari adds "interrupted", which the DOM types don't list.
    const contextState: string = context.state;
    if (contextState === "running") {
      if (wantPlaying && elementRefused) {
        // A resume went through, but the element won't play: nothing would be heard.
        context.suspend().catch(() => undefined);
      } else if (wantPlaying) {
        if (element?.paused === true && state === "interrupted") {
          void playElement();
        }
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
    // Started at once, while the user gesture that called play() still counts.
    const elementStarted = playElement();
    if (ctx.state === "running") {
      startPlaying();
      if (element) {
        await settleWithin(elementStarted, BLOCKED_AFTER_MS);
      }
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
    if (element) {
      await settleWithin(elementStarted, BLOCKED_AFTER_MS);
      if (stale(token)) {
        return state;
      }
    }
    if (elementRefused) {
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
      element?.pause();
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
      element?.pause();
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
    // Adding or removing a soloed layer can start or end the solo.
    applySoloToAll();
  };

  const setSolo = (ids: ReadonlySet<string>) => {
    if (disposed) {
      return;
    }
    solo = new Set(ids);
    applySoloToAll();
  };

  const setMasterMuted = (muted: boolean) => {
    if (disposed || muted === masterMuted) {
      return;
    }
    masterMuted = muted;
    if (context && master) {
      master.mute.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, GLIDE_TAU);
    }
  };

  const watchLevels = () => {
    levelWatchers++;
    if (levelWatchers === 1) {
      for (const entry of layers.values()) {
        if (entry.voice) {
          attachAnalyser(entry.voice);
        }
      }
    }
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      levelWatchers--;
      if (levelWatchers === 0) {
        for (const entry of layers.values()) {
          if (entry.voice) {
            detachAnalyser(entry.voice);
          }
        }
      }
    };
  };

  const getLevel = (id: string) => {
    const analyser = layers.get(id)?.voice?.analyser;
    if (!analyser || disposed) {
      return 0;
    }
    return rmsOf(analyser, levelSamples);
  };

  const watchMasterLevel = () => {
    masterWatchers++;
    attachMasterAnalyser();
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      masterWatchers--;
      if (masterWatchers === 0) {
        detachMasterAnalyser();
      }
    };
  };

  const getMasterLevel = () => {
    if (!masterAnalyser || disposed) {
      return 0;
    }
    return rmsOf(masterAnalyser, masterSamples);
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
    detachMasterAnalyser();
    if (element) {
      element.removeEventListener("pause", onElementPause);
      element.pause();
      element.srcObject = null;
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
    setSolo,
    setMasterMuted,
    watchLevels,
    getLevel,
    watchMasterLevel,
    getMasterLevel,
    dispose,
    get state() {
      return state;
    },
    get context() {
      return context;
    },
  };
}
