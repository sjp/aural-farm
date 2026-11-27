import { describe, expect, it, vi } from "vitest";
import {
  createRenderLoop,
  type Renderer,
  type RenderLoopEnv,
  type RenderLoopOptions,
} from "./renderLoop";

/**
 * A fake browser: a clock that only moves when told, display refreshes every
 * `refreshMs`, timers on the same clock, a resize observer and a document whose
 * visibility the test sets.
 */
function fakeBrowser(refreshMs = 1000 / 60) {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, (now: number) => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const resizeCallbacks: (() => void)[] = [];
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const env: RenderLoopEnv = {
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    now: () => now,
    devicePixelRatio: () => 2,
    ResizeObserver: class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {
        resizeCallbacks.length = 0;
      }
    },
    document: doc,
  };

  /** Runs the clock forward, firing timers when due and frames on each refresh. */
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      const nextRefresh = (Math.floor(now / refreshMs + 1e-9) + 1) * refreshMs;
      const due = [...timers].filter(([, t]) => t.at <= nextRefresh && t.at <= end);
      due.sort((a, b) => a[1].at - b[1].at);
      const first = due.at(0);
      if (first) {
        now = Math.max(now, first[1].at);
        timers.delete(first[0]);
        first[1].callback();
        continue;
      }
      now = Math.min(end, nextRefresh);
      if (now === nextRefresh) {
        const pending = [...frames];
        frames.clear();
        for (const [, callback] of pending) {
          callback(now);
        }
      }
    }
  };

  const setHidden = (hidden: boolean) => {
    doc.hidden = hidden;
    doc.dispatchEvent(new Event("visibilitychange"));
  };

  const resize = () => {
    for (const callback of resizeCallbacks) {
      callback();
    }
  };

  return {
    env,
    advance,
    setHidden,
    resize,
    pending: () => frames.size + timers.size,
    observing: () => resizeCallbacks.length > 0,
  };
}

function fakeCanvas(width = 800, height = 600) {
  return Object.assign(new EventTarget(), {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
  });
}

/** A renderer that records its calls: a stand-in for a WebGL program. */
function fakeRenderer() {
  const draws: { time: number; dt: number }[] = [];
  const renderer = {
    resize: vi.fn<Renderer["resize"]>(),
    draw: vi.fn<Renderer["draw"]>((time, dt) => {
      draws.push({ time, dt });
    }),
    dispose: vi.fn<Renderer["dispose"]>(),
  };
  return { renderer, draws };
}

function setup(interval: () => number | null = () => null, minInterval = 0) {
  const browser = fakeBrowser();
  const canvas = fakeCanvas();
  const made: ReturnType<typeof fakeRenderer>[] = [];
  const create = vi.fn<RenderLoopOptions["create"]>(() => {
    const fake = fakeRenderer();
    made.push(fake);
    return fake.renderer;
  });
  const onError = vi.fn<(error: unknown) => void>();
  const loop = createRenderLoop({
    canvas: canvas as unknown as HTMLCanvasElement,
    create,
    interval,
    onError,
    minInterval,
    maxPixelRatio: 1.5,
    env: browser.env,
  });
  const draws = () => made.flatMap((m) => m.draws);
  return { browser, canvas, loop, create, onError, made, draws };
}

describe("createRenderLoop", () => {
  it("sizes the canvas, capped at the maximum pixel ratio, and draws one frame", () => {
    const { browser, canvas, made, draws } = setup();
    expect([canvas.width, canvas.height]).toEqual([1200, 900]);
    expect(made[0]?.renderer.resize).toHaveBeenCalledWith(1200, 900);
    browser.advance(1000);
    expect(draws()).toEqual([{ time: 0, dt: 0 }]);
    expect(browser.pending()).toBe(0);
  });

  it("redraws on a resize and on invalidate, and not otherwise", () => {
    const { browser, canvas, loop, made, draws } = setup();
    browser.advance(100);
    canvas.clientWidth = 400;
    browser.resize();
    expect(made[0]?.renderer.resize).toHaveBeenLastCalledWith(600, 900);
    browser.advance(100);
    // A resize to the same size draws nothing.
    browser.resize();
    browser.advance(100);
    loop.invalidate();
    browser.advance(1000);
    expect(draws()).toHaveLength(3);
  });

  it("caps the frame rate at the interval it is given", () => {
    const { browser, draws } = setup(() => 1000 / 30);
    browser.advance(1000);
    // 30 frames a second on a 60 Hz display: every other refresh.
    expect(draws().length).toBeGreaterThanOrEqual(29);
    expect(draws().length).toBeLessThanOrEqual(31);
    for (const { dt } of draws().slice(1)) {
      expect(dt).toBeCloseTo(1 / 30, 3);
    }
  });

  it("drops to the idle rate, sleeping on a timer between frames", () => {
    let fast = true;
    const { browser, draws } = setup(() => (fast ? 1000 / 30 : 500));
    browser.advance(1000);
    const before = draws().length;
    fast = false;
    browser.advance(5000);
    expect(draws().length - before).toBeGreaterThanOrEqual(9);
    expect(draws().length - before).toBeLessThanOrEqual(11);
  });

  it("keeps frames apart by the minimum interval, however often they are asked for", () => {
    const { browser, loop, draws } = setup(() => null, 1000 / 30);
    for (let i = 0; i < 60; i++) {
      loop.invalidate();
      browser.advance(1000 / 60);
    }
    expect(draws().length).toBeLessThanOrEqual(31);
  });

  it("clamps dt to 0.1 s, and steps time by at most a second", () => {
    const { browser, draws } = setup(() => 3000);
    browser.advance(10_000);
    expect(draws().slice(0, 3)).toEqual([
      { time: 0, dt: 0 },
      { time: 1, dt: 0.1 },
      { time: 2, dt: 0.1 },
    ]);
  });

  it("stops while the document is hidden, and starts again from where it was", () => {
    const { browser, draws } = setup(() => 1000 / 30);
    browser.advance(500);
    browser.setHidden(true);
    expect(browser.pending()).toBe(0);
    const before = draws().length;
    const lastTime = draws().at(-1)?.time ?? 0;
    browser.advance(60_000);
    expect(draws()).toHaveLength(before);
    browser.setHidden(false);
    browser.advance(20);
    expect(draws().at(-1)).toEqual({ time: lastTime, dt: 0 });
    browser.advance(500);
    expect(draws().length).toBeGreaterThan(before + 10);
  });

  it("draws nothing when made in a hidden document, until it is shown", () => {
    const browser = fakeBrowser();
    browser.setHidden(true);
    const { renderer, draws } = fakeRenderer();
    createRenderLoop({
      canvas: fakeCanvas() as unknown as HTMLCanvasElement,
      create: () => renderer,
      interval: () => 100,
      onError: () => undefined,
      env: browser.env,
    });
    browser.advance(1000);
    expect(draws).toHaveLength(0);
    browser.setHidden(false);
    browser.advance(1000);
    expect(draws.length).toBeGreaterThan(5);
  });

  it("pauses on a lost context and makes a fresh renderer when it's restored", () => {
    const { browser, canvas, create, made, draws } = setup(() => 1000 / 30);
    browser.advance(100);
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(made[0]?.renderer.dispose).toHaveBeenCalledOnce();
    const before = draws().length;
    browser.advance(1000);
    expect(draws()).toHaveLength(before);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(create).toHaveBeenCalledTimes(2);
    expect(made[1]?.renderer.resize).toHaveBeenCalledWith(1200, 900);
    browser.advance(100);
    expect(made[1]?.draws.length).toBeGreaterThan(0);
  });

  it("reports a renderer that can't be made, once, and draws nothing", () => {
    const browser = fakeBrowser();
    const onError = vi.fn<(error: unknown) => void>();
    const error = new Error("no WebGL2");
    createRenderLoop({
      canvas: fakeCanvas() as unknown as HTMLCanvasElement,
      create: () => {
        throw error;
      },
      interval: () => 10,
      onError,
      env: browser.env,
    });
    browser.advance(1000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(browser.pending()).toBe(0);
  });

  it("disposes a renderer that throws while drawing, reports it once and stops", () => {
    const browser = fakeBrowser();
    const onError = vi.fn<(error: unknown) => void>();
    const { renderer } = fakeRenderer();
    renderer.draw.mockImplementation(() => {
      throw new Error("boom");
    });
    const loop = createRenderLoop({
      canvas: fakeCanvas() as unknown as HTMLCanvasElement,
      create: () => renderer,
      interval: () => 10,
      onError,
      env: browser.env,
    });
    browser.advance(1000);
    loop.invalidate();
    browser.advance(1000);
    expect(renderer.draw).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("survives a renderer whose dispose throws", () => {
    const { browser, canvas, made, onError } = setup();
    made[0]?.renderer.dispose.mockImplementation(() => {
      throw new Error("already gone");
    });
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    browser.advance(100);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops everything on dispose", () => {
    const { browser, canvas, loop, made, draws } = setup(() => 1000 / 30);
    browser.advance(100);
    loop.dispose();
    loop.dispose();
    expect(made[0]?.renderer.dispose).toHaveBeenCalledOnce();
    expect(browser.pending()).toBe(0);
    expect(browser.observing()).toBe(false);
    const before = draws().length;
    browser.setHidden(false);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    loop.invalidate();
    browser.advance(1000);
    expect(draws()).toHaveLength(before);
  });
});
