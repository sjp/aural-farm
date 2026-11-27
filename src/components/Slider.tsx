import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import { touchIntent, valueAtX, type TouchIntent } from "./slider-gesture";

interface SliderProps {
  id?: string | undefined;
  /** The accessible name, when no `<label>` names the input. */
  label?: string | undefined;
  title?: string | undefined;
  valueText?: string | undefined;
  /** How far along the track the value is, 0–1, for the filled part of the track. */
  position: number;
  min: number;
  max: number;
  step: number | "any";
  value: number;
  /** Called with the input's new raw value. */
  onValue: (value: number) => void;
}

interface Touch {
  pointerId: number;
  x: number;
  y: number;
  intent: TouchIntent;
}

/**
 * A range input inside a wrapper that takes over pointer input where the input
 * itself doesn't receive it (the stylesheet turns its pointer events off under a
 * coarse pointer). The wrapper lets the page pan vertically, so a vertical swipe
 * over a slider scrolls the sheet it's in; a touch moves the value only once it
 * moves sideways, or on a tap. A mouse or pen drags at once. Keyboard input goes
 * to the input as usual.
 */
export function Slider({
  id,
  label,
  title,
  valueText,
  position,
  min,
  max,
  step,
  value,
  onValue,
}: SliderProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const touch = useRef<Touch | null>(null);

  const slideTo = (x: number) => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const next = valueAtX(x, input.getBoundingClientRect(), { min, max, step });
    if (next !== value) {
      onValue(next);
    }
  };

  const startSliding = (event: PointerEvent) => {
    wrapperRef.current?.setPointerCapture(event.pointerId);
    inputRef.current?.focus({ preventScroll: true });
    slideTo(event.clientX);
  };

  const onPointerDown = (event: PointerEvent) => {
    // Where the input takes pointer input itself, it handles it natively.
    if (event.target === inputRef.current || event.button !== 0) {
      return;
    }
    touch.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      intent: event.pointerType === "touch" ? "undecided" : "slide",
    };
    if (touch.current.intent === "slide") {
      startSliding(event);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = touch.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    if (current.intent === "undecided") {
      current.intent = touchIntent(event.clientX - current.x, event.clientY - current.y);
      if (current.intent === "slide") {
        startSliding(event);
      }
    } else if (current.intent === "slide") {
      slideTo(event.clientX);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const current = touch.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    // A tap moves the thumb to where it landed, as a tap on a native slider does.
    if (current.intent === "undecided") {
      inputRef.current?.focus({ preventScroll: true });
      slideTo(event.clientX);
    }
    touch.current = null;
  };

  const onPointerCancel = () => {
    touch.current = null;
  };

  return (
    <div
      ref={wrapperRef}
      className="slider"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <input
        ref={inputRef}
        id={id}
        type="range"
        aria-label={label}
        aria-valuetext={valueText}
        title={title}
        style={{ "--p": `${String(position * 100)}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(event) => {
          onValue(Number(event.currentTarget.value));
        }}
      />
    </div>
  );
}
