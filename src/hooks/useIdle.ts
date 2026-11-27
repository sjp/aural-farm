import { useEffect, useState } from "preact/hooks";

const ACTIVITY = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * True once `ms` pass without input. Pointer, key, wheel and touch input count as
 * activity, and so does scrolling anywhere in the page (scroll events don't
 * bubble, so they're caught in the capture phase).
 */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => {
      setIdle(true);
    }, ms);
    const onActivity = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        setIdle(true);
      }, ms);
    };
    for (const type of ACTIVITY) {
      window.addEventListener(type, onActivity, { passive: true });
    }
    window.addEventListener("scroll", onActivity, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const type of ACTIVITY) {
        window.removeEventListener(type, onActivity);
      }
      window.removeEventListener("scroll", onActivity, { capture: true });
    };
  }, [ms]);
  return idle;
}

/** Whether the most recent pointer input came from touch. */
export function useTouchPointer(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      setTouch(event.pointerType === "touch");
    };
    const options = { capture: true, passive: true };
    window.addEventListener("pointerdown", onPointer, options);
    window.addEventListener("pointermove", onPointer, options);
    return () => {
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      window.removeEventListener("pointermove", onPointer, { capture: true });
    };
  }, []);
  return touch;
}
