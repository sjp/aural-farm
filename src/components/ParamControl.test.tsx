// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { ParamDef, ParamValue } from "../sounds/types";
import { ParamControl } from "./ParamControl";

const linear: ParamDef = {
  kind: "number",
  label: "Level",
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.5,
};
const log: ParamDef = {
  kind: "number",
  label: "Pitch",
  min: 110,
  max: 880,
  step: 1,
  default: 220,
  unit: "Hz",
  scale: "log",
};
const short: ParamDef = {
  kind: "select",
  label: "Wave",
  options: [
    { value: "sine", label: "Sine" },
    { value: "triangle", label: "Triangle" },
  ],
  default: "sine",
};
const long: ParamDef = {
  kind: "select",
  label: "Room",
  options: [
    { value: "a", label: "A small room" },
    { value: "b", label: "B" },
  ],
  default: "a",
};
const toggle: ParamDef = { kind: "boolean", label: "Soft", default: false };

function setup(def: ParamDef, value: ParamValue) {
  const onChange = vi.fn<(value: ParamValue) => void>();
  const onReset = vi.fn<() => void>();
  render(<ParamControl id="x" def={def} value={value} onChange={onChange} onReset={onReset} />);
  return { onChange, onReset };
}

describe("ParamControl", () => {
  it("shows a linear number as a slider with its value", () => {
    const { onChange } = setup(linear, 0.5);
    const slider = screen.getByLabelText<HTMLInputElement>("Level");
    expect(slider.type).toBe("range");
    expect(slider.step).toBe("0.05");
    expect(screen.getByText("0.50")).toBeTruthy();
    expect(slider.style.getPropertyValue("--p")).toBe("50%");
    fireEvent.input(slider, { target: { value: "0.25" } });
    expect(onChange).toHaveBeenCalledWith(0.25);
  });

  it("moves a log number along its position and shows the unit", () => {
    const { onChange } = setup(log, 220);
    const slider = screen.getByLabelText<HTMLInputElement>("Pitch");
    expect(screen.getByText("220 Hz")).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBe("220 Hz");
    expect(Number(slider.value)).toBeCloseTo(333.3, 0);
    fireEvent.input(slider, { target: { value: "1000" } });
    expect(onChange).toHaveBeenLastCalledWith(880);
  });

  it("steps a log number at least one grid step when the move is tiny", () => {
    const { onChange } = setup(log, 110);
    const slider = screen.getByLabelText<HTMLInputElement>("Pitch");
    fireEvent.input(slider, { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith(111);
  });

  it("shows a short select as segmented buttons", () => {
    const { onChange } = setup(short, "sine");
    const sine = screen.getByRole("button", { name: "Sine" });
    const triangle = screen.getByRole("button", { name: "Triangle" });
    expect(sine.getAttribute("aria-pressed")).toBe("true");
    expect(triangle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("group", { name: "Wave" })).toBeTruthy();
    fireEvent.click(triangle);
    expect(onChange).toHaveBeenCalledWith("triangle");
  });

  it("shows a select with long labels as a list", () => {
    const { onChange } = setup(long, "a");
    const select = screen.getByLabelText<HTMLSelectElement>("Room");
    expect(select.tagName).toBe("SELECT");
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("shows a boolean as a switch", () => {
    const { onChange } = setup(toggle, false);
    const box = screen.getByRole("switch", { name: "Soft" });
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it.each([
    [linear, 0.5, 0.2],
    [log, 220, 440],
    [short, "sine", "triangle"],
    [long, "a", "b"],
    [toggle, false, true],
  ] as const)("offers a reset for %o only when changed", (def, initial, changed) => {
    const { onReset } = setup(def, initial);
    expect(screen.queryByRole("button", { name: `Reset ${def.label}` })).toBeNull();
    render(
      <ParamControl
        id="y"
        def={def}
        value={changed}
        onChange={() => undefined}
        onReset={onReset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `Reset ${def.label}` }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
