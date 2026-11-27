// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { createPreferences, type Preferences } from "../lib/preferences";
import { defaultLayer, defaultMix, MAX_LAYERS, type Mix } from "../mixes/mix";
import type { EngineState, LayerState } from "../audio/engine";
import type { SoundEntry } from "../sounds/registry";
import { act } from "../test/act";
import { testCatalogue } from "../test/catalogue";
import { ControlPanel, FULL_MIX_HINT, LEVEL_RATE_HZ, type LevelMeter } from "./ControlPanel";
import { LOADING_DELAY_MS } from "./LayerSection";

type PanelOptions = {
  mix?: Mix;
  engineState?: EngineState;
  layerStates?: Record<string, LayerState>;
  preferences?: Preferences;
  hover?: boolean;
  onFullscreen?: () => void;
  solo?: ReadonlySet<string>;
  masterMuted?: boolean;
  addOpen?: boolean;
  sounds?: SoundEntry[];
  levels?: LevelMeter;
  levelsActive?: boolean;
};

function renderPanel(initial: PanelOptions = {}) {
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
    onAddLayer: vi.fn<(id: string) => void>(),
    onMasterChange: vi.fn<(master: number) => void>(),
    onMasterMutedChange: vi.fn<(muted: boolean) => void>(),
    onToggleSolo: vi.fn<(id: string) => void>(),
    onClearSolo: vi.fn<() => void>(),
    onAddOpenChange: vi.fn<(open: boolean) => void>(),
  };
  const preferences = initial.preferences ?? createPreferences(() => undefined);
  let options = initial;
  const panel = () => (
    <ControlPanel
      mix={options.mix ?? defaultMix()}
      engineState={options.engineState ?? "idle"}
      layerStates={options.layerStates ?? {}}
      preferences={preferences}
      hover={options.hover ?? true}
      onFullscreen={options.onFullscreen}
      shortcutsOpen={false}
      solo={options.solo ?? new Set()}
      masterMuted={options.masterMuted ?? false}
      addOpen={options.addOpen ?? false}
      levels={options.levels}
      levelsActive={options.levelsActive}
      sounds={options.sounds}
      {...handlers}
    />
  );
  const view = render(panel());
  /** Renders again with some options changed. */
  const update = (change: PanelOptions) => {
    options = { ...options, ...change };
    view.rerender(panel());
  };
  const rerender = (engineState: EngineState, layerStates: Record<string, LayerState>) => {
    update({ engineState, layerStates });
  };
  return { ...handlers, view, rerender, update, preferences };
}

const catalogue = testCatalogue();
/** A mix of the given test sounds, at their defaults. */
function mixOf(...ids: string[]): Mix {
  return {
    master: 70,
    layers: ids.map((id) => {
      const sound = catalogue.find((s) => s.id === id);
      if (!sound) {
        throw new Error(`No test sound ${id}`);
      }
      return defaultLayer(sound);
    }),
  };
}

describe("ControlPanel", () => {
  it("shows the title, toolbar and the default layer's controls", () => {
    const { onCopyLink, onHide } = renderPanel();
    expect(screen.getByRole("heading", { name: "Aural Farm" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide controls" }));
    expect(onCopyLink).toHaveBeenCalled();
    expect(onHide).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Test Tone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show Test Tone settings" })).toBeTruthy();
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
    expect(document.querySelector(".layer-row")?.textContent).toContain("2 changed");
  });

  it("collapses a layer's settings and remembers it, keeping the volume in view", () => {
    const preferences = createPreferences(() => undefined);
    const { view } = renderPanel({ preferences });
    const chevron = screen.getByRole("button", { name: "Show Test Tone settings" });
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(chevron);
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByLabelText("Pitch").closest("[hidden]")).not.toBeNull();
    expect(screen.getByLabelText("Volume")).toBeTruthy();
    expect([...preferences.getSet("closedSections")]).toEqual(["test-tone"]);
    view.unmount();
    renderPanel({ preferences });
    expect(
      screen.getByRole("button", { name: "Show Test Tone settings" }).getAttribute("aria-expanded"),
    ).toBe("false");
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

describe("Mixer rows", () => {
  it("shows a tint dot, the name and hint, and labels every button with the sound", () => {
    const sounds = catalogue.map((s) =>
      s.id === "alpha" ? Object.assign({}, s, { hint: "Use headphones" }) : s,
    );
    renderPanel({ mix: mixOf("alpha"), sounds });
    const row = document.querySelector(".layer");
    expect(row?.querySelector<HTMLElement>(".layer-dot")?.style.getPropertyValue("--tint")).toBe(
      "#111111",
    );
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByText("Use headphones")).toBeTruthy();
    for (const label of ["Solo Alpha", "Mute Alpha", "Show Alpha settings", "Remove Alpha"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("puts the layer's shortcuts in the Solo and Mute tooltips", () => {
    renderPanel({ mix: mixOf("alpha", "bravo"), sounds: catalogue });
    expect(screen.getByRole("button", { name: "Mute Bravo" }).title).toBe("Mute (2)");
    expect(screen.getByRole("button", { name: "Solo Bravo" }).title).toBe("Solo (Shift+2)");
  });

  it("mutes a layer, dimming it while its controls still work", () => {
    const mix = mixOf("alpha");
    const { onLayerChange, update } = renderPanel({ mix, sounds: catalogue });
    fireEvent.click(screen.getByRole("button", { name: "Mute Alpha" }));
    expect(onLayerChange).toHaveBeenCalledWith("alpha", { muted: true });
    const muted = mixOf("alpha");
    for (const layer of muted.layers) {
      layer.muted = true;
    }
    update({ mix: muted });
    const mute = screen.getByRole("button", { name: "Mute Alpha" });
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".layer")?.getAttribute("data-muted")).toBe("true");
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "20" } });
    expect(onLayerChange).toHaveBeenCalledWith("alpha", { volume: 20 });
    fireEvent.click(mute);
    expect(onLayerChange).toHaveBeenLastCalledWith("alpha", { muted: false });
  });

  it("solos layers, outlines them, and offers Clear solo in the header", () => {
    const { onToggleSolo, onClearSolo, update } = renderPanel({
      mix: mixOf("alpha", "bravo"),
      sounds: catalogue,
    });
    expect(screen.queryByRole("button", { name: "Clear solo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Solo Bravo" }));
    expect(onToggleSolo).toHaveBeenCalledWith("bravo");
    update({ solo: new Set(["bravo"]) });
    expect(screen.getByRole("button", { name: "Solo Bravo" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    const rows = document.querySelectorAll(".layer");
    expect([...rows].map((r) => r.getAttribute("data-soloed"))).toEqual(["false", "true"]);
    expect(document.querySelector(".solo-bar")?.textContent).toContain("Solo");
    fireEvent.click(screen.getByRole("button", { name: "Clear solo" }));
    expect(onClearSolo).toHaveBeenCalled();
  });

  it("ignores a solo for a sound that isn't in the mix", () => {
    renderPanel({ mix: mixOf("alpha"), sounds: catalogue, solo: new Set(["bravo"]) });
    expect(screen.queryByRole("button", { name: "Clear solo" })).toBeNull();
  });

  it("reports Remove, and moves focus to the next row's name", () => {
    const { onRemoveLayer, update } = renderPanel({
      mix: mixOf("alpha", "bravo", "charlie"),
      sounds: catalogue,
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove Bravo" }));
    expect(onRemoveLayer).toHaveBeenCalledWith("bravo");
    update({ mix: mixOf("alpha", "charlie") });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Charlie" }));
  });

  it("moves focus to Add sound after removing the last row", () => {
    const { update } = renderPanel({ mix: mixOf("alpha", "bravo"), sounds: catalogue });
    fireEvent.click(screen.getByRole("button", { name: "Remove Bravo" }));
    update({ mix: mixOf("alpha") });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add sound" }));
  });
});

describe("Master volume", () => {
  it("reports changes and mutes everything", () => {
    const { onMasterChange, onMasterMutedChange, update } = renderPanel();
    const slider = screen.getByLabelText<HTMLInputElement>("Master volume");
    expect(slider.value).toBe("70");
    fireEvent.input(slider, { target: { value: "40" } });
    expect(onMasterChange).toHaveBeenCalledWith(40);
    const mute = screen.getByRole("button", { name: "Mute everything" });
    expect(mute.title).toBe("Mute everything (M)");
    fireEvent.click(mute);
    expect(onMasterMutedChange).toHaveBeenCalledWith(true);
    update({ masterMuted: true });
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mute);
    expect(onMasterMutedChange).toHaveBeenLastCalledWith(false);
  });
});

describe("Add sound", () => {
  it("lists the sounds not in the mix, in Featured order, and focuses the first", () => {
    const { onAddOpenChange, update } = renderPanel({
      mix: mixOf("bravo", "alpha"),
      sounds: catalogue,
    });
    const button = screen.getByRole("button", { name: "Add sound" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(onAddOpenChange).toHaveBeenCalledWith(true);
    update({ addOpen: true });
    const list = screen.getByRole("list", { name: "Sounds to add" });
    const names = [...list.querySelectorAll("button")].map((b) => b.textContent);
    expect(names).toEqual([
      "Test Tone",
      "Charlie",
      "Delta",
      "Echo",
      "Foxtrot",
      "Golf",
      "Hotel",
      "India",
    ]);
    expect(document.activeElement?.textContent).toBe("Test Tone");
    expect(list.querySelector(".layer-dot")).not.toBeNull();
  });

  it("closes on Escape", () => {
    const { onAddOpenChange } = renderPanel({ sounds: catalogue, addOpen: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onAddOpenChange).toHaveBeenCalledWith(false);
  });

  it("adds a sound expanded, collapses the others, and focuses the new row", () => {
    const preferences = createPreferences(() => undefined);
    const { onAddLayer, onAddOpenChange, update } = renderPanel({
      mix: mixOf("alpha", "bravo"),
      sounds: catalogue,
      addOpen: true,
      preferences,
    });
    fireEvent.click(screen.getByRole("button", { name: "Charlie" }));
    expect(onAddLayer).toHaveBeenCalledWith("charlie");
    expect(onAddOpenChange).toHaveBeenCalledWith(false);
    expect([...preferences.getSet("closedSections")].toSorted()).toEqual(["alpha", "bravo"]);
    update({ mix: mixOf("alpha", "bravo", "charlie"), addOpen: false });
    const expanded = (name: string) =>
      screen.getByRole("button", { name: `Show ${name} settings` }).getAttribute("aria-expanded");
    expect([expanded("Alpha"), expanded("Bravo"), expanded("Charlie")]).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Charlie" }));
  });

  it(`is disabled with a hint once the mix holds ${String(MAX_LAYERS)} sounds`, () => {
    const ids = catalogue.slice(1, 1 + MAX_LAYERS).map((s) => s.id);
    renderPanel({ mix: mixOf(...ids), sounds: catalogue, addOpen: true });
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Add sound" });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(FULL_MIX_HINT)).toBeTruthy();
    expect(FULL_MIX_HINT).toBe("8 sounds is the most a mix can hold");
    expect(screen.queryByRole("list", { name: "Sounds to add" })).toBeNull();
  });

  it("shows the empty state with Add sound, and disables Play", () => {
    renderPanel({ mix: { master: 70, layers: [] }, sounds: catalogue });
    expect(screen.getByText("Add a sound to start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add sound" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Play" }).disabled).toBe(true);
  });

  it("still lets a playing empty mix pause", () => {
    renderPanel({ mix: { master: 70, layers: [] }, engineState: "playing" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Pause" }).disabled).toBe(false);
  });
});

describe("Activity dots", () => {
  function meter() {
    const stop = vi.fn<() => void>();
    const levels = {
      watch: vi.fn<() => () => void>(() => stop),
      get: vi.fn<(id: string) => number>((id) => (id === "alpha" ? 0.1 : 0)),
    };
    return { levels, stop };
  }
  const dot = (n: number) => [...document.querySelectorAll<HTMLElement>(".layer .layer-dot")].at(n);

  it("reads levels at 15 Hz only while active, and stops when inactive", () => {
    const { levels, stop } = meter();
    const { update } = renderPanel({ mix: mixOf("alpha", "bravo"), sounds: catalogue, levels });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(levels.watch).not.toHaveBeenCalled();
    expect(levels.get).not.toHaveBeenCalled();
    update({ levelsActive: true });
    expect(levels.watch).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(levels.get.mock.calls.length).toBe(LEVEL_RATE_HZ * 2);
    // −20 dBFS sits at (60 − 20) / 48 of the way up.
    expect(dot(0)?.style.getPropertyValue("--level")).toBe("0.83");
    expect(dot(1)?.style.getPropertyValue("--level")).toBe("0.00");
    update({ levelsActive: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dot(0)?.style.getPropertyValue("--level")).toBe("");
    const calls = levels.get.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(levels.get.mock.calls.length).toBe(calls);
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
