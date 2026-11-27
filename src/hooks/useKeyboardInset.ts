import { useEffect } from "preact/hooks";

/** The custom property on the root element that holds the keyboard's height. */
export const KEYBOARD_INSET_PROPERTY = "--keyboard-inset";

/** The parts of `VisualViewport` the inset is worked out from. */
type Viewport = Pick<VisualViewport, "height" | "offsetTop" | "scale">;

/**
 * How much of the bottom of the layout viewport, `layoutHeight` tall, an
 * on-screen keyboard covers, in whole px: the gap below the visual viewport.
 * A pinch zoom also opens that gap, so a zoomed viewport counts as no keyboard.
 */
export function keyboardInset(layoutHeight: number, viewport: Viewport): number {
  if (viewport.scale > 1.01) {
    return 0;
  }
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop));
}

/**
 * Keeps `--keyboard-inset` on the root element at the on-screen keyboard's
 * height, so the bottom sheet can sit above it. Browsers that resize the layout
 * viewport for the keyboard, or have no `visualViewport`, leave it at 0.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return undefined;
    }
    const root = document.documentElement;
    const update = () => {
      const inset = keyboardInset(window.innerHeight, viewport);
      root.style.setProperty(KEYBOARD_INSET_PROPERTY, `${String(inset)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
    };
  }, []);
}
