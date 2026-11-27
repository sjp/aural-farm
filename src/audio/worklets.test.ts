import { describe, expect, it } from "vitest";
import { FakeAudioContext } from "../test/fake-audio";
import { loadWorklet } from "./worklets";

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
