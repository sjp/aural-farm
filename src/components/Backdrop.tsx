import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { createBackdrop, type Backdrop as BackdropProgram } from "../backdrop/backdrop";
import { poolColours, type TintWeight } from "../backdrop/colours";
import { createScene, cssBackdrop, FPS_CAP, frameInterval, type Look } from "../backdrop/scene";
import type { BackdropMode } from "../backdrop/settings";
import { useDocumentVisible } from "../hooks/useDocumentVisible";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { createRenderLoop, type RenderLoopEnv } from "../lib/renderLoop";

/**
 * The canvas is sized in CSS pixels, never device pixels: the picture is soft
 * all over, so extra pixels would cost power and show nothing.
 */
const MAX_PIXEL_RATIO = 1;

/** Reads the master level for the response to sound. */
export interface MasterMeter {
  /** Starts measuring and returns a function that stops. */
  watch: () => () => void;
  /** The master output's RMS level, 0–1. */
  get: () => number;
}

interface BackdropProps {
  mode: BackdropMode;
  /** 0–100. */
  brightness: number;
  /** Whether the glow breathes with the sound. */
  respond: boolean;
  /** Each layer's tint and effective gain, in mix order. */
  tints: readonly TintWeight[];
  /** Whether the mix is sounding: otherwise the glow fades to neutral. */
  playing: boolean;
  level?: MasterMeter | undefined;
  /** Makes the WebGL program; tests pass a stand-in. */
  createProgram?: (canvas: HTMLCanvasElement) => BackdropProgram;
  /** The render loop's browser pieces; tests pass fakes. */
  loopEnv?: RenderLoopEnv;
}

let logged = false;

/** Logs why the backdrop fell back to CSS, once per page. */
function logFallback(error: unknown): void {
  if (!logged) {
    logged = true;
    console.warn("The backdrop is showing a static picture instead:", error);
  }
}

/**
 * The page's backdrop: a slow, soft glow tinted by the mix, behind everything.
 * Off shows a plain background; without WebGL2 a static CSS gradient of the same
 * tints stands in. Nothing here touches the audio except the master meter, and
 * only while the response is on, the mix is playing and the page is visible.
 */
export function Backdrop({
  mode,
  brightness,
  respond,
  tints,
  playing,
  level,
  createProgram = createBackdrop,
  loopEnv,
}: BackdropProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const [scene] = useState(createScene);
  const loopRef = useRef<{ invalidate: () => void } | null>(null);
  /** Reads the level while the response is running. */
  const readLevel = useRef<(() => number) | undefined>(undefined);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const reducedRef = useRef(reducedMotion);
  useLayoutEffect(() => {
    reducedRef.current = reducedMotion;
  });
  const visible = useDocumentVisible();

  const on = mode !== "off";
  const drawing = on && !failed;
  const look = useMemo<Look | undefined>(
    () => (mode === "off" ? undefined : { mode, brightness }),
    [mode, brightness],
  );
  const pools = useMemo(() => poolColours(playing ? tints : []), [playing, tints]);

  // The target colours; the scene eases to them (or jumps, with reduced motion).
  useEffect(() => {
    if (look && scene.setTarget(pools, look, reducedMotion)) {
      loopRef.current?.invalidate();
    }
  }, [scene, pools, look, reducedMotion]);

  const responding =
    drawing && respond && playing && !reducedMotion && visible && level !== undefined;
  useEffect(() => {
    if (!responding) {
      return undefined;
    }
    const stop = level.watch();
    readLevel.current = level.get;
    loopRef.current?.invalidate();
    return () => {
      readLevel.current = undefined;
      stop();
    };
  }, [responding, level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!drawing || !canvas) {
      return undefined;
    }
    const loop = createRenderLoop({
      canvas,
      create: (target) => {
        const program = createProgram(target);
        return {
          resize: program.resize,
          draw: (time, dt) => {
            // With reduced motion, the pools stay where they start.
            program.render(scene.frame(reducedRef.current ? 0 : time, dt, readLevel.current?.()));
          },
          dispose: program.dispose,
        };
      },
      interval: () =>
        frameInterval({
          shown: true,
          reducedMotion: reducedRef.current,
          responding: readLevel.current !== undefined || scene.responding,
          easing: scene.easing,
        }),
      onError: (error) => {
        logFallback(error);
        setFailed(true);
      },
      minInterval: 1000 / FPS_CAP,
      maxPixelRatio: MAX_PIXEL_RATIO,
      ...(loopEnv && { env: loopEnv }),
    });
    loopRef.current = loop;
    return () => {
      loopRef.current = null;
      loop.dispose();
    };
  }, [drawing, scene, createProgram, loopEnv]);

  if (!look) {
    return <div className="backdrop" data-backdrop="off" aria-hidden="true" />;
  }
  if (failed) {
    return (
      <div
        className="backdrop"
        data-backdrop="static"
        style={{ "--backdrop": cssBackdrop(pools, look) }}
        aria-hidden="true"
      />
    );
  }
  return <canvas ref={canvasRef} className="backdrop" data-backdrop={mode} aria-hidden="true" />;
}
