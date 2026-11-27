/**
 * The sleep timer's choices, how its countdown reads, and the settings kept
 * between visits. The timer itself runs in the audio engine; it is never in the
 * URL hash, so a shared link can't start one, and it starts Off on every visit.
 */
import type { Preferences } from "./preferences";

/** The timer lengths the menu offers, in minutes. */
export const TIMER_MINUTES = [15, 30, 45, 60, 90, 120] as const;
/** The range of a custom length, in minutes. */
export const CUSTOM_MINUTES = { min: 1, max: 480 } as const;
/** The `T` shortcut cycles Off → 15 → 30 → 60 → 90 min → Off. */
const CYCLE_MINUTES = [15, 30, 60, 90] as const;

interface Choice {
  seconds: number;
  label: string;
}

/** How long the sound fades out before the timer ends. */
export const FADE_OUT_CHOICES: readonly Choice[] = [
  { seconds: 10, label: "10 s" },
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 900, label: "15 min" },
];
const DEFAULT_FADE_OUT = 300;

/** How long Play fades the sound in. */
export const FADE_IN_CHOICES: readonly Choice[] = [
  { seconds: 0.1, label: "Instant" },
  { seconds: 3, label: "3 s" },
  { seconds: 10, label: "10 s" },
  { seconds: 30, label: "30 s" },
];
const DEFAULT_FADE_IN = 3;

/** In the last minute the countdown shows every second; before that, whole minutes. */
const SECONDS_SHOWN_BELOW = 60;
/** A countdown update waits this much past the moment its text changes, so it lands after it. */
const UPDATE_SLACK_MS = 20;

/** A timer length as the menu and toasts name it: "15 min", "1 h", "1 h 30". */
export function timerLabel(minutes: number): string {
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  const hours = String(Math.floor(minutes / 60));
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

/** The length after `minutes` in the `T` shortcut's cycle, or undefined for Off. */
export function nextCycleMinutes(minutes: number | undefined): number | undefined {
  if (minutes === undefined) {
    return CYCLE_MINUTES[0];
  }
  return CYCLE_MINUTES.find((m) => m > minutes);
}

/**
 * The time shown for `seconds` left: whole minutes, rounded up, until the last
 * minute, then every second. So it never shows less time than is left.
 */
function shownSeconds(seconds: number): number {
  return seconds > SECONDS_SHOWN_BELOW ? Math.ceil(seconds / 60) * 60 : Math.ceil(seconds);
}

/** The countdown text: "42:00", "0:59", or "1:02:00" past an hour. */
export function formatCountdown(seconds: number): string {
  const shown = Math.max(0, shownSeconds(seconds));
  const h = Math.floor(shown / 3600);
  const m = String(Math.floor((shown % 3600) / 60));
  const s = String(shown % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${m.padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Milliseconds until the countdown text for `seconds` left next changes. */
export function countdownDelay(seconds: number): number {
  const step = seconds > SECONDS_SHOWN_BELOW ? 60 : 1;
  const next = shownSeconds(seconds) - step;
  return Math.max(0, seconds - next) * 1000 + UPDATE_SLACK_MS;
}

/** The sleep timer's settings kept between visits. */
export interface SleepSettings {
  /** The length last chosen, which the menu offers first; undefined before any. */
  lastMinutes: number | undefined;
  /** The fade-out length, in seconds. */
  fadeOut: number;
  /** How long Play fades in, in seconds. */
  fadeIn: number;
}

const LAST_KEY = "sleep.lastMinutes";
const FADE_OUT_KEY = "sleep.fadeOut";
const FADE_IN_KEY = "fadeIn";

/** A whole number of minutes a custom length can be, or undefined. */
export function validMinutes(value: unknown): number | undefined {
  const minutes = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof minutes === "number" &&
    Number.isInteger(minutes) &&
    minutes >= CUSTOM_MINUTES.min &&
    minutes <= CUSTOM_MINUTES.max
    ? minutes
    : undefined;
}

const choiceOf = (choices: readonly Choice[], raw: string | null, fallback: number) =>
  choices.find((c) => String(c.seconds) === raw)?.seconds ?? fallback;

/** The stored settings; anything missing or unreadable takes its default. */
export function loadSleepSettings(preferences: Preferences): SleepSettings {
  return {
    lastMinutes: validMinutes(preferences.get(LAST_KEY)),
    fadeOut: choiceOf(FADE_OUT_CHOICES, preferences.get(FADE_OUT_KEY), DEFAULT_FADE_OUT),
    fadeIn: choiceOf(FADE_IN_CHOICES, preferences.get(FADE_IN_KEY), DEFAULT_FADE_IN),
  };
}

export function saveSleepSettings(preferences: Preferences, settings: SleepSettings): void {
  if (settings.lastMinutes !== undefined) {
    preferences.set(LAST_KEY, String(settings.lastMinutes));
  }
  preferences.set(FADE_OUT_KEY, String(settings.fadeOut));
  preferences.set(FADE_IN_KEY, String(settings.fadeIn));
}
