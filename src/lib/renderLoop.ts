/**
 * A frame loop for a canvas that rarely needs a frame: it draws only when asked
 * to, or when the renderer's `interval` says the next frame is due, and sleeps
 * in between on a timer rather than waking for every display refresh.
 *
 * - Frames come no closer than `minInterval`, however often they are asked for.
 * - Nothing runs while the document is hidden; a resize or `invalidate()` draws once.
 * - `dt` is clamped to [0, 0.1] s. `time` counts only the time the loop has been
 *   running, so a hidden stretch doesn't jump the picture on return.
 * - A lost WebGL context pauses drawing; a restored one gets a fresh renderer.
 * - A renderer that throws, when made or while drawing, is disposed and reported
 *   once through `onError`; the loop then stops for good.
 *
 * The browser pieces (frames, timers, the clock, the pixel ratio, the resize
 * observer and the document) are injected, so tests drive it with fakes.
 */

/** What the loop drives. */
export interface Renderer {
  /** The canvas's drawing buffer is now `width` × `height` device pixels. */
  resize: (width: number, height: number) => void;
  /** Draws a frame at `time` seconds, `dt` after the last. */
  draw: (time: number, dt: number) => void;
  dispose: () => void;
}

export interface RenderLoopEnv {
  requestFrame: (callback: (now: number) => void) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  /** Milliseconds, as `performance.now()`. */
  now: () => number;
  devicePixelRatio: () => number;
  ResizeObserver: new (callback: () => void) => Pick<ResizeObserver, "observe" | "disconnect">;
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
}

export interface RenderLoopOptions {
  canvas: HTMLCanvasElement;
  /** Makes the renderer for the canvas; called again after a context restore. */
  create: (canvas: HTMLCanvasElement) => Renderer;
  /** Milliseconds until the next frame after one is drawn, or null to wait for `invalidate`. */
  interval: () => number | null;
  /** Called once if the renderer can't be made or throws. */
  onError: (error: unknown) => void;
  /** Frames are at least this many milliseconds apart, even when asked for sooner. */
  minInterval?: number;
  /** The canvas never uses more device pixels per CSS pixel than this. */
  maxPixelRatio?: number;
  env?: RenderLoopEnv;
}

interface RenderLoop {
  /** Draws a frame soon, whatever `interval` says. */
  invalidate: () => void;
  dispose: () => void;
}

const MAX_DT = 0.1;
/** The longest step `time` takes, so a stall (a busy tab, a debugger) doesn't jump the picture. */
const MAX_STEP = 1;
/**
 * The timer wakes this much before a frame is due, then waits for the display's
 * next refresh, which then lands on time rather than a refresh late.
 */
const WAKE_EARLY_MS = 4;

function browserEnv(): RenderLoopEnv {
  return {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => {
      window.cancelAnimationFrame(handle);
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    now: () => performance.now(),
    devicePixelRatio: () => window.devicePixelRatio,
    ResizeObserver: window.ResizeObserver,
    document,
  };
}

export function createRenderLoop(options: RenderLoopOptions): RenderLoop {
  const { canvas } = options;
  const env = options.env ?? browserEnv();
  const maxPixelRatio = options.maxPixelRatio ?? Infinity;
  const minInterval = options.minInterval ?? 0;

  let renderer: Renderer | undefined;
  let failed = false;
  let disposed = false;
  let lost = false;
  /** A frame is wanted whatever `interval` says (a resize, a change). */
  let dirty = true;
  let size: [number, number] | undefined;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the last frame was drawn, by `env.now()`; undefined after a pause. */
  let lastFrame: number | undefined;
  let time = 0;

  const fail = (error: unknown) => {
    if (failed) {
      return;
    }
    failed = true;
    cancel();
    disposeRenderer();
    options.onError(error);
  };

  const disposeRenderer = () => {
    const current = renderer;
    renderer = undefined;
    try {
      current?.dispose();
    } catch {
      // Already failing or going: nothing more to do with it.
    }
  };

  const cancel = () => {
    if (frame !== undefined) {
      env.cancelFrame(frame);
      frame = undefined;
    }
    if (timer !== undefined) {
      env.clearTimer(timer);
      timer = undefined;
    }
  };

  const running = () => !disposed && !failed && !lost && !env.document.hidden;

  const makeRenderer = () => {
    try {
      renderer = options.create(canvas);
      if (size) {
        renderer.resize(...size);
      }
    } catch (error) {
      fail(error);
    }
  };

  const draw = (now: number) => {
    frame = undefined;
    if (!running() || !renderer) {
      return;
    }
    const elapsed = lastFrame === undefined ? 0 : Math.max(0, (now - lastFrame) / 1000);
    lastFrame = now;
    time += Math.min(elapsed, MAX_STEP);
    dirty = false;
    try {
      renderer.draw(time, Math.min(elapsed, MAX_DT));
    } catch (error) {
      fail(error);
      return;
    }
    schedule();
  };

  const requestFrame = () => {
    frame ??= env.requestFrame(draw);
  };

  /** Plans the next frame: soon if one is wanted, after `interval` otherwise, or not at all. */
  function schedule() {
    if (!running() || !renderer || frame !== undefined || timer !== undefined) {
      return;
    }
    const interval = dirty ? minInterval : options.interval();
    if (interval === null) {
      return;
    }
    const wait = lastFrame === undefined ? 0 : lastFrame + interval - env.now() - WAKE_EARLY_MS;
    if (wait <= 0) {
      requestFrame();
      return;
    }
    timer = env.setTimer(() => {
      timer = undefined;
      if (running()) {
        requestFrame();
      }
    }, wait);
  }

  const resize = () => {
    const ratio = Math.min(env.devicePixelRatio(), maxPixelRatio);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (size?.[0] === width && size[1] === height) {
      return;
    }
    size = [width, height];
    canvas.width = width;
    canvas.height = height;
    try {
      renderer?.resize(width, height);
    } catch (error) {
      fail(error);
      return;
    }
    invalidate();
  };

  const onVisibility = () => {
    if (env.document.hidden) {
      cancel();
    } else {
      lastFrame = undefined;
      invalidate();
    }
  };

  const onLost = (event: Event) => {
    // Without preventDefault the browser never restores the context.
    event.preventDefault();
    lost = true;
    cancel();
    disposeRenderer();
  };

  const onRestored = () => {
    if (disposed || failed) {
      return;
    }
    lost = false;
    lastFrame = undefined;
    makeRenderer();
    invalidate();
  };

  function invalidate() {
    dirty = true;
    if (timer !== undefined) {
      env.clearTimer(timer);
      timer = undefined;
    }
    schedule();
  }

  const observer = new env.ResizeObserver(resize);
  observer.observe(canvas);
  env.document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  resize();
  makeRenderer();
  schedule();

  return {
    invalidate,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      cancel();
      observer.disconnect();
      env.document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      disposeRenderer();
    },
  };
}
