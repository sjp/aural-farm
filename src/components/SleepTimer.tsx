import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  CUSTOM_MINUTES,
  FADE_IN_CHOICES,
  FADE_OUT_CHOICES,
  formatCountdown,
  timerLabel,
  TIMER_MINUTES,
  validMinutes,
  type SleepSettings,
} from "../lib/sleep-timer";
import { ClockIcon } from "./icons";

const isPreset = (minutes: number) => (TIMER_MINUTES as readonly number[]).includes(minutes);

/** The sleep timer's state and what changes it, as the app hands them to the panel. */
export interface SleepTimerControls {
  /** The running timer's length in minutes, or undefined while it is Off. */
  minutes: number | undefined;
  /** The time left on the running timer, in seconds. */
  remaining: number | undefined;
  settings: SleepSettings;
  /** Starts a timer of this many minutes, or turns it Off. */
  onChoose: (minutes: number | undefined) => void;
  onSettingsChange: (settings: SleepSettings) => void;
}

interface SleepTimerProps extends SleepTimerControls {
  /** Whether to add the shortcut to the tooltip. */
  hover: boolean;
  /** Whether the button shows the time left; the bottom sheet shows it beside the summary. */
  showTime: boolean;
  /** Called as the menu opens, so the bottom sheet can expand to make room for it. */
  onOpen?: (() => void) | undefined;
}

/** A row of choices, one of them pressed. */
function Choices({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly { seconds: number; label: string }[];
  value: number;
  onChange: (seconds: number) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="sleep-group" role="group" aria-labelledby={id}>
      <p id={id} className="sleep-legend">
        {label}
      </p>
      <div className="segmented">
        {choices.map((choice) => (
          <button
            key={choice.seconds}
            type="button"
            aria-pressed={choice.seconds === value}
            onClick={() => {
              onChange(choice.seconds);
            }}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The sleep timer: a clock button that shows the time left while a timer runs,
 * and opens a menu of timer lengths, the fade-out length and the Play fade-in.
 */
export function SleepTimer(props: SleepTimerProps): JSX.Element {
  const { minutes, remaining, settings, onChoose, onSettingsChange } = props;
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  /** The choice to focus once the menu has opened. */
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState("");
  const [customInvalid, setCustomInvalid] = useState(false);

  const close = (refocus: boolean) => {
    setOpen(false);
    setCustomOpen(false);
    if (refocus) {
      buttonRef.current?.focus();
    }
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setCustomOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target) !== true) {
        setOpen(false);
        setCustomOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (open && focusKey !== undefined) {
      ref.current?.querySelector<HTMLElement>(`[data-timer="${focusKey}"]`)?.focus();
      setFocusKey(undefined);
    }
  }, [open, focusKey]);

  useEffect(() => {
    if (customOpen) {
      inputRef.current?.focus();
    }
  }, [customOpen]);

  const choose = (next: number | undefined) => {
    onChoose(next);
    close(true);
  };

  const openCustom = () => {
    const offered = minutes ?? settings.lastMinutes;
    setCustomText(offered !== undefined && !isPreset(offered) ? String(offered) : "");
    setCustomInvalid(false);
    setCustomOpen(true);
  };

  const time = remaining === undefined ? undefined : formatCountdown(remaining);
  const label = time === undefined ? "Sleep timer" : `Sleep timer, ${time} left`;
  const running = minutes !== undefined;

  return (
    <div ref={ref} className="sleep-timer">
      <button
        ref={buttonRef}
        type="button"
        className="icon-button sleep-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        data-running={running}
        data-time={props.showTime && time !== undefined}
        title={props.hover ? "Sleep timer (T)" : "Sleep timer"}
        onClick={() => {
          if (open) {
            close(false);
            return;
          }
          // The menu offers the running timer's length, or else the one chosen last.
          const offered = minutes ?? settings.lastMinutes;
          setFocusKey(
            offered === undefined ? "off" : isPreset(offered) ? String(offered) : "custom",
          );
          props.onOpen?.();
          setOpen(true);
        }}
      >
        <ClockIcon />
        {props.showTime && time !== undefined && (
          <span className="sleep-countdown" aria-hidden="true">
            {time}
          </span>
        )}
      </button>
      <div id={id} className="sleep-popover" role="dialog" aria-label="Sleep timer" hidden={!open}>
        <div className="sleep-group" role="group" aria-labelledby={`${id}-timer`}>
          <p id={`${id}-timer`} className="sleep-legend">
            Sleep timer
          </p>
          <div className="sleep-lengths">
            <button
              type="button"
              className="chip"
              data-timer="off"
              aria-pressed={!running}
              onClick={() => {
                choose(undefined);
              }}
            >
              Off
            </button>
            {TIMER_MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                className="chip"
                data-timer={m}
                aria-pressed={minutes === m}
                onClick={() => {
                  choose(m);
                }}
              >
                {timerLabel(m)}
              </button>
            ))}
            <button
              type="button"
              className="chip"
              data-timer="custom"
              aria-pressed={running && !isPreset(minutes)}
              aria-expanded={customOpen}
              onClick={openCustom}
            >
              {running && !isPreset(minutes) ? `Custom: ${timerLabel(minutes)}` : "Custom"}
            </button>
          </div>
          {customOpen && (
            <form
              className="sleep-custom"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const chosen = validMinutes(customText);
                if (chosen === undefined) {
                  setCustomInvalid(true);
                } else {
                  choose(chosen);
                }
              }}
            >
              <label htmlFor={`${id}-minutes`}>Minutes</label>
              <input
                id={`${id}-minutes`}
                type="number"
                inputMode="numeric"
                min={CUSTOM_MINUTES.min}
                max={CUSTOM_MINUTES.max}
                step={1}
                required
                value={customText}
                aria-invalid={customInvalid}
                aria-describedby={`${id}-range`}
                ref={inputRef}
                onInput={(event) => {
                  setCustomText(event.currentTarget.value);
                  setCustomInvalid(false);
                }}
              />
              <button type="submit" className="primary">
                Start
              </button>
              <span id={`${id}-range`} className="sleep-range">
                {CUSTOM_MINUTES.min}–{CUSTOM_MINUTES.max}
              </span>
            </form>
          )}
        </div>
        <Choices
          label="Fade out over"
          choices={FADE_OUT_CHOICES}
          value={settings.fadeOut}
          onChange={(fadeOut) => {
            onSettingsChange({ ...settings, fadeOut });
          }}
        />
        <Choices
          label="Fade in on Play"
          choices={FADE_IN_CHOICES}
          value={settings.fadeIn}
          onChange={(fadeIn) => {
            onSettingsChange({ ...settings, fadeIn });
          }}
        />
      </div>
    </div>
  );
}
