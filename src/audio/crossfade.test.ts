import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeAudioContext,
  installFakeAudioGlobals,
  type FakeNode,
  type FakeParam,
} from "../test/fake-audio";
import { createCrossfader } from "./crossfade";
import { withAudioScope } from "./scope";

let uninstall: () => void = () => undefined;
beforeEach(() => {
  uninstall = installFakeAudioGlobals();
});
afterEach(() => {
  uninstall();
});

/** A stand-in graph: one node connected into the crossfader's input, and a dispose count. */
function graphInto(ctx: FakeAudioContext, into: AudioNode, name: string) {
  const node = ctx.createGain();
  node.connect(into as unknown as FakeNode);
  const graph = {
    name,
    node,
    disposed: 0,
    dispose() {
      graph.disposed++;
      node.disconnect();
    },
  };
  return graph;
}

type Graph = ReturnType<typeof graphInto>;

function setup(seconds = 2) {
  const ctx = new FakeAudioContext();
  const out = ctx.createGain();
  const graphs: Graph[] = [];
  let disposeScope: () => void = () => undefined;
  const fader = withAudioScope((scope) => {
    disposeScope = () => {
      scope.dispose();
    };
    return createCrossfader(ctx.asContext(), scope, out as unknown as AudioNode, seconds);
  });
  const swapTo = (name: string) =>
    fader.swap((into) => {
      const graph = graphInto(ctx, into, name);
      graphs.push(graph);
      return graph;
    });
  /** The fader gain feeding graph `i`. */
  const gainOf = (i: number): FakeParam => {
    const target = graphs[i]?.node.connections[0] as unknown as { gain: FakeParam };
    return target.gain;
  };
  /** The silent timers that end fades. */
  const timers = () => ctx.nodes.filter((n) => n.kind === "constant");
  return { ctx, out, fader, graphs, swapTo, gainOf, timers, disposeScope };
}

const end = (node: FakeNode) => {
  node.dispatchEvent(new Event("ended"));
};

describe("createCrossfader", () => {
  it("starts the first graph at full level", async () => {
    const { ctx, out, swapTo, gainOf } = setup();
    await swapTo("a");
    expect(gainOf(0).valueAt(ctx.currentTime)).toBe(1);
    expect(ctx.nodes.some((n) => n.connections.includes(out))).toBe(true);
  });

  it("crossfades equal-power, then disposes the old graph when its fade ends", async () => {
    const { ctx, swapTo, gainOf, graphs, timers } = setup(2);
    await swapTo("a");
    ctx.advance(1);
    await swapTo("b");
    const [a, b] = [gainOf(0), gainOf(1)];
    for (const t of [1, 1.5, 2, 2.5, 3]) {
      expect(a.valueAt(t) ** 2 + b.valueAt(t) ** 2).toBeCloseTo(1, 2);
    }
    expect(a.valueAt(3)).toBeCloseTo(0, 6);
    expect(b.valueAt(3)).toBeCloseTo(1, 6);
    expect(a.calls.some((c) => c.method === "setValueCurveAtTime")).toBe(true);
    expect(a.assignments).toEqual([]);
    const [timer] = timers();
    expect(timer).toBeDefined();
    expect(graphs[0]?.disposed).toBe(0);
    end(timer);
    expect(graphs[0]?.disposed).toBe(1);
    expect(graphs[1]?.disposed).toBe(0);
    expect(timers().every((n) => n.connections.length === 0)).toBe(true);
  });

  it("swaps again mid-fade, fading the incoming graph out from where it had got to", async () => {
    const { ctx, swapTo, gainOf, graphs, timers } = setup(2);
    await swapTo("a");
    await swapTo("b");
    ctx.advance(1);
    const reached = gainOf(1).valueAt(1);
    expect(reached).toBeCloseTo(Math.SQRT1_2, 2);
    await swapTo("c");
    const [a, b, c] = [gainOf(0), gainOf(1), gainOf(2)];
    // No jump where the second fade begins.
    expect(b.valueAt(1)).toBeCloseTo(reached, 2);
    expect(b.valueAt(3)).toBeCloseTo(0, 6);
    expect(a.valueAt(2)).toBeCloseTo(0, 6);
    expect(c.valueAt(3)).toBeCloseTo(1, 6);
    for (const t of timers()) {
      end(t);
    }
    expect(graphs.map((g) => g.disposed)).toEqual([1, 1, 0]);
  });

  it("lets the latest of overlapping async builds win", async () => {
    const { ctx, fader, swapTo, graphs } = setup();
    await swapTo("a");
    let finishSlow: () => void = () => undefined;
    const slow = fader.swap(
      (into) =>
        new Promise((resolve) => {
          finishSlow = () => {
            const graph = graphInto(ctx, into, "slow");
            graphs.push(graph);
            resolve(graph);
          };
        }),
    );
    await swapTo("fast");
    finishSlow();
    await slow;
    const slowGraph = graphs.find((g) => g.name === "slow");
    expect(slowGraph?.disposed).toBe(1);
    expect(graphs.find((g) => g.name === "fast")?.disposed).toBe(0);
  });

  it("keeps the current graph when a build throws, and releases the new input", async () => {
    const { ctx, fader, swapTo, graphs, gainOf } = setup();
    await swapTo("a");
    const before = ctx.nodes.length;
    await expect(
      fader.swap(() => {
        throw new Error("bad build");
      }),
    ).rejects.toThrow("bad build");
    expect(ctx.nodes.slice(before).every((n) => n.connections.length === 0)).toBe(true);
    expect(graphs[0]?.disposed).toBe(0);
    expect(gainOf(0).valueAt(10)).toBe(1);
  });

  it("disposes every graph, fading or not, when its scope is disposed", async () => {
    const { ctx, swapTo, graphs, disposeScope, out } = setup();
    await swapTo("a");
    await swapTo("b");
    disposeScope();
    expect(graphs.map((g) => g.disposed)).toEqual([1, 1]);
    const live = ctx.nodes.filter((n) => n !== out && n.connections.length > 0);
    expect(live).toEqual([]);
  });

  it("disposes a graph that finishes building after the crossfader was disposed", async () => {
    const { ctx, fader, graphs } = setup();
    let finish: () => void = () => undefined;
    const pending = fader.swap(
      (into) =>
        new Promise((resolve) => {
          finish = () => {
            const graph = graphInto(ctx, into, "late");
            graphs.push(graph);
            resolve(graph);
          };
        }),
    );
    fader.dispose();
    finish();
    await pending;
    expect(graphs[0]?.disposed).toBe(1);
    await fader.swap((into) => graphInto(ctx, into, "after"));
    expect(ctx.nodes.filter((n) => n.connections.length > 0)).toEqual([]);
  });
});
