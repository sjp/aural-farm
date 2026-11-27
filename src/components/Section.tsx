import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import { ChevronIcon } from "./icons";

interface SectionProps {
  title: ComponentChildren;
  open: boolean;
  onToggle: () => void;
  /** How many settings inside differ from their defaults. */
  changed?: number;
  className?: string;
  /** Shown under the header whether or not the section is open. */
  note?: ComponentChildren;
  children: ComponentChildren;
}

/** A collapsible panel section: a header button that shows and hides its body. */
export function Section({
  title,
  open,
  onToggle,
  changed = 0,
  className = "",
  note,
  children,
}: SectionProps): JSX.Element {
  const id = useId();
  return (
    <section className={`panel-section ${className}`.trim()}>
      <button
        type="button"
        className="section-header"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
      >
        <ChevronIcon />
        <span id={`${id}-title`} className="section-title">
          {title}
        </span>
        {changed > 0 && <span className="section-changed">{changed} changed</span>}
      </button>
      {note}
      <div
        id={`${id}-body`}
        className="section-body"
        role="region"
        aria-labelledby={`${id}-title`}
        hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}
