// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { ParamSchema, ParamValue } from "../sounds/types";
import { ParamSections } from "./ParamSections";
import { countChanged, groupParams } from "./sections";

const ungrouped = {
  a: { kind: "boolean", label: "A", default: false },
  b: { kind: "boolean", label: "B", default: false },
} as const satisfies ParamSchema;

const grouped = {
  a: { kind: "boolean", label: "A", default: false, group: "Tone" },
  b: { kind: "boolean", label: "B", default: false },
  c: { kind: "boolean", label: "C", default: false, group: "Tone" },
  d: { kind: "boolean", label: "D", default: false, group: "Space" },
} as const satisfies ParamSchema;

describe("groupParams", () => {
  it("orders sections by first appearance and puts ungrouped params in Settings", () => {
    expect(groupParams(grouped)).toEqual([
      { name: "Tone", keys: ["a", "c"] },
      { name: "Settings", keys: ["b"] },
      { name: "Space", keys: ["d"] },
    ]);
  });

  it("counts changed params", () => {
    expect(countChanged(grouped, { a: true, b: false, c: true, d: false })).toBe(2);
    expect(countChanged(grouped, { a: true, b: false, c: true, d: false }, ["a", "b"])).toBe(1);
  });
});

function renderSections(schema: ParamSchema, closed: ReadonlySet<string> = new Set()) {
  const onToggle = vi.fn<(section: string) => void>();
  const onParamChange = vi.fn<(key: string, value: ParamValue) => void>();
  const values = Object.fromEntries(Object.keys(schema).map((k) => [k, k === "a"]));
  render(
    <ParamSections
      idPrefix="s"
      schema={schema}
      values={values}
      closed={closed}
      onToggle={onToggle}
      onParamChange={onParamChange}
    />,
  );
  return { onToggle, onParamChange };
}

describe("ParamSections", () => {
  it("shows a single section without a header", () => {
    renderSections(ungrouped);
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    expect(screen.getByRole("switch", { name: "A" })).toBeTruthy();
  });

  it("shows several sections as collapsible headers with changed counts", () => {
    const { onToggle } = renderSections(grouped, new Set(["Space"]));
    const tone = screen.getByRole("button", { name: /Tone/ });
    const space = screen.getByRole("button", { name: /Space/ });
    expect(tone.getAttribute("aria-expanded")).toBe("true");
    expect(tone.textContent).toContain("1 changed");
    expect(space.getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(space.getAttribute("aria-controls") ?? "");
    expect(body?.hidden).toBe(true);
    fireEvent.click(space);
    expect(onToggle).toHaveBeenCalledWith("Space");
  });

  it("reports changes and resets with the param's key", () => {
    const { onParamChange } = renderSections(grouped);
    fireEvent.click(screen.getByRole("switch", { name: "B" }));
    expect(onParamChange).toHaveBeenCalledWith("b", true);
    fireEvent.click(screen.getByRole("button", { name: "Reset A" }));
    expect(onParamChange).toHaveBeenCalledWith("a", false);
  });
});
