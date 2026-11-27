/**
 * The Display settings: how the backdrop looks on this device. They live in the
 * preferences, not the URL hash, since they describe the device rather than the mix.
 */
import type { Preferences } from "../lib/preferences";
import { coerce, serialiseParams } from "../sounds/params";
import type { ParamSchema, ParamValues } from "../sounds/types";

/** The Display section's controls, drawn by the same code as a sound's params. */
export const DISPLAY_PARAMS = {
  backdrop: {
    kind: "select",
    label: "Backdrop",
    options: [
      { value: "glow", label: "Glow" },
      { value: "night", label: "Night" },
      { value: "off", label: "Off" },
    ],
    default: "glow",
  },
  brightness: { kind: "number", label: "Brightness", min: 0, max: 100, step: 1, default: 50 },
  respond: { kind: "boolean", label: "Respond to sound", default: true },
} as const satisfies ParamSchema;

export type DisplaySettings = ParamValues<typeof DISPLAY_PARAMS>;

export type BackdropMode = DisplaySettings["backdrop"];

const PREFIX = "display.";

/** The stored settings; anything missing or unreadable takes its default. */
export function loadDisplay(preferences: Preferences): DisplaySettings {
  const read = (key: keyof DisplaySettings) => preferences.get(PREFIX + key) ?? undefined;
  const { backdrop, brightness, respond } = DISPLAY_PARAMS;
  const mode = read("backdrop");
  return {
    backdrop: backdrop.options.find((o) => o.value === mode)?.value ?? backdrop.default,
    brightness: Number(coerce(brightness, read("brightness"))),
    respond: coerce(respond, read("respond")) === true,
  };
}

export function saveDisplay(preferences: Preferences, settings: DisplaySettings): void {
  for (const [key, value] of serialiseParams(DISPLAY_PARAMS, settings, true)) {
    preferences.set(PREFIX + key, value);
  }
}

/** The mode after `mode` in Glow → Night → Off → Glow, for the `D` shortcut. */
export function nextBackdrop(mode: BackdropMode): BackdropMode {
  const { options } = DISPLAY_PARAMS.backdrop;
  const index = options.findIndex((o) => o.value === mode);
  return options[(index + 1) % options.length]?.value ?? DISPLAY_PARAMS.backdrop.default;
}

/** A mode's name as the panel shows it. */
export function backdropLabel(mode: BackdropMode): string {
  return DISPLAY_PARAMS.backdrop.options.find((o) => o.value === mode)?.label ?? mode;
}
