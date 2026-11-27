// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { createPreferences, type Preferences } from "../lib/preferences";
import { defaultLayer, defaultMix, MAX_LAYERS, type Mix } from "../mixes/mix";
import type { EngineState, LayerState } from "../audio/engine";
import type { SoundEntry } from "../sounds/registry";
import { act } from "../test/act";
import { TEST_TONE_ID, testCatalogue } from "../test/catalogue";
import { ControlPanel, LEVEL_RATE_HZ, type LevelMeter } from "./ControlPanel";
import { FULL_MIX_HINT } from "./mixer";
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
  favourites?: ReadonlySet<string>;
  onToggleFavourite?: (id: string) => void;
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
      mix={options.mix ?? defaultMix(catalogue, TEST_TONE_ID)}
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
      sounds={options.sounds ?? catalogue}
      favourites={options.favourites}
      onToggleFavourite={options.onToggleFavourite}
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
    const mix = defaultMix(catalogue, TEST_TONE_ID);
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
  const optionNames = () =>
    within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.querySelector(".picker-name")?.textContent);

  it("opens the sound picker in place of the mixer, with the search focused", () => {
    const { onAddOpenChange, update } = renderPanel({
      mix: mixOf("bravo", "alpha"),
      sounds: catalogue,
    });
    const button = screen.getByRole("button", { name: "Add sound" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.title).toBe("Add sound (/)");
    fireEvent.click(button);
    expect(onAddOpenChange).toHaveBeenCalledWith(true);
    update({ addOpen: true });
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search sounds" }));
    expect(screen.getByRole("button", { name: "Close sound list" })).toBeTruthy();
    expect(optionNames()).toEqual(catalogue.map((s) => s.name));
    // The mixer, master volume and footer are hidden while it's open.
    expect(screen.queryByRole("heading", { name: "Alpha" })).toBeNull();
    expect(screen.queryByLabelText("Master volume")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
  });

  it("closes on Escape and returns focus to Add sound", () => {
    const { onAddOpenChange, update } = renderPanel({ sounds: catalogue, addOpen: true });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search sounds" }), { key: "Escape" });
    expect(onAddOpenChange).toHaveBeenCalledWith(false);
    update({ addOpen: false });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add sound" }));
  });

  it("closes with the close button", () => {
    const { onAddOpenChange } = renderPanel({ sounds: catalogue, addOpen: true });
    fireEvent.click(screen.getByRole("button", { name: "Close sound list" }));
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
    fireEvent.click(screen.getByRole("option", { name: "Charlie" }));
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

  it("keeps the picker open after Shift+Enter", () => {
    const { onAddLayer, onAddOpenChange } = renderPanel({
      mix: mixOf("alpha"),
      sounds: catalogue,
      addOpen: true,
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search sounds" }), {
      key: "Enter",
      shiftKey: true,
    });
    expect(onAddLayer).toHaveBeenCalledWith(TEST_TONE_ID);
    expect(onAddOpenChange).not.toHaveBeenCalled();
  });

  it("focuses a sound already in the mix instead of adding it", () => {
    const { onAddLayer, onAddOpenChange, update } = renderPanel({
      mix: mixOf("alpha", "bravo"),
      sounds: catalogue,
      addOpen: true,
    });
    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));
    expect(onAddLayer).not.toHaveBeenCalled();
    expect(onAddOpenChange).toHaveBeenCalledWith(false);
    update({ addOpen: false });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Bravo" }));
  });

  it(`still opens once the mix holds ${String(MAX_LAYERS)} sounds, with a hint`, () => {
    const ids = catalogue.slice(1, 1 + MAX_LAYERS).map((s) => s.id);
    const { update } = renderPanel({ mix: mixOf(...ids), sounds: catalogue });
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Add sound" });
    expect(button.disabled).toBe(false);
    expect(screen.getByText(FULL_MIX_HINT)).toBeTruthy();
    expect(FULL_MIX_HINT).toBe("8 sounds is the most a mix can hold");
    update({ addOpen: true });
    expect(screen.getByRole("note").textContent).toContain(FULL_MIX_HINT);
  });

  it("stars a sound from the picker and from an expanded row", () => {
    const onToggleFavourite = vi.fn<(id: string) => void>();
    const { update } = renderPanel({ mix: mixOf("alpha", "bravo"), sounds: catalogue });
    update({ favourites: new Set(["alpha"]), onToggleFavourite });
    const star = screen.getByRole("button", { name: "Star Alpha" });
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(star.title).toBe("Unstar (S)");
    fireEvent.click(screen.getByRole("button", { name: "Star Bravo" }));
    expect(onToggleFavourite).toHaveBeenLastCalledWith("bravo");
    // A collapsed row has no star.
    fireEvent.click(screen.getByRole("button", { name: "Show Alpha settings" }));
    expect(screen.queryByRole("button", { name: "Star Alpha" })).toBeNull();
    update({ addOpen: true });
    fireEvent.click(screen.getByRole("button", { name: "Star Charlie" }));
    expect(onToggleFavourite).toHaveBeenLastCalledWith("charlie");
    expect(screen.getByRole("group", { name: "Favourites" })).toBeTruthy();
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

describe("Display section", () => {
  const display = { backdrop: "glow", brightness: 50, respond: true } as const;

  function renderDisplay(preferences = createPreferences(() => undefined)) {
    const onDisplayChange = vi.fn<(settings: object) => void>();
    const handler = () => undefined;
    render(
      <ControlPanel
        mix={defaultMix(catalogue, TEST_TONE_ID)}
        engineState="idle"
        layerStates={{}}
        preferences={preferences}
        hover
        onFullscreen={undefined}
        shortcutsOpen={false}
        solo={new Set()}
        masterMuted={false}
        addOpen={false}
        sounds={catalogue}
        display={display}
        onDisplayChange={onDisplayChange}
        onLayerChange={handler}
        onParamChange={handler}
        onResetAll={handler}
        onCopyLink={handler}
        onHide={handler}
        onShortcutsOpenChange={handler}
        onTogglePlay={handler}
        onRetryLayer={handler}
        onRemoveLayer={handler}
        onAddLayer={handler}
        onMasterChange={handler}
        onMasterMutedChange={handler}
        onToggleSolo={handler}
        onClearSolo={handler}
        onAddOpenChange={handler}
      />,
    );
    return { onDisplayChange, preferences };
  }

  it("sits at the bottom of the panel body, collapsed until opened, and remembers that", () => {
    const { preferences } = renderDisplay();
    const header = screen.getByRole("button", { name: "Display" });
    expect(header.closest(".panel-body")?.lastElementChild).toBe(header.closest("section"));
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(preferences.get("displayOpen")).toBe("1");
  });

  it("offers Glow, Night and Off, Brightness and Respond to sound", () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("displayOpen", "1");
    const { onDisplayChange } = renderDisplay(preferences);
    const modes = screen.getByRole("group", { name: "Backdrop" });
    expect([...modes.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Glow",
      "Night",
      "Off",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Night" }));
    expect(onDisplayChange).toHaveBeenLastCalledWith({ ...display, backdrop: "night" });
    fireEvent.input(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "20" },
    });
    expect(onDisplayChange).toHaveBeenLastCalledWith({ ...display, brightness: 20 });
    fireEvent.click(screen.getByRole("switch", { name: "Respond to sound" }));
    expect(onDisplayChange).toHaveBeenLastCalledWith({ ...display, respond: false });
  });
});
