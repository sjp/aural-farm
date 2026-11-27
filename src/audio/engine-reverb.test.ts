import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layer } from "../mixes/mix";
import { createSoundLoader } from "../sounds/loader";
import type { SoundEntry } from "../sounds/registry";
import { defineSound, defineSoundMeta } from "../sounds/types";
import {
  FakeAudioContext,
  installFakeAudioGlobals,
  type FakeNode,
  type FakeParam,
} from "../test/fake-audio";
import { createAudioEngine, LAYER_FADE_IN, LAYER_FADE_OUT, type AudioEngine } from "./engine";
import { createSend, getReverb } from "./reverb";
import { withAudioScope } from "./scope";

/** A sound that plays an oscillator into its output and sends it to the hall reverb. */
function reverbSound(id: string): SoundEntry {
  const meta = defineSoundMeta({
    id,
    name: id,
    description: "A test sound with reverb.",
    categories: ["Tonal"],
    tags: [],
    cost: "very low",
    tint: "#888888",
    params: {},
  });
  const definition = defineSound(meta, {
    create(ctx, out, init) {
      return withAudioScope((scope) => {
        const osc = scope.addSource(new OscillatorNode(ctx));
        osc.connect(out);
        createSend(ctx, scope, osc, out, "hall", -12);
        osc.start(init.startAt);
        return {
          update: () => undefined,
          dispose: () => {
            scope.dispose();
          },
        };
      }, init.onError);
    },
  });
  return { ...meta, load: () => Promise.resolve(definition) };
}

const layer = (id: string, change: Partial<Layer> = {}): Layer => ({
  id,
  volume: 100,
  muted: false,
  params: {},
  ...change,
});

let ctx: FakeAudioContext;
let engine: AudioEngine;
let uninstall: () => void = () => undefined;

beforeEach(() => {
  uninstall = installFakeAudioGlobals();
  ctx = new FakeAudioContext();
  const sounds = new Map(["x", "y"].map((id) => [id, reverbSound(id)]));
  engine = createAudioEngine({
    createContext: () => ctx.asContext(),
    loader: createSoundLoader(),
    findSound: (id) => sounds.get(id),
    onState: () => undefined,
    onLayerState: () => undefined,
  });
});

afterEach(() => {
  engine.dispose();
  uninstall();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

async function tick(seconds: number) {
  ctx.advance(seconds);
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

const gain = (node: FakeNode | undefined): FakeParam =>
  (node as unknown as { gain: FakeParam }).gain;

/** The reverb bus a layer's send feeds: the send's target, the solo after it and the fade last. */
function busOf(nth: number) {
  const sends = ctx.nodes.filter(
    (n) => n.kind === "gain" && n.connections.some((c) => c === convolver()),
  );
  const fade = sends.at(nth);
  const into = (target: FakeNode | undefined) =>
    ctx.nodes.find((n) => target !== undefined && n.connections.includes(target));
  const solo = into(fade);
  const level = into(solo);
  return { level, solo, fade };
}

const convolver = () => getReverb(ctx.asContext(), "hall") as unknown as FakeNode;

describe("reverb sends in the engine", () => {
  it("routes each layer's send through its own bus into one shared convolver on the master", async () => {
    engine.setMix({ master: 100, layers: [layer("x"), layer("y", { volume: 50 })] });
    await engine.play();
    await flush();
    const shared = convolver();
    expect(ctx.nodes.filter((n) => n.kind === "convolver")).toEqual([shared]);
    // The convolver feeds the master level: the first gain the master chain made.
    expect(shared.connections).toHaveLength(1);
    const x = busOf(0);
    const y = busOf(1);
    expect(x.fade).toBeDefined();
    expect(y.fade).toBeDefined();
    expect(gain(x.level).value).toBeCloseTo(1);
    expect(gain(y.level).value).toBeCloseTo(0.25);
    // The buses fade in with their layers.
    expect(gain(x.fade).valueAt(LAYER_FADE_IN / 2)).toBeCloseTo(0.5);
    expect(gain(x.fade).valueAt(LAYER_FADE_IN)).toBe(1);
  });

  it("applies the layer's volume and mute to its reverb bus", async () => {
    engine.setMix({ master: 100, layers: [layer("x")] });
    await engine.play();
    await flush();
    engine.setMix({ master: 100, layers: [layer("x", { muted: true })] });
    await tick(2);
    expect(gain(busOf(0).level).value).toBeCloseTo(0, 6);
  });

  it("fades a removed layer's bus out and disconnects it, keeping the shared convolver", async () => {
    engine.setMix({ master: 100, layers: [layer("x")] });
    await engine.play();
    await flush();
    await tick(LAYER_FADE_IN);
    const { level, fade } = busOf(0);
    engine.setMix({ master: 100, layers: [] });
    const now = ctx.currentTime;
    expect(gain(fade).valueAt(now + LAYER_FADE_OUT / 2)).toBeCloseTo(0.5);
    await tick(LAYER_FADE_OUT + 0.1);
    expect(level?.connections).toEqual([]);
    expect(fade?.connections).toEqual([]);
    expect(convolver().connections).toHaveLength(1);
  });
});
