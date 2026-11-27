import type { ComponentChildren, JSX, RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { snapSheet } from "./sheet";

/** How far the sheet's top bar must move before a press becomes a drag, in px. */
const DRAG_SLOP_PX = 6;
/** A drag that rests this long before release counts as stopped, in ms. */
const REST_MS = 100;

interface Drag {
  pointerId: number;
  startY: number;
  /** How far down the sheet was when the press began, in px. */
  startOffset: number;
  /** How far down the collapsed sheet sits, in px. */
  travel: number;
  dragging: boolean;
  /** Where the sheet's top was last moved to, in px down from expanded. */
  offset: number;
  lastY: number;
  lastTime: number;
  /** px/ms, positive downwards, smoothed. */
  velocity: number;
}

interface BottomSheetProps {
  panelRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the sound picker fills the sheet. */
  picker: boolean;
  /** The bar that shows while the sheet is collapsed, and stays at its top when expanded. */
  bar: ComponentChildren;
  children: ComponentChildren;
}

/**
 * The control panel as a bottom sheet: a top bar (a drag handle above `bar`) that
 * shows while collapsed, and the rest, which scrolls inside the sheet when it's
 * expanded. Dragging the top bar moves the sheet with the finger and snaps it on
 * release, flicks going the way they moved. A tap on the bar outside its buttons,
 * or on the backdrop while expanded, toggles or collapses it.
 */
export function BottomSheet({
  panelRef,
  open,
  onOpenChange,
  picker,
  bar,
  children,
}: BottomSheetProps): JSX.Element {
  const topRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  // A tap on the backdrop collapses an expanded sheet.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".backdrop") !== null) {
        onOpenChange(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onOpenChange]);

  /** Puts the sheet back under the stylesheet's control. */
  const release = () => {
    const panel = panelRef.current;
    if (panel) {
      panel.style.removeProperty("transform");
      delete panel.dataset.dragging;
    }
    drag.current = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    const travel = contentRef.current?.offsetHeight ?? 0;
    const startOffset = open ? 0 : travel;
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startOffset,
      travel,
      dragging: false,
      offset: startOffset,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = drag.current;
    const panel = panelRef.current;
    if (current?.pointerId !== event.pointerId || !panel) {
      return;
    }
    const dy = event.clientY - current.startY;
    if (!current.dragging) {
      if (Math.abs(dy) < DRAG_SLOP_PX || current.travel <= 0) {
        return;
      }
      current.dragging = true;
      topRef.current?.setPointerCapture(event.pointerId);
      panel.dataset.dragging = "true";
    }
    const elapsed = event.timeStamp - current.lastTime;
    if (elapsed > 0) {
      const velocity = (event.clientY - current.lastY) / elapsed;
      current.velocity = 0.7 * velocity + 0.3 * current.velocity;
    }
    current.lastY = event.clientY;
    current.lastTime = event.timeStamp;
    current.offset = Math.min(current.travel, Math.max(0, current.startOffset + dy));
    panel.style.transform = `translateY(${String(current.offset)}px)`;
  };

  const onPointerUp = (event: PointerEvent) => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    release();
    if (current.dragging) {
      const resting = event.timeStamp - current.lastTime > REST_MS;
      const velocity = resting ? 0 : -current.velocity * 1000;
      const next = snapSheet(1 - current.offset / current.travel, velocity);
      if (next !== open) {
        onOpenChange(next);
      }
    } else if (!(event.target instanceof Element && event.target.closest("button") !== null)) {
      onOpenChange(!open);
    }
  };

  return (
    <div
      ref={panelRef}
      className="panel"
      data-layout="sheet"
      data-sheet={open ? "expanded" : "collapsed"}
      data-picker={picker}
    >
      <div
        ref={topRef}
        className="sheet-top"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={release}
      >
        <div className="sheet-handle" aria-hidden="true" />
        {bar}
      </div>
      <div ref={contentRef} className="sheet-content" inert={!open}>
        {children}
      </div>
    </div>
  );
}
