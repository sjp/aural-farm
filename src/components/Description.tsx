import type { JSX } from "preact";
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";

/**
 * A sound's description, clamped to two lines, with More and Less when it runs
 * longer. It measures whether the clamp cuts anything off whenever its size
 * changes, such as when its section opens or the panel resizes.
 */
export function Description({ text }: { text: string }): JSX.Element {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) {
      return undefined;
    }
    const measure = () => {
      setCut(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [text, open]);

  return (
    <div className="description">
      <p id={id} ref={ref} className="description-text" data-open={open}>
        {text}
      </p>
      {(cut || open) && (
        <button
          type="button"
          className="text-button description-more"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
