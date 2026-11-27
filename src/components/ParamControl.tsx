import type { ComponentChildren, JSX } from "preact";
import { formatValue, isDefault, sliderPosition, snap, valueAtPosition } from "../sounds/params";
import type { NumberParam, ParamDef, ParamValue, SelectOption } from "../sounds/types";
import { ResetIcon } from "./icons";

/** Slider resolution for log-scaled params, which slide over positions, not values. */
const LOG_STEPS = 1000;
/** Option labels up to this long fit side by side as segmented buttons. */
const SEGMENT_LABEL_MAX = 10;

interface ParamControlProps {
  /** Unique within the page; the input's id is derived from it. */
  id: string;
  def: ParamDef;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
  /** When given, a reset button shows while the value isn't the default. */
  onReset?: () => void;
}

function ResetButton({
  inputId,
  label,
  onReset,
}: {
  inputId: string;
  label: string;
  onReset: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="param-reset"
      aria-label={`Reset ${label}`}
      title={`Reset ${label}`}
      onClick={(event) => {
        onReset();
        // Keyboard activation would otherwise leave focus on a button that vanishes.
        if (event.detail === 0) {
          document.getElementById(inputId)?.focus();
        }
      }}
    >
      <ResetIcon />
    </button>
  );
}

function fitsSegments(options: readonly SelectOption[]): boolean {
  return (
    options.length >= 2 &&
    options.length <= 3 &&
    options.every((o) => o.label.length <= SEGMENT_LABEL_MAX)
  );
}

/**
 * The value a slider move lands on. A log slider's positions are finer than the
 * value grid in places, so a small move can snap back to the current value; then
 * it steps one grid step in the direction of the move instead, so arrow keys
 * always make progress.
 */
function nextNumber(def: NumberParam, current: number, raw: number): number {
  if (def.scale !== "log") {
    return snap(def, raw);
  }
  const position = raw / LOG_STEPS;
  const next = valueAtPosition(def, position);
  const currentPosition = sliderPosition(def, current);
  if (next === current && position !== currentPosition) {
    return snap(def, current + Math.sign(position - currentPosition) * def.step);
  }
  return next;
}

/** One control for one param: a slider, a list or segmented buttons, or a switch. */
export function ParamControl({
  id,
  def,
  value,
  onChange,
  onReset,
}: ParamControlProps): JSX.Element {
  const inputId = `param-${id}`;
  const reset =
    onReset && !isDefault(def, value) ? (
      <ResetButton inputId={inputId} label={def.label} onReset={onReset} />
    ) : null;
  const label = (after?: ComponentChildren) => (
    <div className="control-label">
      <label htmlFor={inputId}>{def.label}</label>
      {reset}
      {after}
    </div>
  );

  switch (def.kind) {
    case "number": {
      const n = Number(value);
      const position = sliderPosition(def, n);
      const log = def.scale === "log";
      const style = { "--p": `${String(position * 100)}%` };
      return (
        <div className="control">
          {label(<span className="control-value">{formatValue(def, n)}</span>)}
          <input
            id={inputId}
            type="range"
            style={style}
            min={log ? 0 : def.min}
            max={log ? LOG_STEPS : def.max}
            step={log ? "any" : def.step}
            value={log ? position * LOG_STEPS : n}
            aria-valuetext={formatValue(def, n)}
            onInput={(event) => {
              const next = nextNumber(def, n, Number(event.currentTarget.value));
              if (next !== n) {
                onChange(next);
              }
            }}
          />
        </div>
      );
    }
    case "select": {
      const selected = String(value);
      if (fitsSegments(def.options)) {
        return (
          <div className="control">
            <div className="control-label">
              <span id={`${inputId}-label`}>{def.label}</span>
              {reset}
            </div>
            <div
              id={inputId}
              className="segmented"
              role="group"
              aria-labelledby={`${inputId}-label`}
              tabIndex={-1}
            >
              {def.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={option.value === selected}
                  onClick={() => {
                    onChange(option.value);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        );
      }
      return (
        <div className="control control-inline">
          {label()}
          <select
            id={inputId}
            value={selected}
            onChange={(event) => {
              onChange(event.currentTarget.value);
            }}
          >
            {def.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "boolean":
      return (
        <div className="control control-inline">
          {label()}
          <input
            id={inputId}
            type="checkbox"
            role="switch"
            className="switch"
            checked={value === true}
            onChange={(event) => {
              onChange(event.currentTarget.checked);
            }}
          />
        </div>
      );
    default:
      return def satisfies never;
  }
}
