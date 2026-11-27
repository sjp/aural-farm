/**
 * Param values: defaults, coercion of untrusted input (the URL hash), the log
 * slider mapping, display formatting and per-layer (de)serialisation.
 */
import type { NumberParam, ParamDef, ParamSchema, ParamValue, ParamValues } from "./types";

/** Every param at its default. */
export function defaults(schema: ParamSchema): ParamValues {
  const values: ParamValues = {};
  for (const [key, def] of Object.entries(schema)) {
    values[key] = def.default;
  }
  return values;
}

/** How many decimals a step needs: 0.05 → 2, 1 → 0, 1e-7 → 7. */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) {
    return 0;
  }
  const [mantissa = "", exponent = "0"] = String(step).split("e");
  const decimals = mantissa.split(".")[1]?.length ?? 0;
  return Math.min(20, Math.max(0, decimals - Number(exponent)));
}

/**
 * Clamps to `[min, max]` and snaps to the grid `min + k·step`, staying on the grid
 * even when `max` is off it, rounded to 12 decimals to drop float noise.
 */
export function snap(def: NumberParam, value: number): number {
  const clamped = Math.min(def.max, Math.max(def.min, value));
  if (!(def.step > 0)) {
    return clamped;
  }
  let k = Math.round((clamped - def.min) / def.step);
  if (def.min + k * def.step > def.max) {
    k--;
  }
  return Number((def.min + k * def.step).toFixed(12));
}

function coerceNumber(def: NumberParam, raw: unknown): number {
  let n = Number.NaN;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    n = Number(raw);
  }
  return Number.isFinite(n) ? snap(def, n) : def.default;
}

/**
 * Turns any input (a hash string or a typed value) into a valid value for `def`:
 * numbers are clamped and snapped, unknown select values and anything unreadable
 * fall back to the default, and booleans accept `1`/`0` as well as true/false.
 */
export function coerce(def: ParamDef, raw: unknown): ParamValue {
  switch (def.kind) {
    case "number":
      return coerceNumber(def, raw);
    case "select":
      return typeof raw === "string" && def.options.some((o) => o.value === raw)
        ? raw
        : def.default;
    case "boolean":
      if (raw === true || raw === "1") {
        return true;
      }
      if (raw === false || raw === "0") {
        return false;
      }
      return def.default;
    default:
      return def satisfies never;
  }
}

function isDefault(def: ParamDef, value: ParamValue): boolean {
  return value === def.default;
}

/** A number param's value as shown in the panel: "220 Hz", "0.50". */
export function formatValue(def: NumberParam, value: number): string {
  const text = value.toFixed(stepDecimals(def.step));
  return def.unit === undefined ? text : `${text} ${def.unit}`;
}

/** Where `value` sits along the slider, from 0 to 1, honouring `scale`. */
export function sliderPosition(def: NumberParam, value: number): number {
  if (!(def.max > def.min)) {
    return 0;
  }
  const v = Math.min(def.max, Math.max(def.min, value));
  const t =
    def.scale === "log" && def.min > 0
      ? Math.log(v / def.min) / Math.log(def.max / def.min)
      : (v - def.min) / (def.max - def.min);
  return Math.min(1, Math.max(0, t));
}

/** The snapped value at a slider position from 0 to 1, the inverse of `sliderPosition`. */
export function valueAtPosition(def: NumberParam, position: number): number {
  const t = Math.min(1, Math.max(0, position));
  const v =
    def.scale === "log" && def.min > 0
      ? def.min * (def.max / def.min) ** t
      : def.min + t * (def.max - def.min);
  return snap(def, v);
}

function serialiseValue(def: ParamDef, value: ParamValue): string {
  if (def.kind === "boolean") {
    return value === true ? "1" : "0";
  }
  return String(value);
}

/**
 * A layer's params as `[key, value]` pairs in schema order: only the values that
 * differ from their defaults, or every value when `full` is set.
 */
export function serialiseParams(
  schema: ParamSchema,
  values: ParamValues,
  full: boolean,
): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, def] of Object.entries(schema)) {
    const value = values[key] ?? def.default;
    if (full || !isDefault(def, value)) {
      pairs.push([key, serialiseValue(def, value)]);
    }
  }
  return pairs;
}

/** Reads a layer's params; a missing or invalid value takes its default. */
export function parseParams(schema: ParamSchema, raw: ReadonlyMap<string, string>): ParamValues {
  const values: ParamValues = {};
  for (const [key, def] of Object.entries(schema)) {
    const text = raw.get(key);
    values[key] = text === undefined ? def.default : coerce(def, text);
  }
  return values;
}
