// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { MAX_SAVED_MIXES } from "../mixes/mixes";
import { MixesView, type MixEntry, type MixesControls } from "./MixesView";

const entry = (name: string, change: Partial<MixEntry> = {}): MixEntry => ({
  name,
  description: `${name} sounds`,
  sounds: [
    { id: "a", tint: "#112233" },
    { id: "b", tint: "#445566" },
  ],
  current: false,
  ...change,
});

function renderView(change: Partial<MixesControls> = {}) {
  const saved = change.saved ?? [entry("Rain"), entry("Wind")];
  const controls: MixesControls = {
    open: true,
    onOpenChange: vi.fn<MixesControls["onOpenChange"]>(),
    presets: [entry("Engine Hum", { description: "A hum." }), entry("Deep Brown")],
    saved,
    suggestedName: "Alpha + Bravo",
    canSave: true,
    findSaved: (name) => saved.find((m) => m.name.toLowerCase() === name.toLowerCase())?.name,
    onApplyPreset: vi.fn<MixesControls["onApplyPreset"]>(),
    onApplySaved: vi.fn<MixesControls["onApplySaved"]>(),
    onSave: vi.fn<MixesControls["onSave"]>(),
    onRename: vi.fn<MixesControls["onRename"]>(),
    onDelete: vi.fn<MixesControls["onDelete"]>(),
    onExport: vi.fn<MixesControls["onExport"]>(),
    onImport: vi.fn<MixesControls["onImport"]>(),
    importConflicts: undefined,
    onImportAnswer: vi.fn<MixesControls["onImportAnswer"]>(),
    ...change,
  };
  const onClose = vi.fn<() => void>();
  const view = render(<MixesView controls={controls} hover onClose={onClose} />);
  return { controls, onClose, view };
}

const group = (name: string) => within(screen.getByRole("group", { name }));
const nameField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Mix name" });

describe("MixesView", () => {
  it("lists presets and saved mixes, each with its name, line and tint dots", () => {
    renderView();
    const presets = group("Presets").getAllByRole("button");
    expect(presets.map((b) => b.querySelector(".picker-name")?.textContent)).toEqual([
      "Engine Hum",
      "Deep Brown",
    ]);
    expect(presets[0]?.querySelector(".picker-description")?.textContent).toBe("A hum.");
    expect(presets[0]?.querySelectorAll(".layer-dot")).toHaveLength(2);
    expect(group("My mixes").getByRole("button", { name: /^Rain/ })).toBeTruthy();
    expect(group("My mixes").getByRole("button", { name: "Rename Rain" })).toBeTruthy();
    expect(group("My mixes").getByRole("button", { name: "Delete Wind" })).toBeTruthy();
  });

  it("applies a preset or a saved mix when its row is picked", () => {
    const { controls } = renderView();
    fireEvent.click(group("Presets").getByRole("button", { name: /Deep Brown/ }));
    expect(controls.onApplyPreset).toHaveBeenCalledWith(1);
    fireEvent.click(group("My mixes").getByRole("button", { name: /^Wind/ }));
    expect(controls.onApplySaved).toHaveBeenCalledWith("Wind");
  });

  it("marks the mix that is playing", () => {
    renderView({ presets: [entry("Engine Hum", { current: true }), entry("Deep Brown")] });
    const row = group("Presets").getByRole("button", { name: /Engine Hum/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.textContent).toContain("Playing");
  });

  it("says where saved mixes will go before there are any", () => {
    renderView({ saved: [] });
    expect(group("My mixes").getByText(/Mixes you save appear here/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Export my mixes" }).disabled,
    ).toBe(true);
  });

  it("focuses Save mix… on opening, and Esc closes", () => {
    const { onClose } = renderView();
    const save = screen.getByRole("button", { name: "Save mix…" });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from its close button", () => {
    const { onClose } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Close mixes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MixesView saving", () => {
  it("asks for a name, prefilled with the suggestion, and saves it", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    expect(nameField().value).toBe("Alpha + Bravo");
    expect(document.activeElement).toBe(nameField());
    fireEvent.input(nameField(), { target: { value: "  Night\n" } });
    fireEvent.submit(nameField());
    expect(controls.onSave).toHaveBeenCalledWith("Night");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save mix…" }));
  });

  it("won't save an empty name", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    fireEvent.input(nameField(), { target: { value: " ​ " } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
    fireEvent.submit(nameField());
    expect(controls.onSave).not.toHaveBeenCalled();
  });

  it("asks before replacing a mix of the same name", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    fireEvent.input(nameField(), { target: { value: "rain" } });
    fireEvent.submit(nameField());
    expect(controls.onSave).not.toHaveBeenCalled();
    const question = within(screen.getByRole("group", { name: "Replace Rain?" }));
    fireEvent.click(question.getByRole("button", { name: "Replace" }));
    expect(controls.onSave).toHaveBeenCalledWith("rain");
  });

  it("cancels replacing", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    fireEvent.input(nameField(), { target: { value: "Wind" } });
    fireEvent.submit(nameField());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(controls.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save mix…" })).toBeTruthy();
  });

  it("Esc in the name field cancels without closing the view", () => {
    const { onClose } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    fireEvent.keyDown(nameField(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("can't save a mix without sounds", () => {
    renderView({ canSave: false });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save mix…" }).disabled).toBe(
      true,
    );
    expect(screen.getByText("Add a sound to save a mix")).toBeTruthy();
  });

  it("asks for one to be deleted once full, but still saves over a name", () => {
    const saved = Array.from({ length: MAX_SAVED_MIXES }, (_, i) => entry(`Mix ${String(i)}`));
    const { controls } = renderView({ saved });
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    expect(screen.getByRole("note").textContent).toContain("Delete one to save another");
    fireEvent.input(nameField(), { target: { value: "New" } });
    fireEvent.submit(nameField());
    expect(controls.onSave).not.toHaveBeenCalled();
    fireEvent.input(nameField(), { target: { value: "Mix 3" } });
    fireEvent.submit(nameField());
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(controls.onSave).toHaveBeenCalledWith("Mix 3");
  });
});

describe("MixesView rename and delete", () => {
  it("renames inline", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Rename Rain" }));
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "New name for Rain" });
    expect(field.value).toBe("Rain");
    fireEvent.input(field, { target: { value: "Rainy Cabin" } });
    fireEvent.submit(field);
    expect(controls.onRename).toHaveBeenCalledWith("Rain", "Rainy Cabin");
    expect(screen.queryByRole("textbox")).toBeNull();
    // The list hasn't followed the rename here, so focus falls back to Save mix….
    expect(document.activeElement?.textContent).toBe("Save mix…");
  });

  it("refuses another mix's name, and allows a change of case", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Rename Rain" }));
    const field = screen.getByRole("textbox", { name: "New name for Rain" });
    fireEvent.input(field, { target: { value: "WIND" } });
    fireEvent.submit(field);
    expect(screen.getByRole("alert").textContent).toBe("There's already a mix called Wind.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(controls.onRename).not.toHaveBeenCalled();
    fireEvent.input(field, { target: { value: "RAIN" } });
    fireEvent.submit(field);
    expect(controls.onRename).toHaveBeenCalledWith("Rain", "RAIN");
  });

  it("deletes, moving focus to the next row, or else the one before", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Delete Rain" }));
    expect(controls.onDelete).toHaveBeenCalledWith("Rain");
    expect((document.activeElement as HTMLElement | null)?.dataset.mixName).toBe("Wind");
    fireEvent.click(screen.getByRole("button", { name: "Delete Wind" }));
    expect((document.activeElement as HTMLElement | null)?.dataset.mixName).toBe("Rain");
  });

  it("returns focus to Rename when renaming is cancelled", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Rename Wind" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New name for Wind" }), {
      key: "Escape",
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Wind" }));
  });
});

describe("MixesView import and export", () => {
  it("exports", () => {
    const { controls } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Export my mixes" }));
    expect(controls.onExport).toHaveBeenCalledTimes(1);
  });

  it("imports a chosen file", () => {
    const { controls } = renderView();
    const input = screen.getByLabelText<HTMLInputElement>("Import mixes file");
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(["{}"], "aural-farm-mixes.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    expect(controls.onImport).toHaveBeenCalledWith(file);
  });

  it.each([
    ["Replace", true],
    ["Keep mine", false],
    ["Cancel", undefined],
  ])("asks before replacing on import: %s", (label, answer) => {
    const { controls } = renderView({ importConflicts: ["Rain", "Wind"] });
    const question = within(
      screen.getByRole("group", { name: "Rain, Wind are already saved. Replace with the file's?" }),
    );
    fireEvent.click(question.getByRole("button", { name: label }));
    expect(controls.onImportAnswer).toHaveBeenCalledWith(answer);
  });
});
