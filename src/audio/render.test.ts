import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layer } from "../mixes/mix";
import type { SoundEntry } from "../sounds/registry";
import { defineSound, defineSoundMeta, type ParamValues } from "../sounds/types";
import {
  FakeAudioContext,
  installFakeAudioGlobals,
  type FakeNode,
  type FakeParam,
} from "../test/fake-audio";
import { createSend, getReverb } from "./reverb";
import { buildMix, renderMix } from "./render";
import { withAudioScope } from "./scope";

interface Built {
  params: ParamValues;
  seed: number;
  startAt: number;
  disposed: boolean;
}

const built: Built[] = [];

/** A sound that plays an oscillator into its output and sends it to the hall reverb. */
function testSound(id: string): SoundEntry {
  const meta = defineSoundMeta({
    id,
    name: id,
    description: "A test sound with reverb.",
    categories: ["Tonal"],
    tags: [],
    cost: "very low",
    tint: "#888888",
    params: {
      pitch: { kind: "number", label: "Pitch", min: 100, max: 1000, step: 1, default: 440 },
      seed: { kind: "number", label: "Variation", min: 1, max: 100, step: 1, default: 1 },
    },
  });
  const definition = defineSound(meta, {
    create(ctx, out, init) {
      return withAudioScope((scope) => {
        const osc = scope.addSource(new OscillatorNode(ctx));
        osc.connect(out);
        createSend(ctx, scope, osc, out, "hall", -12);
        osc.start(init.startAt);
        const record: Built = { ...init, disposed: false };
        built.push(record);
        return {
          update: () => undefined,
          dispose: () => {
            record.disposed = true;
            scope.dispose();
          },
        };
      }, init.onError);
    },
  });
  return { ...meta, load: () => Promise.resolve(definition) };
}

const sounds = new Map(["x", "y", "z"].map((id) => [id, testSound(id)]));
const findSound = (id: string) => sounds.get(id);

const layer = (id: string, change: Partial<Layer> = {}): Layer => ({
  id,
  volume: 100,
  muted: false,
  params: {},
  ...change,
});

const gain = (node: FakeNode | undefined): FakeParam =>
  (node as unknown as { gain: FakeParam }).gain;

let ctx: FakeAudioContext;
let uninstall: () => void = () => undefined;

beforeEach(() => {
  uninstall = installFakeAudioGlobals();
  ctx = new FakeAudioContext();
  built.length = 0;
});

afterEach(() => {
  uninstall();
});

describe("buildMix", () => {
  it("builds each unmuted layer at its gain into the master chain, with coerced params", async () => {
    const mix = {
      master: 50,
      layers: [
        layer("x", { volume: 70, params: { pitch: 5000, seed: 7 } }),
        layer("y", { muted: true }),
        layer("z", { volume: 0 }),
      ],
    };
    const graph = await buildMix(ctx.asContext(), mix, { startAt: 30, findSound });
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ params: { pitch: 1000, seed: 7 }, seed: 7, startAt: 30 });
    const master = graph.master.level as unknown as FakeNode;
    expect(gain(master).value).toBeCloseTo(0.25);
    expect(graph.master.output as unknown as FakeNode).toSatisfy((output: FakeNode) =>
      output.connections.includes(ctx.destination),
    );
    const level = ctx.nodes.find((n) => n.kind === "gain" && n.connections.includes(master));
    expect(gain(level).value).toBeCloseTo(0.49);
  });

  it("sends the reverb through a bus at the layer's gain into one shared convolver", async () => {
    const mix = { master: 100, layers: [layer("x", { volume: 50 }), layer("y")] };
    const graph = await buildMix(ctx.asContext(), mix, { startAt: 0, findSound });
    const convolver = getReverb(ctx.asContext(), "hall") as unknown as FakeNode;
    expect(ctx.nodes.filter((n) => n.kind === "convolver")).toEqual([convolver]);
    expect(convolver.connections).toEqual([graph.master.level]);
    const buses = ctx.nodes.filter((n) => n.kind === "gain" && n.connections.includes(convolver));
    expect(buses.map((b) => gain(b).value)).toEqual([0.25, 1]);
  });

  it("disposes every sound and disconnects its gains", async () => {
    const mix = { master: 100, layers: [layer("x"), layer("y")] };
    const graph = await buildMix(ctx.asContext(), mix, { startAt: 0, findSound });
    graph.dispose();
    expect(built.map((b) => b.disposed)).toEqual([true, true]);
    const convolver = getReverb(ctx.asContext(), "hall") as unknown as FakeNode;
    expect(ctx.nodes.filter((n) => n.connections.includes(convolver))).toEqual([]);
    expect((graph.master.output as unknown as FakeNode).connections).toEqual([]);
  });

  it("rejects an unknown sound, releasing what it built", async () => {
    const mix = { master: 100, layers: [layer("x"), layer("nope")] };
    await expect(buildMix(ctx.asContext(), mix, { startAt: 0, findSound })).rejects.toThrow(
      'No sound "nope"',
    );
    expect(built.map((b) => b.disposed)).toEqual([true]);
  });
});

/** A fake offline context whose render is a buffer of the requested length. */
class FakeOfflineContext extends FakeAudioContext {
  readonly length: number;
  rendered = false;

  constructor(length: number, sampleRate: number) {
    super({ sampleRate });
    this.length = length;
  }

  startRendering(): Promise<AudioBuffer> {
    this.rendered = true;
    return Promise.resolve(
      this.createBuffer(2, this.length, this.sampleRate) as unknown as AudioBuffer,
    );
  }
}

describe("renderMix", () => {
  it("renders the mix from startAt in a context of the right length, then releases it", async () => {
    const contexts: FakeOfflineContext[] = [];
    const createContext = (length: number, sampleRate: number) => {
      const offline = new FakeOfflineContext(length, sampleRate);
      contexts.push(offline);
      return offline as unknown as OfflineAudioContext;
    };
    const prepared: unknown[] = [];
    const buffer = await renderMix(
      { master: 100, layers: [layer("x")] },
      {
        seconds: 2.5,
        startAt: 25,
        sampleRate: 44100,
        findSound,
        createContext,
        prepare: (_ctx, graph) => {
          prepared.push(graph.master.output);
        },
      },
    );
    expect(buffer.length).toBe(110250);
    expect(buffer.sampleRate).toBe(44100);
    expect(contexts.map((c) => c.rendered)).toEqual([true]);
    expect(prepared).toHaveLength(1);
    expect(built).toMatchObject([{ startAt: 25, disposed: true }]);
  });
});
