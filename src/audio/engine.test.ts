import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layer, Mix } from "../mixes/mix";
import { createSoundLoader } from "../sounds/loader";
import { SEED_PARAM } from "../sounds/param-options";
import type { SoundEntry } from "../sounds/registry";
import { defineSound, defineSoundMeta, type ParamValues } from "../sounds/types";
import { FakeAudioContext, type FakeNode, type FakeParam } from "../test/fake-audio";
import { FakeMediaElement } from "../test/fake-media";
import {
  BLOCKED_AFTER_MS,
  createAudioEngine,
  LAYER_FADE_IN,
  LAYER_FADE_OUT,
  PAUSE_FADE_OUT,
  PLAY_FADE_IN,
  SLEEP_CANCEL_RAMP,
  type AudioEngine,
  type EngineState,
  type LayerState,
} from "./engine";

/** How a test sound behaves; tests flip these to inject failures. */
interface Behaviour {
  throwOnCreate: boolean;
  throwOnUpdate: boolean;
  /** When set, `create` resolves only when the test calls it. */
  async: boolean;
}

interface Built {
  params: ParamValues;
  seed: number;
  startAt: number;
  updates: { params: ParamValues; when: number }[];
  disposed: number;
  onError: ((error: unknown) => void) | undefined;
}

/** A recording test sound: one oscillator into `out`. */
function testSound(id: string) {
  const behaviour: Behaviour = { throwOnCreate: false, throwOnUpdate: false, async: false };
  const built: Built[] = [];
  const pending: (() => void)[] = [];
  const meta = defineSoundMeta({
    id,
    name: id,
    description: "A test sound.",
    categories: ["Tonal"],
    tags: [],
    cost: "very low",
    tint: "#888888",
    params: {
      level: { kind: "number", label: "Level", min: 0, max: 10, step: 1, default: 5 },
      seed: SEED_PARAM,
    },
  });
  const definition = defineSound(meta, {
    create(ctx, out, init) {
      if (behaviour.throwOnCreate) {
        throw new Error(`${id} broke`);
      }
      const osc = ctx.createOscillator();
      osc.connect(out);
      osc.start(init.startAt);
      const record: Built = {
        params: init.params,
        seed: init.seed,
        startAt: init.startAt,
        updates: [],
        disposed: 0,
        onError: init.onError,
      };
      built.push(record);
      const instance = {
        update(params: ParamValues, when: number) {
          if (behaviour.throwOnUpdate) {
            throw new Error(`${id} update broke`);
          }
          record.updates.push({ params, when });
        },
        dispose() {
          record.disposed++;
          osc.stop();
          osc.disconnect();
        },
      };
      if (!behaviour.async) {
        return instance;
      }
      return new Promise((resolve) => {
        pending.push(() => {
          resolve(instance);
        });
      });
    },
  });
  let load = () => Promise.resolve(definition);
  const entry = {
    ...meta,
    load: () => load(),
  } as unknown as SoundEntry;
  return {
    entry,
    behaviour,
    built,
    /** Resolves the oldest pending async `create`. */
    resolveCreate: () => pending.shift()?.(),
    setLoad: (fn: typeof load) => {
      load = fn;
    },
  };
}

function layer(id: string, change: Partial<Layer> = {}): Layer {
  return { id, volume: 100, muted: false, params: { level: 5, seed: 1 }, ...change };
}

const mixOf = (...layers: Layer[]): Mix => ({ master: 100, layers });

let ctx: FakeAudioContext;
let a: ReturnType<typeof testSound>;
let b: ReturnType<typeof testSound>;
let states: EngineState[];
let layerStates: Map<string, LayerState[]>;
let sleepEnds: number;
let engine: AudioEngine;

function makeEngine(
  createContext: () => AudioContext = () => ctx.asContext(),
  mediaElement?: () => FakeMediaElement | undefined,
) {
  const sounds = new Map([a, b].map((s) => [s.entry.id, s.entry]));
  return createAudioEngine({
    createContext,
    mediaElement,
    loader: createSoundLoader(),
    findSound: (id) => sounds.get(id),
    onState: (s) => {
      states.push(s);
    },
    onLayerState: (id, s) => {
      layerStates.set(id, [...(layerStates.get(id) ?? []), s]);
    },
    onSleepEnd: () => {
      sleepEnds++;
    },
  });
}

const lastLayerState = (id: string) => layerStates.get(id)?.at(-1);

/** Lets pending promises (loads, async creates, resume) settle. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Moves the audio clock and the timers on together. */
async function tick(seconds: number) {
  ctx.advance(seconds);
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

/** The engine's nodes, found by walking connections back from the destination. */
function chain() {
  const into = (target: FakeNode) => {
    const found = ctx.nodes.find((n) => n.connections.includes(target));
    if (!found) {
      throw new Error(`Nothing connects to ${target.kind}`);
    }
    return found;
  };
  const trim = into(ctx.destination);
  const limiter = into(trim);
  const highpass = into(limiter);
  const timer = into(highpass);
  const masterFade = into(timer);
  const masterMute = into(masterFade);
  const masterLevel = into(masterMute);
  return { trim, limiter, highpass, timer, masterFade, masterMute, masterLevel };
}

function param(node: FakeNode | undefined, name: string): FakeParam {
  const found = node?.params().find((p) => p.name === name);
  if (!found) {
    throw new Error(`No param ${name}`);
  }
  return found;
}

/** The level gain a sound's oscillator feeds (the nth oscillator made), then its solo and fade. */
function gainsOf(nth: number) {
  const osc = ctx.nodes.filter((n) => n.kind === "oscillator").at(nth);
  const level = osc?.connections.at(0) as FakeNode | undefined;
  const solo = level?.connections.at(0) as FakeNode | undefined;
  const fade = solo?.connections.at(0) as FakeNode | undefined;
  return {
    level: param(level, "gain"),
    solo: param(solo, "gain"),
    fade: param(fade, "gain"),
    levelNode: level,
    fadeNode: fade,
  };
}

beforeEach(() => {
  ctx = new FakeAudioContext();
  a = testSound("a");
  b = testSound("b");
  states = [];
  layerStates = new Map();
  sleepEnds = 0;
  engine = makeEngine();
});

afterEach(() => {
  engine.dispose();
});

describe("the context", () => {
  it("is created on the first play, not before", async () => {
    engine.setMix(mixOf(layer("a")));
    await flush();
    expect(engine.context).toBeUndefined();
    expect(lastLayerState("a")).toBe("ready");
    expect(a.built).toHaveLength(0);
    await expect(engine.play()).resolves.toBe("playing");
    expect(engine.context).toBe(ctx);
    expect(a.built).toHaveLength(1);
  });

  it("builds the master chain: high-pass, limiter and trim into the destination", async () => {
    await engine.play();
    await flush();
    const { trim, limiter, highpass, masterFade, masterLevel } = chain();
    expect(param(trim, "gain").value).toBeCloseTo(10 ** (-1 / 20));
    expect(limiter.kind).toBe("compressor");
    expect(param(limiter, "threshold").value).toBe(-3);
    expect(param(limiter, "knee").value).toBe(0);
    expect(param(limiter, "ratio").value).toBe(20);
    expect(param(limiter, "attack").value).toBe(0.003);
    expect(param(limiter, "release").value).toBe(0.25);
    expect(highpass.kind).toBe("biquad");
    expect(param(highpass, "frequency").value).toBe(25);
    expect(param(highpass, "Q").value).toBe(0.7);
    expect(masterFade.kind).toBe("gain");
    expect(masterLevel.kind).toBe("gain");
  });

  it("routes the output through connectOutput when given", async () => {
    const outputs: unknown[] = [];
    engine = createAudioEngine({
      createContext: () => ctx.asContext(),
      loader: createSoundLoader(),
      onState: () => undefined,
      onLayerState: () => undefined,
      connectOutput: (_ctx, output) => {
        outputs.push(output);
      },
    });
    await engine.play();
    await flush();
    expect(outputs).toHaveLength(1);
    expect(ctx.nodes.some((n) => n.connections.includes(ctx.destination))).toBe(false);
  });

  it("fails when the context can't be created", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    engine = makeEngine(() => {
      throw new Error("no audio");
    });
    await expect(engine.play()).resolves.toBe("failed");
    expect(states).toEqual(["failed"]);
  });

  it("closes the context and disposes every sound on dispose", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    engine.dispose();
    expect(ctx.state).toBe("closed");
    expect(a.built[0]?.disposed).toBe(1);
    expect(b.built[0]?.disposed).toBe(1);
  });
});

describe("play and pause", () => {
  it("fades the master in over the play fade", async () => {
    await engine.play();
    await flush();
    const fade = param(chain().masterFade, "gain");
    expect(fade.valueAt(0)).toBe(0);
    expect(fade.valueAt(PLAY_FADE_IN / 2)).toBeCloseTo(0.5);
    expect(fade.valueAt(PLAY_FADE_IN)).toBe(1);
    expect(states).toEqual(["playing"]);
  });

  it("fades in over the time set, from the next play on", async () => {
    engine.setPlayFadeIn(10);
    await engine.play();
    await flush();
    const fade = param(chain().masterFade, "gain");
    expect(fade.valueAt(5)).toBeCloseTo(0.5);
    expect(fade.valueAt(10)).toBe(1);
    await tick(11);
    engine.pause();
    await tick(1);
    engine.setPlayFadeIn(0.1);
    await engine.play();
    await flush();
    expect(fade.valueAt(ctx.currentTime + 0.05)).toBeCloseTo(0.5);
    expect(fade.valueAt(ctx.currentTime + 0.1)).toBe(1);
  });

  it("takes its first fade-in time from the options", async () => {
    engine.dispose();
    engine = createAudioEngine({
      createContext: () => ctx.asContext(),
      loader: createSoundLoader(),
      onState: () => undefined,
      onLayerState: () => undefined,
      playFadeIn: 30,
    });
    await engine.play();
    await flush();
    expect(param(chain().masterFade, "gain").valueAt(15)).toBeCloseTo(0.5);
  });

  it("fades out over the pause fade, then suspends the context", async () => {
    await engine.play();
    await flush();
    const at = PLAY_FADE_IN + 1;
    await tick(at);
    engine.pause();
    expect(states).toEqual(["playing", "pausing"]);
    const fade = param(chain().masterFade, "gain");
    expect(fade.valueAt(at)).toBe(1);
    expect(fade.valueAt(at + PAUSE_FADE_OUT)).toBe(0);
    await tick(PAUSE_FADE_OUT / 2);
    expect(ctx.calls).not.toContain("suspend");
    await tick(PAUSE_FADE_OUT);
    expect(ctx.calls).toContain("suspend");
    expect(ctx.state).toBe("suspended");
    expect(states).toEqual(["playing", "pausing", "paused"]);
  });

  it("waits for the audio clock, not the timer, before suspending", async () => {
    await engine.play();
    await flush();
    engine.pause();
    // A timer that fires while the clock lags (as when it's throttled the other way
    // round) checks again rather than cutting the fade short.
    await vi.advanceTimersByTimeAsync(PAUSE_FADE_OUT * 1000 * 3);
    expect(ctx.calls).not.toContain("suspend");
    await tick(PAUSE_FADE_OUT);
    expect(ctx.calls).toContain("suspend");
  });

  it("keeps the layers built while paused and resumes them", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.pause();
    await tick(1);
    await expect(engine.play()).resolves.toBe("playing");
    expect(a.built).toHaveLength(1);
    expect(a.built[0]?.disposed).toBe(0);
    expect(ctx.state).toBe("running");
    expect(states).toEqual(["playing", "pausing", "paused", "starting", "playing"]);
  });

  it("cancels the suspend when play comes during the pause fade", async () => {
    await engine.play();
    await flush();
    await tick(PLAY_FADE_IN + 1);
    engine.pause();
    await tick(PAUSE_FADE_OUT / 2);
    await engine.play();
    await flush();
    await tick(PLAY_FADE_IN + 1);
    expect(ctx.calls).not.toContain("suspend");
    expect(states.at(-1)).toBe("playing");
    const fade = param(chain().masterFade, "gain");
    expect(fade.valueAt(ctx.currentTime)).toBe(1);
  });

  it("reports blocked when the browser won't start audio, then plays on a later play", async () => {
    ctx = new FakeAudioContext({ allowed: false });
    const result = engine.play();
    await vi.advanceTimersByTimeAsync(BLOCKED_AFTER_MS);
    await expect(result).resolves.toBe("blocked");
    expect(states).toEqual(["starting", "blocked"]);
    ctx.allowed = true;
    await expect(engine.play()).resolves.toBe("playing");
  });

  it("starts playing when a blocked context starts by itself", async () => {
    ctx = new FakeAudioContext({ allowed: false });
    const result = engine.play();
    await vi.advanceTimersByTimeAsync(BLOCKED_AFTER_MS);
    await result;
    ctx.setState("running");
    expect(states.at(-1)).toBe("playing");
  });

  it("pauses a blocked engine without fading", async () => {
    ctx = new FakeAudioContext({ allowed: false });
    const result = engine.play();
    await vi.advanceTimersByTimeAsync(BLOCKED_AFTER_MS);
    await result;
    engine.pause();
    expect(states.at(-1)).toBe("paused");
  });

  it("suspends again if a pending resume goes through after a pause", async () => {
    ctx = new FakeAudioContext({ allowed: false });
    const result = engine.play();
    await vi.advanceTimersByTimeAsync(BLOCKED_AFTER_MS);
    await result;
    engine.pause();
    ctx.allowed = true;
    await ctx.resume();
    expect(ctx.state).toBe("suspended");
    expect(states.at(-1)).toBe("paused");
  });

  it("reports an interruption and recovers from it", async () => {
    await engine.play();
    await flush();
    ctx.setState("interrupted");
    expect(states.at(-1)).toBe("interrupted");
    ctx.setState("running");
    expect(states.at(-1)).toBe("playing");
  });

  it("treats an unexpected suspend while playing as an interruption", async () => {
    await engine.play();
    await flush();
    ctx.setState("suspended");
    expect(states.at(-1)).toBe("interrupted");
  });
});

describe("media element output", () => {
  let element: FakeMediaElement;
  let asked: number;

  beforeEach(() => {
    element = new FakeMediaElement();
    asked = 0;
    engine = makeEngine(undefined, () => {
      asked++;
      return element;
    });
  });

  it("plays the output through the element instead of the destination", async () => {
    await expect(engine.play()).resolves.toBe("playing");
    const stream = ctx.nodes.find((n) => n.kind === "media-stream-destination");
    expect(stream).toBeDefined();
    expect(ctx.nodes.some((n) => n.connections.includes(ctx.destination))).toBe(false);
    const trim = ctx.nodes.find((n) => stream !== undefined && n.connections.includes(stream));
    expect(trim?.kind).toBe("gain");
    expect(element.srcObject).toBe((stream as unknown as { stream: object }).stream);
    expect(element.calls).toEqual(["play"]);
    expect(element.paused).toBe(false);
    await engine.play();
    expect(asked).toBe(1);
  });

  it("pauses the element once the pause has suspended the context", async () => {
    await engine.play();
    await flush();
    engine.pause();
    expect(element.paused).toBe(false);
    await tick(PAUSE_FADE_OUT);
    await flush();
    expect(ctx.state).toBe("suspended");
    expect(element.paused).toBe(true);
    expect(states).toEqual(["playing", "pausing", "paused"]);
    await expect(engine.play()).resolves.toBe("playing");
    expect(element.calls).toEqual(["play", "pause", "play"]);
  });

  it("follows the element when something outside pauses it, and stays paused", async () => {
    await engine.play();
    await flush();
    element.pauseFromOutside();
    await flush();
    expect(states.at(-1)).toBe("pausing");
    await tick(PAUSE_FADE_OUT);
    await flush();
    expect(states.at(-1)).toBe("paused");
    expect(ctx.state).toBe("suspended");
    // The context running again (as when the other app lets go) doesn't resume.
    ctx.setState("running");
    await flush();
    expect(ctx.state).toBe("suspended");
    expect(states.at(-1)).toBe("paused");
    expect(element.calls.filter((call) => call === "play")).toHaveLength(1);
  });

  it("ignores the pause event of a pause that a play has already overtaken", async () => {
    await engine.play();
    await flush();
    engine.pause();
    await tick(PAUSE_FADE_OUT);
    // The element's pause event is still queued when play starts it again.
    const playing = engine.play();
    await flush();
    await playing;
    expect(states.at(-1)).toBe("playing");
    expect(element.paused).toBe(false);
  });

  it("rides out an interruption that pauses the element, and resumes when it ends", async () => {
    await engine.play();
    await flush();
    ctx.setState("interrupted");
    element.pauseFromOutside();
    await flush();
    expect(states.at(-1)).toBe("interrupted");
    expect(ctx.calls).not.toContain("suspend");
    ctx.setState("running");
    await flush();
    expect(states.at(-1)).toBe("playing");
    expect(element.calls).toEqual(["play", "play"]);
    expect(element.paused).toBe(false);
  });

  it("shows Play after an interruption that the platform never ends", async () => {
    await engine.play();
    await flush();
    ctx.setState("interrupted");
    await tick(60);
    expect(states.at(-1)).toBe("interrupted");
    await expect(engine.play()).resolves.toBe("playing");
  });

  it("blocks, and suspends the context, when the element won't play without a gesture", async () => {
    element.allowed = false;
    await expect(engine.play()).resolves.toBe("blocked");
    expect(ctx.state).toBe("suspended");
    element.allowed = true;
    await expect(engine.play()).resolves.toBe("playing");
    expect(element.paused).toBe(false);
    expect(ctx.state).toBe("running");
  });

  it("blocks when the element refuses while the context is still starting", async () => {
    ctx = new FakeAudioContext({ allowed: false });
    element.allowed = false;
    const result = engine.play();
    await vi.advanceTimersByTimeAsync(BLOCKED_AFTER_MS);
    await expect(result).resolves.toBe("blocked");
    // A resume that goes through later still leaves nothing running unheard.
    ctx.allowed = true;
    await ctx.resume();
    await flush();
    expect(ctx.state).toBe("suspended");
    expect(states.at(-1)).toBe("blocked");
  });

  it("lets go of the element on dispose", async () => {
    await engine.play();
    await flush();
    expect(element.listenerCount).toBe(1);
    engine.dispose();
    expect(element.listenerCount).toBe(0);
    expect(element.paused).toBe(true);
    expect(element.srcObject).toBeNull();
  });
});

describe("setMix", () => {
  it("builds an added layer at the current time and fades it in", async () => {
    await engine.play();
    await flush();
    await tick(3);
    engine.setMix(mixOf(layer("a", { volume: 70, params: { level: 7, seed: 42 } })));
    await flush();
    expect(a.built).toHaveLength(1);
    expect(a.built[0]).toMatchObject({ params: { level: 7, seed: 42 }, seed: 42, startAt: 3 });
    const { level, fade } = gainsOf(0);
    expect(level.value).toBeCloseTo(0.49);
    expect(fade.valueAt(3)).toBe(0);
    expect(fade.valueAt(3 + LAYER_FADE_IN / 2)).toBeCloseTo(0.5);
    expect(fade.valueAt(3 + LAYER_FADE_IN)).toBe(1);
    expect(layerStates.get("a")).toEqual(["loading", "ready"]);
  });

  it("coerces params against the sound's schema", async () => {
    await engine.play();
    await flush();
    engine.setMix(mixOf(layer("a", { params: { level: 99, extra: 1 } })));
    await flush();
    expect(a.built[0]?.params).toEqual({ level: 10, seed: 1 });
  });

  it("fades a removed layer out, then disposes it once the clock passes the fade", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    await tick(2);
    const { fade, levelNode } = gainsOf(0);
    engine.setMix(mixOf(layer("b")));
    expect(fade.valueAt(2)).toBe(1);
    expect(fade.valueAt(2 + LAYER_FADE_OUT)).toBe(0);
    await tick(LAYER_FADE_OUT / 2);
    expect(a.built[0]?.disposed).toBe(0);
    // A timer firing early (or late) only checks the clock again.
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.built[0]?.disposed).toBe(0);
    await tick(LAYER_FADE_OUT);
    expect(a.built[0]?.disposed).toBe(1);
    expect(levelNode?.connections).toEqual([]);
    expect(b.built[0]?.disposed).toBe(0);
  });

  it("disposes a removed layer at once while paused", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.pause();
    await tick(1);
    engine.setMix(mixOf());
    expect(a.built[0]?.disposed).toBe(1);
  });

  it("disposes layers still fading out when the pause suspends", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.setMix(mixOf());
    engine.pause();
    await tick(PAUSE_FADE_OUT);
    expect(a.built[0]?.disposed).toBe(1);
  });

  it("glides volume and mute changes", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    await tick(1);
    engine.setMix(mixOf(layer("a", { volume: 50 })));
    const { level } = gainsOf(0);
    expect(level.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0.25, 1, 0.08] });
    engine.setMix(mixOf(layer("a", { volume: 50, muted: true })));
    expect(level.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0, 1, 0.08] });
    expect(level.assignments).toEqual([1]);
    expect(a.built[0]?.updates).toEqual([]);
  });

  it("glides the master volume on a perceptual curve", async () => {
    await engine.play();
    await flush();
    engine.setMix({ master: 50, layers: [] });
    expect(param(chain().masterLevel, "gain").calls.at(-1)).toEqual({
      method: "setTargetAtTime",
      args: [0.25, 0, 0.08],
    });
  });

  it("updates only the layers whose params changed", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    await tick(1);
    engine.setMix(mixOf(layer("a", { params: { level: 8, seed: 1 } }), layer("b")));
    expect(a.built[0]?.updates).toEqual([{ params: { level: 8, seed: 1 }, when: 1 }]);
    expect(b.built[0]?.updates).toEqual([]);
  });

  it("ignores the order of layers", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    engine.setMix(mixOf(layer("b"), layer("a")));
    await flush();
    expect(a.built).toHaveLength(1);
    expect(b.built).toHaveLength(1);
    expect(a.built[0]?.updates).toEqual([]);
    expect(b.built[0]?.updates).toEqual([]);
  });

  it("drops a load that finishes after its layer was removed", async () => {
    let finish: () => void = () => undefined;
    const definition = await a.entry.load();
    a.setLoad(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve(definition);
          };
        }),
    );
    await engine.play();
    await flush();
    engine.setMix(mixOf(layer("a")));
    expect(lastLayerState("a")).toBe("loading");
    engine.setMix(mixOf());
    finish();
    await flush();
    expect(a.built).toHaveLength(0);
  });

  it("reports a failed load, and retries it", async () => {
    a.setLoad(() => Promise.reject(new Error("offline")));
    await engine.play();
    await flush();
    engine.setMix(mixOf(layer("a")));
    await flush();
    expect(lastLayerState("a")).toBe("failed: offline");
    const definition = await testSound("a").entry.load();
    a.setLoad(() => Promise.resolve(definition));
    engine.retry("a");
    await flush();
    expect(lastLayerState("a")).toBe("ready");
  });

  it("fails an unknown sound", async () => {
    engine.setMix(mixOf(layer("nope")));
    await flush();
    expect(lastLayerState("nope")).toBe('failed: Unknown sound "nope"');
  });
});

describe("async create", () => {
  it("attaches the sound when create resolves", async () => {
    a.behaviour.async = true;
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    expect(lastLayerState("a")).toBe("loading");
    a.resolveCreate();
    await flush();
    expect(layerStates.get("a")).toEqual(["loading", "ready"]);
    expect(gainsOf(0).fade.valueAt(LAYER_FADE_IN)).toBe(1);
  });

  it("passes on params that changed while create ran", async () => {
    a.behaviour.async = true;
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.setMix(mixOf(layer("a", { params: { level: 2, seed: 1 } })));
    a.resolveCreate();
    await flush();
    expect(a.built[0]?.updates.map((u) => u.params)).toEqual([{ level: 2, seed: 1 }]);
  });

  it("disposes a sound whose layer was removed while it was created", async () => {
    a.behaviour.async = true;
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.setMix(mixOf());
    a.resolveCreate();
    await flush();
    expect(a.built[0]?.disposed).toBe(1);
  });
});

describe("crash isolation", () => {
  it("fails a layer whose create throws, and keeps the others playing", async () => {
    b.behaviour.throwOnCreate = true;
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    expect(lastLayerState("a")).toBe("ready");
    expect(lastLayerState("b")).toBe("failed: b broke");
    expect(states.at(-1)).toBe("playing");
    expect(a.built[0]?.disposed).toBe(0);
    // Its gains are gone too: what's left is a's level, solo and fade, and the
    // master's level, mute, fade, sleep timer and trim.
    const levels = ctx.nodes.filter((n) => n.kind === "gain" && n.connections.length > 0);
    expect(levels).toHaveLength(3 + 5);
  });

  it("rebuilds a failed layer on retry", async () => {
    b.behaviour.throwOnCreate = true;
    engine.setMix(mixOf(layer("b")));
    await engine.play();
    await flush();
    b.behaviour.throwOnCreate = false;
    engine.retry("b");
    expect(layerStates.get("b")).toEqual(["loading", "failed: b broke", "loading", "ready"]);
    expect(b.built).toHaveLength(1);
  });

  it("ignores retry for a layer that hasn't failed", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.retry("a");
    expect(a.built).toHaveLength(1);
  });

  it("fails and disposes a layer whose update throws", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    a.behaviour.throwOnUpdate = true;
    engine.setMix(mixOf(layer("a", { params: { level: 1, seed: 1 } }), layer("b")));
    expect(lastLayerState("a")).toBe("failed: a update broke");
    expect(a.built[0]?.disposed).toBe(1);
    expect(b.built[0]?.disposed).toBe(0);
  });

  it("fails a layer that reports a late error, such as a crashed worklet", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    a.built[0]?.onError?.(new Error("processor crashed"));
    expect(lastLayerState("a")).toBe("failed: processor crashed");
    expect(a.built[0]?.disposed).toBe(1);
    expect(lastLayerState("b")).toBe("ready");
    // A second report from the same, already failed sound changes nothing.
    a.built[0]?.onError?.(new Error("again"));
    expect(lastLayerState("a")).toBe("failed: processor crashed");
  });
});

describe("solo", () => {
  it("silences the layers that aren't soloed, and clears", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    await tick(1);
    engine.setSolo(new Set(["a"]));
    // The soloed layer was already at full level, so it isn't touched.
    expect(gainsOf(0).solo.calls).toHaveLength(0);
    expect(gainsOf(1).solo.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0, 1, 0.08] });
    engine.setSolo(new Set());
    expect(gainsOf(1).solo.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [1, 1, 0.08] });
  });

  it("combines with mute: a muted soloed layer stays silent, and mute keeps its own gain", async () => {
    engine.setMix(mixOf(layer("a", { muted: true }), layer("b")));
    await engine.play();
    await flush();
    engine.setSolo(new Set(["a"]));
    const a0 = gainsOf(0);
    const b0 = gainsOf(1);
    expect(a0.level.value).toBe(0);
    expect(a0.solo.value).toBe(1);
    expect(b0.level.value).toBe(1);
    expect(b0.solo.valueAt(1)).toBeCloseTo(0, 3);
    // Unmuting the soloed layer brings it back; the other stays silent.
    engine.setMix(mixOf(layer("a"), layer("b")));
    expect(a0.level.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [1, 0, 0.08] });
    expect(b0.solo.valueAt(1)).toBeCloseTo(0, 3);
  });

  it("ends when the soloed layer leaves the mix, and applies to layers added later", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.setSolo(new Set(["b"]));
    // "b" isn't in the mix, so nothing is soloed yet.
    expect(gainsOf(0).solo.value).toBe(1);
    engine.setMix(mixOf(layer("a"), layer("b")));
    await flush();
    expect(gainsOf(0).solo.valueAt(1)).toBeCloseTo(0, 3);
    expect(gainsOf(1).solo.value).toBe(1);
    engine.setMix(mixOf(layer("a")));
    expect(gainsOf(0).solo.valueAt(2)).toBeCloseTo(1, 3);
  });

  it("silences a layer built while another is soloed from the start", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    engine.setSolo(new Set(["a"]));
    await engine.play();
    await flush();
    expect(gainsOf(0).solo.value).toBe(1);
    expect(gainsOf(1).solo.value).toBe(0);
    expect(gainsOf(1).solo.calls).toEqual([]);
  });
});

describe("master mute", () => {
  it("glides the master mute without touching the master volume", async () => {
    engine.setMix({ master: 50, layers: [layer("a")] });
    await engine.play();
    await flush();
    const { masterMute, masterLevel } = chain();
    engine.setMasterMuted(true);
    expect(param(masterMute, "gain").calls.at(-1)).toEqual({
      method: "setTargetAtTime",
      args: [0, 0, 0.08],
    });
    engine.setMasterMuted(false);
    expect(param(masterMute, "gain").calls.at(-1)).toEqual({
      method: "setTargetAtTime",
      args: [1, 0, 0.08],
    });
    expect(param(masterLevel, "gain").calls).toEqual([]);
  });

  it("starts muted when muted before the first play", async () => {
    engine.setMasterMuted(true);
    await engine.play();
    await flush();
    expect(param(chain().masterMute, "gain").value).toBe(0);
  });
});

describe("levels", () => {
  const analysers = () => ctx.nodes.filter((n) => n.kind === "analyser");

  it("makes no analysers until something watches levels", async () => {
    engine.setMix(mixOf(layer("a"), layer("b")));
    await engine.play();
    await flush();
    expect(analysers()).toHaveLength(0);
    expect(engine.getLevel("a")).toBe(0);
    const stop = engine.watchLevels();
    expect(analysers()).toHaveLength(2);
    const { fadeNode } = gainsOf(0);
    expect(fadeNode?.connections).toContain(analysers()[0]);
    stop();
    expect(fadeNode?.connections).not.toContain(analysers()[0]);
    expect(engine.getLevel("a")).toBe(0);
  });

  it("reads a layer's RMS level from its analyser", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.watchLevels();
    const analyser = analysers()[0] as unknown as { fftSize: number; signal: number };
    expect(analyser.fftSize).toBe(256);
    analyser.signal = -0.25;
    expect(engine.getLevel("a")).toBeCloseTo(0.25);
    expect(engine.getLevel("missing")).toBe(0);
  });

  it("gives layers built while watching an analyser, and keeps them until the last watcher stops", async () => {
    const first = engine.watchLevels();
    const second = engine.watchLevels();
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    expect(analysers()).toHaveLength(1);
    first();
    first();
    expect(gainsOf(0).fadeNode?.connections).toContain(analysers()[0]);
    second();
    expect(gainsOf(0).fadeNode?.connections).not.toContain(analysers()[0]);
    // Watching again makes a fresh analyser.
    engine.watchLevels();
    expect(analysers()).toHaveLength(2);
  });

  it("disposes a layer's analyser with the layer", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    engine.watchLevels();
    const analyser = analysers().at(0);
    const { fadeNode } = gainsOf(0);
    engine.pause();
    await tick(1);
    engine.setMix(mixOf());
    expect(fadeNode?.connections).toEqual([]);
    expect(analyser?.connections).toEqual([]);
  });
});

describe("master level", () => {
  const analysers = () => ctx.nodes.filter((n) => n.kind === "analyser");

  it("makes no analyser until something watches the master level", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    expect(analysers()).toHaveLength(0);
    expect(engine.getMasterLevel()).toBe(0);
  });

  it("taps the master output with one 512-sample analyser and reads its RMS level", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    const stop = engine.watchMasterLevel();
    expect(analysers()).toHaveLength(1);
    const analyser = analysers()[0] as unknown as FakeNode & { fftSize: number; signal: number };
    expect(analyser.fftSize).toBe(512);
    const { trim } = chain();
    expect(trim.connections).toContain(analyser);
    analyser.signal = 0.5;
    expect(engine.getMasterLevel()).toBeCloseTo(0.5);
    stop();
    expect(trim.connections).not.toContain(analyser);
    expect(engine.getMasterLevel()).toBe(0);
  });

  it("waits for the context when watched before the first play, and keeps one analyser for every watcher", async () => {
    const first = engine.watchMasterLevel();
    const second = engine.watchMasterLevel();
    expect(analysers()).toHaveLength(0);
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    expect(analysers()).toHaveLength(1);
    first();
    first();
    expect(chain().trim.connections).toContain(analysers()[0]);
    second();
    expect(chain().trim.connections).not.toContain(analysers()[0]);
  });

  it("doesn't take the layer meters' analysers", async () => {
    engine.setMix(mixOf(layer("a")));
    await engine.play();
    await flush();
    const stopMaster = engine.watchMasterLevel();
    const stopLayers = engine.watchLevels();
    expect(analysers()).toHaveLength(2);
    stopLayers();
    expect(engine.getMasterLevel()).toBe(0);
    expect(chain().trim.connections).toContain(analysers()[0]);
    stopMaster();
  });
});

describe("sleep timer", () => {
  const MINUTE = 60;
  const timerGain = () => param(chain().timer, "gain");
  const db = (gain: number) => 20 * Math.log10(gain);

  it("counts down only while playing, by the audio clock", async () => {
    engine.setSleepTimer(10 * MINUTE, MINUTE);
    expect(engine.sleepRemaining()).toBe(10 * MINUTE);
    await engine.play();
    await flush();
    await tick(MINUTE);
    expect(engine.sleepRemaining()).toBeCloseTo(9 * MINUTE);
    engine.pause();
    await tick(1);
    const paused = engine.sleepRemaining() ?? 0;
    // The clock stands still while suspended, and so does the timer.
    await tick(5 * MINUTE);
    expect(engine.sleepRemaining()).toBe(paused);
    await engine.play();
    await tick(MINUTE);
    expect(engine.sleepRemaining()).toBeCloseTo(paused - MINUTE);
  });

  it("fades out evenly in decibels over the fade, on its own gain", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(10 * MINUTE, 5 * MINUTE);
    const gain = timerGain();
    expect(gain.valueAt(5 * MINUTE)).toBe(1);
    expect(db(gain.valueAt(7.5 * MINUTE))).toBeCloseTo(-30, 0);
    expect(gain.valueAt(10 * MINUTE)).toBe(0);
    // Play and pause keep their own gain.
    expect(param(chain().masterFade, "gain").valueAt(10 * MINUTE)).toBe(1);
  });

  it("caps the fade at the timer's length", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(MINUTE, 5 * MINUTE);
    const gain = timerGain();
    expect(db(gain.valueAt(MINUTE / 2))).toBeCloseTo(-30, 0);
    expect(gain.valueAt(MINUTE)).toBe(0);
  });

  it("pauses once the fade has ended, and resets", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(MINUTE, 10);
    await tick(MINUTE - 1);
    expect(states.at(-1)).toBe("playing");
    expect(sleepEnds).toBe(0);
    await tick(1);
    expect(states.at(-1)).toBe("pausing");
    expect(sleepEnds).toBe(1);
    expect(engine.sleepRemaining()).toBeUndefined();
    await tick(1);
    expect(states.at(-1)).toBe("paused");
  });

  it("is silent already when a throttled timer pauses late", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(MINUTE, 10);
    // The clock runs on while timers lag behind.
    ctx.advance(MINUTE + 30);
    expect(timerGain().valueAt(ctx.currentTime)).toBe(0);
    expect(states.at(-1)).toBe("playing");
    await vi.advanceTimersByTimeAsync(MINUTE * 1000);
    expect(states.at(-1)).toBe("pausing");
  });

  it("comes back at full level on the next play after it ran out", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(MINUTE, 10);
    await tick(MINUTE);
    await tick(1);
    await engine.play();
    await flush();
    expect(timerGain().valueAt(ctx.currentTime)).toBe(1);
    const fade = param(chain().masterFade, "gain");
    expect(fade.valueAt(ctx.currentTime + PLAY_FADE_IN / 2)).toBeCloseTo(0.5);
  });

  it("ramps back to full over the cancel ramp when cancelled during the fade", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(2 * MINUTE, MINUTE);
    await tick(1.5 * MINUTE);
    const gain = timerGain();
    const now = ctx.currentTime;
    const faded = gain.valueAt(now);
    expect(faded).toBeLessThan(0.1);
    engine.setSleepTimer(undefined);
    expect(engine.sleepRemaining()).toBeUndefined();
    expect(gain.valueAt(now + SLEEP_CANCEL_RAMP / 2)).toBeCloseTo((faded + 1) / 2);
    expect(gain.valueAt(now + SLEEP_CANCEL_RAMP)).toBe(1);
    expect(gain.valueAt(now + 10 * MINUTE)).toBe(1);
    await tick(10 * MINUTE);
    expect(states.at(-1)).toBe("playing");
    expect(sleepEnds).toBe(0);
  });

  it("restores the level at once when cancelled while paused", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(2 * MINUTE, MINUTE);
    await tick(1.5 * MINUTE);
    engine.pause();
    await tick(1);
    engine.setSleepTimer(undefined);
    expect(timerGain().valueAt(ctx.currentTime)).toBe(1);
  });

  it("restarts the countdown when set again, rising first if it had started to fade", async () => {
    await engine.play();
    await flush();
    engine.setSleepTimer(2 * MINUTE, MINUTE);
    await tick(1.5 * MINUTE);
    const now = ctx.currentTime;
    engine.setSleepTimer(15 * MINUTE, 5 * MINUTE);
    expect(engine.sleepRemaining()).toBe(15 * MINUTE);
    const gain = timerGain();
    expect(gain.valueAt(now + SLEEP_CANCEL_RAMP)).toBe(1);
    expect(gain.valueAt(now + 10 * MINUTE)).toBe(1);
    expect(db(gain.valueAt(now + 12.5 * MINUTE))).toBeCloseTo(-30, 0);
    await tick(14 * MINUTE);
    expect(states.at(-1)).toBe("playing");
    await tick(MINUTE);
    expect(states.at(-1)).toBe("pausing");
    expect(sleepEnds).toBe(1);
  });

  it("starts with the first play when set before there is a context", async () => {
    engine.setSleepTimer(MINUTE, 10);
    await tick(5 * MINUTE);
    expect(engine.sleepRemaining()).toBe(MINUTE);
    await engine.play();
    await flush();
    const start = ctx.currentTime;
    expect(timerGain().valueAt(start + MINUTE - 10)).toBe(1);
    expect(timerGain().valueAt(start + MINUTE)).toBe(0);
    await tick(MINUTE);
    expect(sleepEnds).toBe(1);
  });
});
