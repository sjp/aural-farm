import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAudioContext, installFakeAudioGlobals, type FakeNode } from "../test/fake-audio";
import { createDrift, createDrifts } from "./drift";
import { DRIFT_PROCESSOR } from "./drift-dsp";
import { createNoise } from "./noise";
import { NOISE_PROCESSOR } from "./noise-dsp";
import { withAudioScope } from "./scope";
import { STOP_MESSAGE } from "./worklet-protocol";

interface WorkletLike extends FakeNode {
  processor: string;
  port: { messages: unknown[] };
}

let uninstall: () => void = () => undefined;
beforeEach(() => {
  uninstall = installFakeAudioGlobals();
});
afterEach(() => {
  uninstall();
});

/** Records the options every `AudioWorkletNode` is made with. */
function recordOptions(): AudioWorkletNodeOptions[] {
  const options: AudioWorkletNodeOptions[] = [];
  const Original = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = function (
    c: BaseAudioContext,
    name: string,
    o: AudioWorkletNodeOptions,
  ) {
    options.push(o);
    return new Original(c, name, o);
  } as unknown as typeof AudioWorkletNode;
  return options;
}

/** A running context whose clock has moved on to `now`. */
function contextAt(now: number) {
  const ctx = new FakeAudioContext();
  ctx.advance(now);
  return ctx;
}

describe("createNoise", () => {
  it("loads the shared module once and makes a source node with the noise options", async () => {
    const ctx = contextAt(3);
    const nodes = await withAudioScope(async (scope) => [
      await createNoise(ctx.asContext(), scope, {
        colour: "pink",
        seed: 4,
        stream: 2,
        channels: 2,
        startAt: 10,
      }),
      await createNoise(ctx.asContext(), scope, {
        colour: "brown",
        seed: 4,
        stream: 3,
        channels: 1,
        startAt: 10,
      }),
    ]);
    expect(ctx.audioWorklet.modules).toHaveLength(1);
    expect(ctx.audioWorklet.modules[0]).toMatch(/audio\.worklet/);
    const [stereo, mono] = ctx.nodes as WorkletLike[];
    expect(nodes).toEqual([stereo, mono]);
    expect(stereo.processor).toBe(NOISE_PROCESSOR);
    expect(stereo.numberOfInputs).toBe(0);
    expect(ctx.nodes).toHaveLength(2);
  });

  it("passes the offset from context time to absolute time", async () => {
    const ctx = contextAt(3);
    const options = recordOptions();
    await withAudioScope((scope) =>
      createNoise(ctx.asContext(), scope, {
        colour: "white",
        seed: 1,
        stream: 1,
        channels: 2,
        startAt: 10,
      }),
    );
    expect(options[0]).toEqual({
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { colour: "white", seed: 1, stream: 1, channels: 2, offset: 7 },
    });
  });

  it("registers the node with the scope: dispose disconnects it and stops its processor", async () => {
    const ctx = contextAt(0);
    const out = ctx.createGain();
    let dispose: () => void = () => undefined;
    await withAudioScope(async (scope) => {
      const noise = await createNoise(ctx.asContext(), scope, {
        colour: "white",
        seed: 1,
        stream: 1,
        channels: 1,
        startAt: 0,
      });
      noise.connect(out as unknown as AudioNode);
      dispose = () => {
        scope.dispose();
      };
    });
    const node = ctx.nodes.find((n) => n.kind === "worklet") as WorkletLike;
    expect(node.connections).toHaveLength(1);
    dispose();
    expect(node.connections).toHaveLength(0);
    expect(node.port.messages).toEqual([STOP_MESSAGE]);
  });

  it("reports a processor crash through the scope's error handler", async () => {
    const ctx = contextAt(0);
    const errors: unknown[] = [];
    await withAudioScope(
      (scope) =>
        createNoise(ctx.asContext(), scope, {
          colour: "white",
          seed: 1,
          stream: 1,
          channels: 1,
          startAt: 0,
        }),
      (error) => {
        errors.push(error);
      },
    );
    const node = ctx.nodes[0] as unknown as { crash: (m: string) => void };
    node.crash("boom");
    expect(errors).toHaveLength(1);
  });

  it("rejects, building nothing, when the module fails to load", async () => {
    const ctx = contextAt(0);
    ctx.audioWorklet.addModule = () => Promise.reject(new Error("Couldn't load"));
    const attempt = withAudioScope((scope) =>
      createNoise(ctx.asContext(), scope, {
        colour: "white",
        seed: 1,
        stream: 1,
        channels: 1,
        startAt: 0,
      }),
    );
    await expect(attempt).rejects.toThrow("Couldn't load");
    expect(ctx.nodes).toHaveLength(0);
  });

  it("releases a node built after its scope was disposed", async () => {
    const ctx = contextAt(0);
    let disposeEarly: () => void = () => undefined;
    const building = withAudioScope((scope) => {
      disposeEarly = () => {
        scope.dispose();
      };
      return createNoise(ctx.asContext(), scope, {
        colour: "white",
        seed: 1,
        stream: 1,
        channels: 1,
        startAt: 0,
      });
    });
    disposeEarly();
    await building;
    const node = ctx.nodes[0] as WorkletLike;
    expect(node.port.messages).toEqual([STOP_MESSAGE]);
  });
});

describe("createDrift", () => {
  it("makes a mono drift source with its options and the absolute-time offset", async () => {
    const ctx = contextAt(2);
    const out = ctx.createGain();
    const options = recordOptions();
    await withAudioScope(async (scope) => {
      const drift = await createDrift(ctx.asContext(), scope, {
        seed: 3,
        stream: 4,
        rate: 0.05,
        octaves: 2,
        startAt: -5,
      });
      drift.connect(out as unknown as AudioNode);
    });
    const node = ctx.nodes.find((n) => n.kind === "worklet") as WorkletLike;
    expect(node.processor).toBe(DRIFT_PROCESSOR);
    expect(node.numberOfInputs).toBe(0);
    expect(node.connections).toEqual([out]);
    expect(options[0]).toEqual({
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        seed: 3,
        drifts: [{ stream: 4, rate: 0.05, octaves: 2 }],
        offset: -7,
      },
    });
  });

  it("runs several drifts in one node, one per channel", async () => {
    const ctx = contextAt(0);
    const options = recordOptions();
    await withAudioScope(async (scope) => {
      await createDrifts(ctx.asContext(), scope, {
        seed: 3,
        drifts: [
          { stream: 4, rate: 0.05, octaves: 2 },
          { stream: 5, rate: 0.02, octaves: 1 },
          { stream: 6, rate: 0.08, octaves: 1 },
        ],
        startAt: 0,
      });
    });
    expect(ctx.nodes.filter((n) => n.kind === "worklet")).toHaveLength(1);
    expect(options[0]).toMatchObject({
      outputChannelCount: [3],
      processorOptions: {
        seed: 3,
        drifts: [
          { stream: 4, rate: 0.05, octaves: 2 },
          { stream: 5, rate: 0.02, octaves: 1 },
          { stream: 6, rate: 0.08, octaves: 1 },
        ],
      },
    });
  });
});
