import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAudioContext, installFakeAudioGlobals } from "../test/fake-audio";
import { withAudioScope } from "./scope";
import { STOP_MESSAGE } from "./worklet-protocol";
import { loadWorklet, startProcessor } from "./worklets";

describe("loadWorklet", () => {
  it("adds a module once per context", async () => {
    const ctx = new FakeAudioContext();
    await Promise.all([loadWorklet(ctx.asContext(), "a.js"), loadWorklet(ctx.asContext(), "a.js")]);
    await loadWorklet(ctx.asContext(), "a.js");
    await loadWorklet(ctx.asContext(), "b.js");
    expect(ctx.audioWorklet.modules).toEqual(["a.js", "b.js"]);
  });

  it("loads the module again in another context", async () => {
    const first = new FakeAudioContext();
    const second = new FakeAudioContext();
    await loadWorklet(first.asContext(), "a.js");
    await loadWorklet(second.asContext(), "a.js");
    expect(first.audioWorklet.modules).toEqual(["a.js"]);
    expect(second.audioWorklet.modules).toEqual(["a.js"]);
  });

  it("forgets a failed load, so it can be retried", async () => {
    const ctx = new FakeAudioContext();
    ctx.audioWorklet.failing.add("a.js");
    await expect(loadWorklet(ctx.asContext(), "a.js")).rejects.toThrow("Couldn't load a.js");
    ctx.audioWorklet.failing.delete("a.js");
    await loadWorklet(ctx.asContext(), "a.js");
    await loadWorklet(ctx.asContext(), "a.js");
    expect(ctx.audioWorklet.modules).toEqual(["a.js", "a.js"]);
  });

  it("explains that an insecure page has no audio worklets", async () => {
    const ctx = new FakeAudioContext();
    Object.defineProperty(ctx, "audioWorklet", { value: undefined });
    await expect(loadWorklet(ctx.asContext(), "a.js")).rejects.toThrow("secure pages");
  });
});

describe("startProcessor", () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => {
    uninstall = installFakeAudioGlobals();
  });
  afterEach(() => {
    uninstall();
  });

  it("loads the module, then starts the processor with its options, offset and params", async () => {
    const ctx = new FakeAudioContext();
    ctx.advance(2);
    let dispose: () => void = () => undefined;
    const node = await withAudioScope(async (scope) => {
      dispose = () => {
        scope.dispose();
      };
      return startProcessor(ctx.asContext(), scope, "events.js", "events", {
        channels: 2,
        startAt: 5,
        processorOptions: { seed: 3 },
        parameterData: { rate: 40 },
      });
    });
    expect(ctx.audioWorklet.modules).toEqual(["events.js"]);
    const fake = ctx.nodes[0] as unknown as {
      processor: string;
      numberOfInputs: number;
      port: { messages: unknown[] };
    };
    expect(fake).toBe(node);
    expect(fake.processor).toBe("events");
    expect(fake.numberOfInputs).toBe(0);
    expect(node.parameters.get("rate")?.value).toBe(40);
    dispose();
    expect(fake.port.messages).toEqual([STOP_MESSAGE]);
  });

  it("gives the node one output per entry when the channels are a list", async () => {
    const ctx = new FakeAudioContext();
    const node = await withAudioScope(async (scope) =>
      startProcessor(ctx.asContext(), scope, "events.js", "events", {
        channels: [2, 2, 3],
        startAt: 0,
        processorOptions: {},
      }),
    );
    expect(node.numberOfOutputs).toBe(3);
  });
});
