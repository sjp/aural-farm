import { describe, expect, it } from "vitest";
import {
  coerce,
  defaults,
  formatValue,
  parseParams,
  serialiseParams,
  sliderPosition,
  snap,
  stepDecimals,
  valueAtPosition,
} from "./params";
import { sounds } from "./registry";
import type { NumberParam, ParamSchema } from "./types";

const linear: NumberParam = {
  kind: "number",
  label: "L",
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.5,
};
const offGrid: NumberParam = { kind: "number", label: "O", min: 0, max: 10, step: 3, default: 3 };
const log: NumberParam = {
  kind: "number",
  label: "Pitch",
  min: 110,
  max: 880,
  step: 1,
  default: 220,
  unit: "Hz",
  scale: "log",
};

const schema = {
  level: linear,
  pitch: log,
  wave: {
    kind: "select",
    label: "Wave",
    options: [
      { value: "sine", label: "Sine" },
      { value: "triangle", label: "Triangle" },
    ],
    default: "sine",
  },
  soft: { kind: "boolean", label: "Soft", default: false },
} as const satisfies ParamSchema;

describe("stepDecimals", () => {
  it.each([
    [1, 0],
    [0.5, 1],
    [0.05, 2],
    [0.001, 3],
    [1e-7, 7],
    [25, 0],
    [0, 0],
    [Number.NaN, 0],
  ])("needs %d decimals for step %d", (step, expected) => {
    expect(stepDecimals(step)).toBe(expected);
  });
});

describe("snap", () => {
  it.each([
    [linear, 0.123, 0.1],
    [linear, 0.125, 0.15],
    [linear, -3, 0],
    [linear, 7, 1],
    [linear, 0.30000000000000004, 0.3],
    [offGrid, 10, 9],
    [offGrid, 100, 9],
    [offGrid, 4, 3],
  ])("snaps %o's %d to %d", (def, value, expected) => {
    expect(snap(def, value)).toBe(expected);
  });
});

describe("coerce", () => {
  it.each([
    ["0.42", 0.4],
    [" 0.6 ", 0.6],
    ["", 0.5],
    ["abc", 0.5],
    ["Infinity", 0.5],
    ["1e9", 1],
    [0.33, 0.35],
    [Number.NaN, 0.5],
    [undefined, 0.5],
    [true, 0.5],
  ])("reads number %o as %d", (raw, expected) => {
    expect(coerce(linear, raw)).toBe(expected);
  });

  it.each([
    ["triangle", "triangle"],
    ["square", "sine"],
    ["", "sine"],
    [1, "sine"],
  ])("reads select %o as %s", (raw, expected) => {
    expect(coerce(schema.wave, raw)).toBe(expected);
  });

  it.each([
    ["1", true],
    ["0", false],
    [true, true],
    [false, false],
    ["true", false],
    ["yes", false],
    [undefined, false],
  ])("reads boolean %o as %s", (raw, expected) => {
    expect(coerce(schema.soft, raw)).toBe(expected);
  });
});

describe("formatValue", () => {
  it("shows the step's decimals and the unit", () => {
    expect(formatValue(linear, 0.5)).toBe("0.50");
    expect(formatValue(log, 220)).toBe("220 Hz");
  });
});

describe("log slider mapping", () => {
  it("puts the ends at 0 and 1 and the geometric middle at 0.5", () => {
    expect(sliderPosition(log, 110)).toBe(0);
    expect(sliderPosition(log, 880)).toBe(1);
    expect(sliderPosition(log, 311)).toBeCloseTo(0.5, 2);
  });

  it("is monotonic", () => {
    let previous = -1;
    for (let v = log.min; v <= log.max; v += log.step) {
      const position = sliderPosition(log, v);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
  });

  it.each([110, 111, 220, 440, 523, 879, 880])("round-trips %d Hz", (value) => {
    expect(valueAtPosition(log, sliderPosition(log, value))).toBe(value);
  });

  it("maps a linear slider linearly", () => {
    expect(sliderPosition(linear, 0.25)).toBe(0.25);
    expect(valueAtPosition(linear, 0.25)).toBe(0.25);
  });

  it("clamps positions and values outside the range", () => {
    expect(sliderPosition(log, 10)).toBe(0);
    expect(valueAtPosition(log, 2)).toBe(880);
  });
});

describe("per-layer serialisation", () => {
  it("writes only changed values by default, in schema order", () => {
    const values = { ...defaults(schema), soft: true, level: 0.2 };
    expect(serialiseParams(schema, values, false)).toEqual([
      ["level", "0.2"],
      ["soft", "1"],
    ]);
  });

  it("writes every value when full", () => {
    expect(serialiseParams(schema, defaults(schema), true)).toEqual([
      ["level", "0.5"],
      ["pitch", "220"],
      ["wave", "sine"],
      ["soft", "0"],
    ]);
  });

  it("reads missing and invalid values as defaults", () => {
    const raw = new Map([
      ["pitch", "999"],
      ["wave", "nope"],
    ]);
    expect(parseParams(schema, raw)).toEqual({ ...defaults(schema), pitch: 880 });
  });

  it.each([false, true])("round-trips (full: %s)", (full) => {
    const values = { level: 0.05, pitch: 879, wave: "triangle", soft: true };
    const raw = new Map(serialiseParams(schema, values, full));
    expect(parseParams(schema, raw)).toEqual(values);
  });
});

describe.each(sounds.map((s) => [s.id, s] as const))("%s params", (_, sound) => {
  const entries = Object.entries(sound.params);
  const numbers = entries.flatMap(([k, d]) => (d.kind === "number" ? [[k, d] as const] : []));
  const selects = entries.flatMap(([k, d]) => (d.kind === "select" ? [[k, d] as const] : []));
  const booleans = entries.flatMap(([k, d]) => (d.kind === "boolean" ? [[k, d] as const] : []));

  it.each(numbers)("has a valid range for %s, with the default on the grid", (_key, def) => {
    expect(def.min).toBeLessThan(def.max);
    expect(def.step).toBeGreaterThan(0);
    expect(snap(def, def.default)).toBe(def.default);
    // A log slider needs a positive range.
    expect(def.scale === "log" ? def.min : 1).toBeGreaterThan(0);
  });

  it.each(selects)("has distinct labelled options for %s, including the default", (_key, def) => {
    const values = def.options.map((o) => o.value);
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(def.default);
    expect(def.options.every((o) => o.label.trim() !== "")).toBe(true);
  });

  it.each(booleans)("has a boolean default for %s", (_key, def) => {
    expect(typeof def.default).toBe("boolean");
  });

  it("round-trips its defaults", () => {
    const values = defaults(sound.params);
    const raw = new Map(serialiseParams(sound.params, values, true));
    expect(parseParams(sound.params, raw)).toEqual(values);
  });
});
