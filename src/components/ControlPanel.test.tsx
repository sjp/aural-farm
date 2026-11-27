// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { createPreferences, type Preferences } from "../lib/preferences";
import { defaultMix, type Mix } from "../mixes/mix";
import type { EngineState, LayerState } from "../audio/engine";
import { act } from "../test/act";
import { ControlPanel } from "./ControlPanel";
import { LOADING_DELAY_MS } from "./LayerSection";

function renderPanel(
  options: {
    mix?: Mix;
    engineState?: EngineState;
    layerStates?: Record<string, LayerState>;
    preferences?: Preferences;
    hover?: boolean;
    onFullscreen?: () => void;
  } = {},
) {
  const handlers = {
    onLayerChange: vi.fn<(id: string, change: object) => void>(),
    onParamChange: vi.fn<(id: string, key: string, value: unknown) => void>(),
    onResetAll: vi.fn<() => void>(),
    onCopyLink: vi.fn<() => void>(),
    onHide: vi.fn<() => void>(),
    onShortcutsOpenChange: vi.fn<(open: boolean) => void>(),
    onTogglePlay: vi.fn<() => void>(),
    onRetryLayer: vi.fn<(id: string) => void>(),
    onRemoveLayer: vi.fn<(id: string) => void>(),
  };
  const panel = (engineState: EngineState, layerStates: Record<string, LayerState>) => (
    <ControlPanel
      mix={options.mix ?? defaultMix()}
      engineState={engineState}
      layerStates={layerStates}
      preferences={options.preferences ?? createPreferences(() => undefined)}
      hover={options.hover ?? true}
      onFullscreen={options.onFullscreen}
      shortcutsOpen={false}
      {...handlers}
    />
  );
  const view = render(panel(options.engineState ?? "idle", options.layerStates ?? {}));
  const rerender = (engineState: EngineState, layerStates: Record<string, LayerState>) => {
    view.rerender(panel(engineState, layerStates));
  };
  return { ...handlers, view, rerender };
}

describe("ControlPanel", () => {
  it("shows the title, toolbar and the default layer's controls", () => {
    const { onCopyLink, onHide } = renderPanel();
    expect(screen.getByRole("heading", { name: "Aural Farm" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide controls" }));
    expect(onCopyLink).toHaveBeenCalled();
    expect(onHide).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Test Tone/ })).toBeTruthy();
    expect(screen.getByLabelText("Volume")).toBeTruthy();
    expect(screen.getByLabelText("Pitch")).toBeTruthy();
  });

  it("shows Fullscreen only when the browser supports it", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
    const onFullscreen = vi.fn<() => void>();
    renderPanel({ onFullscreen });
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(onFullscreen).toHaveBeenCalled();
  });

  it("adds shortcut hints and the Shortcuts button on hover devices only", () => {
    renderPanel({ hover: false });
    expect(screen.getByRole("button", { name: "Hide controls" }).title).toBe("Hide controls");
    expect(screen.queryByRole("button", { name: "Shortcuts" })).toBeNull();
  });

  it("opens the shortcuts popover", () => {
    const { onShortcutsOpenChange } = renderPanel({ hover: true });
    expect(screen.getByRole("button", { name: "Hide controls" }).title).toBe("Hide controls (H)");
    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    expect(onShortcutsOpenChange).toHaveBeenCalledWith(true);
  });

  it("reports volume and param changes for the layer, and Reset all", () => {
    const { onLayerChange, onParamChange, onResetAll } = renderPanel();
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "30" } });
    expect(onLayerChange).toHaveBeenCalledWith("test-tone", { volume: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Triangle" }));
    expect(onParamChange).toHaveBeenCalledWith("test-tone", "wave", "triangle");
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(onResetAll).toHaveBeenCalled();
  });

  it("counts a layer's changed settings", () => {
    const mix = defaultMix();
    mix.layers = mix.layers.map((l) => ({ ...l, volume: 20, params: { ...l.params, soft: true } }));
    renderPanel({ mix });
    expect(screen.getByRole("button", { name: /Test Tone/ }).textContent).toContain("2 changed");
  });

  it("collapses a layer and remembers it", () => {
    const preferences = createPreferences(() => undefined);
    const { view } = renderPanel({ preferences });
    const header = screen.getByRole("button", { name: /Test Tone/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect([...preferences.getSet("closedSections")]).toEqual(["test-tone"]);
    view.unmount();
    renderPanel({ preferences });
    expect(screen.getByRole("button", { name: /Test Tone/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("says when the mix is empty", () => {
    renderPanel({ mix: { master: 70, layers: [] } });
    expect(screen.getByText("The mix is empty.")).toBeTruthy();
  });

  it("shows Loading… only for slow loads", () => {
    const { rerender } = renderPanel({ layerStates: { "test-tone": "loading" } });
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    });
    expect(screen.queryByText("Loading…")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Loading…")).toBeTruthy();
    rerender("idle", { "test-tone": "ready" });
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("shows a failed layer's message, with Retry and Remove", () => {
    const { onRetryLayer, onRemoveLayer } = renderPanel({
      layerStates: { "test-tone": "failed: offline" },
    });
    expect(screen.getByRole("alert").textContent).toContain("Couldn't play Test Tone: offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryLayer).toHaveBeenCalledWith("test-tone");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemoveLayer).toHaveBeenCalledWith("test-tone");
  });
});

describe("Play button", () => {
  it.each([
    ["idle", "Play"],
    ["paused", "Play"],
    ["pausing", "Play"],
    ["interrupted", "Play"],
    ["playing", "Pause"],
    ["starting", "Pause"],
  ] as const)("in state %s offers %s", (engineState, label) => {
    const { onTogglePlay } = renderPanel({ engineState });
    const button = screen.getByRole("button", { name: label });
    fireEvent.click(button);
    expect(onTogglePlay).toHaveBeenCalled();
  });

  it("shows a spinner while starting", () => {
    renderPanel({ engineState: "starting" });
    const button = screen.getByRole("button", { name: "Pause" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector(".spinner")).not.toBeNull();
  });

  it("asks for a tap when autoplay is blocked", () => {
    const { onTogglePlay } = renderPanel({ engineState: "blocked" });
    fireEvent.click(screen.getByRole("button", { name: "Tap to play" }));
    expect(onTogglePlay).toHaveBeenCalled();
  });

  it("says when audio isn't available", () => {
    renderPanel({ engineState: "failed" });
    expect(screen.getByRole("alert").textContent).toBe("Audio isn't available in this browser.");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Play" }).disabled).toBe(true);
  });

  it("is the first control in the header, with the shortcut in its tooltip", () => {
    renderPanel();
    const first = document.querySelector(".panel-header button");
    expect(first?.getAttribute("aria-label")).toBe("Play");
    expect(first?.getAttribute("title")).toBe("Play (Space)");
  });
});
