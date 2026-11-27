// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { ExportSettings } from "../export/options";
import { createPreferences } from "../lib/preferences";
import { ExportSection, type ExportControls, type ExportProgress } from "./ExportSection";

const DEFAULTS: ExportSettings = { type: "clip", clipMinutes: 10, loopSeconds: 120, format: "wav" };

function renderSection(change: Partial<ExportControls> = {}, open = true) {
  const onSettingsChange = vi.fn<(settings: ExportSettings) => void>();
  const onExport = vi.fn<() => void>();
  const onCancel = vi.fn<() => void>();
  const preferences = createPreferences(() => undefined);
  if (open) {
    preferences.set("exportOpen", "1");
  }
  const controls: ExportControls = {
    settings: DEFAULTS,
    onSettingsChange,
    codec: "opus",
    coarse: false,
    canExport: true,
    progress: undefined,
    onExport,
    onCancel,
    ...change,
  };
  const view = render(<ExportSection controls={controls} preferences={preferences} />);
  const rerender = (next: Partial<ExportControls>) => {
    view.rerender(<ExportSection controls={{ ...controls, ...next }} preferences={preferences} />);
  };
  const header = () => screen.getByRole("button", { name: "Export", expanded: false });
  const group = (name: string) => within(screen.getByRole("group", { name }));
  const exportButton = () => screen.getByText("Export", { selector: ".export-button" });
  return {
    onSettingsChange,
    onExport,
    onCancel,
    preferences,
    rerender,
    header,
    group,
    exportButton,
  };
}

const sizeText = () => document.querySelector(".export-size .control-value")?.textContent;

describe("ExportSection", () => {
  it("starts collapsed, and remembers being opened", () => {
    const { header, preferences } = renderSection({}, false);
    expect(document.querySelector(".export-section .section-body")?.hasAttribute("hidden")).toBe(
      true,
    );
    fireEvent.click(header());
    expect(preferences.get("exportOpen")).toBe("1");
    expect(document.querySelector(".export-section .section-body")?.hasAttribute("hidden")).toBe(
      false,
    );
  });

  it("offers clip lengths of 1–60 min and shows the WAV's size", () => {
    renderSection();
    const select = screen.getByLabelText<HTMLSelectElement>("Length");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "1 min",
      "5 min",
      "10 min",
      "15 min",
      "30 min",
      "45 min",
      "60 min",
    ]);
    expect(select.value).toBe("600");
    expect(sizeText()).toBe("≈ 115 MB");
    expect(screen.getByText(/16-bit, 48 kHz stereo/)).toBeTruthy();
  });

  it("offers loop lengths of 30 s to 10 min", () => {
    renderSection({ settings: { ...DEFAULTS, type: "loop" } });
    const select = screen.getByLabelText<HTMLSelectElement>("Length");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "30 s",
      "1 min",
      "2 min",
      "5 min",
      "10 min",
    ]);
    expect(select.value).toBe("120");
  });

  it("changes the type, the length and the format", () => {
    const { onSettingsChange, group } = renderSection();
    fireEvent.click(group("Type").getByRole("button", { name: "Seamless loop" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULTS, type: "loop" });
    fireEvent.change(screen.getByLabelText("Length"), { target: { value: "2700" } });
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULTS, clipMinutes: 45 });
    fireEvent.click(group("Format").getByRole("button", { name: "Compressed" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULTS, format: "compressed" });
  });

  it("shows the compressed format the browser supports, and its size", () => {
    const { rerender } = renderSection({ settings: { ...DEFAULTS, format: "compressed" } });
    expect(screen.getByText(/Opus in WebM, 128 kb\/s/)).toBeTruthy();
    expect(sizeText()).toBe("≈ 9.8 MB");
    rerender({ codec: "aac" });
    expect(screen.getByText(/AAC in M4A, 160 kb\/s/)).toBeTruthy();
  });

  it("disables Compressed where the browser can't encode it, and exports WAV", () => {
    const { group } = renderSection({
      codec: "none",
      settings: { ...DEFAULTS, format: "compressed" },
    });
    const compressed = group("Format").getByRole<HTMLButtonElement>("button", {
      name: "Compressed",
    });
    expect(compressed.disabled).toBe(true);
    expect(compressed.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/not supported in this browser/)).toBeTruthy();
    expect(sizeText()).toBe("≈ 115 MB");
  });

  it("warns about a WAV over 500 MB and suggests the compressed format", () => {
    renderSection({ settings: { ...DEFAULTS, clipMinutes: 60 } });
    expect(document.querySelector(".export-warning")?.textContent).toBe(
      "That's a large file. Compressed would be ≈ 59 MB.",
    );
  });

  it("caps WAV at 15 minutes on touch-first devices", () => {
    const { exportButton, rerender } = renderSection({
      coarse: true,
      settings: { ...DEFAULTS, clipMinutes: 30 },
    });
    expect(exportButton()).toHaveProperty("disabled", true);
    expect(document.querySelector(".export-warning")?.textContent).toBe(
      "WAV is limited to 15 min on this device. Choose Compressed or a shorter length.",
    );
    rerender({ settings: { ...DEFAULTS, clipMinutes: 30, format: "compressed" } });
    expect(exportButton()).toHaveProperty("disabled", false);
    rerender({ settings: { ...DEFAULTS, clipMinutes: 15 } });
    expect(exportButton()).toHaveProperty("disabled", false);
  });

  it("exports, and can't with nothing to hear", () => {
    const { onExport, exportButton, rerender } = renderSection();
    fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledOnce();
    rerender({ canExport: false });
    expect(exportButton()).toHaveProperty("disabled", true);
    expect(screen.getByText("Add a sound to export it.")).toBeTruthy();
  });

  it("shows progress with the time left in place of Export, and cancels", () => {
    const progress: ExportProgress = { fraction: 0.425, remaining: 75 };
    const { onCancel } = renderSection({ progress });
    expect(document.querySelector(".export-button")).toBeNull();
    const bar = screen.getByRole("progressbar", { name: "Exporting" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.getAttribute("aria-valuetext")).toBe("42 %, about 2 min left");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows just the percentage until the time left is known", () => {
    renderSection({ progress: { fraction: 0, remaining: undefined } });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("0 %");
  });
});
