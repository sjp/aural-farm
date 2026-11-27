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
import type { PanelLayout } from "./sheet";
import type { MixesControls } from "./MixesView";
import type { SleepTimerControls } from "./SleepTimer";

type PanelOptions = {
  mix?: Mix;
  edited?: boolean;
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
  layout?: PanelLayout;
  sheetOpen?: boolean;
  sleep?: SleepTimerControls;
  mixes?: MixesControls;
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
    onSheetOpenChange: vi.fn<(open: boolean) => void>(),
  };
  const preferences = initial.preferences ?? createPreferences(() => undefined);
  let options = initial;
  const panel = () => (
    <ControlPanel
      mix={options.mix ?? defaultMix(catalogue, TEST_TONE_ID)}
      edited={options.edited}
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
      layout={options.layout}
      sheetOpen={options.sheetOpen}
      sleep={options.sleep}
      mixes={options.mixes}
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
  it("shows the sound's description in its settings", () => {
    renderPanel();
    const settings = document.querySelector<HTMLElement>(".layer-settings") ?? document.body;
    expect(within(settings).getByText(/A quiet, steady tone/)).toBeTruthy();
  });

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
  const display = {
    backdrop: "glow",
    brightness: 50,
    respond: true,
    keepAwake: false,
    audioOutput: "auto",
  } as const;

  function renderDisplay(preferences = createPreferences(() => undefined), wakeLock = false) {
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
        wakeLock={wakeLock}
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

  it("offers Keep screen on only where the browser can keep the screen on", () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("displayOpen", "1");
    const { onDisplayChange } = renderDisplay(preferences, true);
    fireEvent.click(screen.getByRole("switch", { name: "Keep screen on" }));
    expect(onDisplayChange).toHaveBeenLastCalledWith({ ...display, keepAwake: true });
  });

  it("leaves Keep screen on out where the browser can't keep the screen on", () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("displayOpen", "1");
    renderDisplay(preferences, false);
    expect(screen.queryByRole("switch", { name: "Keep screen on" })).toBeNull();
  });

  it("keeps the audio output under a collapsed Advanced", () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("displayOpen", "1");
    const { onDisplayChange } = renderDisplay(preferences);
    const advanced = screen.getByRole("button", { name: "Advanced" });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(advanced);
    const output = screen.getByRole<HTMLSelectElement>("combobox", { name: "Audio output" });
    expect([...output.options].map((o) => o.textContent)).toEqual([
      "Auto",
      "Direct",
      "Media element",
    ]);
    fireEvent.change(output, { target: { value: "media" } });
    expect(onDisplayChange).toHaveBeenLastCalledWith({ ...display, audioOutput: "media" });
  });
});

describe("Bottom sheet", () => {
  const panel = () => document.querySelector<HTMLElement>(".panel");
  const content = () => document.querySelector<HTMLElement>(".sheet-content");
  const top = () => document.querySelector<HTMLElement>(".sheet-top");
  const peek = () => document.querySelector<HTMLElement>(".peek-bar");

  it("collapses to a peek bar: Play, the mix's sounds, Add sound and Expand", () => {
    renderPanel({ layout: "sheet", mix: mixOf("alpha", "bravo") });
    expect(panel()?.dataset.layout).toBe("sheet");
    expect(panel()?.dataset.sheet).toBe("collapsed");
    const bar = within(peek() ?? document.body);
    expect(bar.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(bar.getByText("Alpha + Bravo")).toBeTruthy();
    expect(bar.getByRole("button", { name: "Add sound" })).toBeTruthy();
    const expand = bar.getByRole("button", { name: "Expand mixer" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    // The rest is out of reach until it expands.
    expect(content()?.inert).toBe(true);
    expect(screen.queryByRole("heading", { name: "Aural Farm" })).toBeNull();
  });

  it("says when the mix is empty", () => {
    renderPanel({ layout: "sheet", mix: { master: 70, layers: [] } });
    expect(within(peek() ?? document.body).getByText("No sounds yet")).toBeTruthy();
  });

  it("expands from the expand button and from Add sound, which also opens the picker", () => {
    const { onSheetOpenChange, onAddOpenChange } = renderPanel({ layout: "sheet" });
    fireEvent.click(screen.getByRole("button", { name: "Expand mixer" }));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(true);
    onSheetOpenChange.mockClear();
    fireEvent.click(within(peek() ?? document.body).getByRole("button", { name: "Add sound" }));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(true);
    expect(onAddOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("expanded, puts the toolbar in the bar and the master volume first", () => {
    renderPanel({ layout: "sheet", sheetOpen: true, onFullscreen: () => undefined });
    expect(panel()?.dataset.sheet).toBe("expanded");
    expect(content()?.inert).toBe(false);
    const bar = within(peek() ?? document.body);
    for (const name of ["Play", "Copy link", "Fullscreen", "Hide controls", "Collapse mixer"]) {
      expect(bar.getByRole("button", { name })).toBeTruthy();
    }
    expect(bar.queryByRole("button", { name: "Add sound" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Play" })).toHaveLength(1);
    const first = content()?.querySelector("input");
    expect(first?.getAttribute("aria-label")).toBe("Master volume");
  });

  it("collapses from the bar's button, closing the picker", () => {
    const { onSheetOpenChange, onAddOpenChange } = renderPanel({
      layout: "sheet",
      sheetOpen: true,
      addOpen: true,
    });
    expect(screen.getByRole("combobox", { name: "Search sounds" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse mixer" }));
    expect(onSheetOpenChange).toHaveBeenLastCalledWith(false);
    expect(onAddOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("stays expanded while the picker is open", () => {
    renderPanel({ layout: "sheet", sheetOpen: false, addOpen: true });
    expect(panel()?.dataset.sheet).toBe("expanded");
    expect(panel()?.dataset.picker).toBe("true");
  });

  it("collapses on a tap on the backdrop, but not on one inside the panel", () => {
    const { onSheetOpenChange } = renderPanel({ layout: "sheet", sheetOpen: true });
    fireEvent.pointerDown(screen.getByLabelText("Master volume"));
    expect(onSheetOpenChange).not.toHaveBeenCalled();
    const backdrop = document.createElement("canvas");
    backdrop.className = "backdrop";
    document.body.append(backdrop);
    fireEvent.pointerDown(backdrop);
    expect(onSheetOpenChange).toHaveBeenCalledWith(false);
    backdrop.remove();
  });

  it("toggles on a tap on the bar outside its buttons", () => {
    const { onSheetOpenChange } = renderPanel({ layout: "sheet" });
    const summary = within(peek() ?? document.body).getByText("Test Tone");
    fireEvent.pointerDown(summary, { pointerId: 1, button: 0, clientY: 800 });
    fireEvent.pointerUp(summary, { pointerId: 1, button: 0, clientY: 802 });
    expect(onSheetOpenChange).toHaveBeenCalledWith(true);
  });

  describe("dragging", () => {
    const TRAVEL = 500;
    /** Drags the bar from y=600 through `ys`, `ms` apart, and lets go at the last. */
    function drag(ys: number[], ms = 16, restMs = 0) {
      const bar = top();
      const sheetContent = content();
      if (!bar || !sheetContent) {
        throw new Error("No sheet");
      }
      vi.spyOn(sheetContent, "offsetHeight", "get").mockReturnValue(TRAVEL);
      bar.setPointerCapture = () => undefined;
      fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientY: 600 });
      for (const y of ys) {
        vi.advanceTimersByTime(ms);
        fireEvent.pointerMove(bar, { pointerId: 1, clientY: y });
      }
      vi.advanceTimersByTime(restMs);
      fireEvent.pointerUp(bar, { pointerId: 1, clientY: ys.at(-1) });
    }

    it("follows the finger, then hands the sheet back to the stylesheet", () => {
      renderPanel({ layout: "sheet" });
      const bar = top();
      const sheetContent = content();
      if (!bar || !sheetContent) {
        throw new Error("No sheet");
      }
      vi.spyOn(sheetContent, "offsetHeight", "get").mockReturnValue(TRAVEL);
      bar.setPointerCapture = () => undefined;
      fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientY: 600 });
      fireEvent.pointerMove(bar, { pointerId: 1, clientY: 500 });
      expect(panel()?.style.transform).toBe(`translateY(${String(TRAVEL - 100)}px)`);
      expect(panel()?.dataset.dragging).toBe("true");
      // It can't go past either end.
      fireEvent.pointerMove(bar, { pointerId: 1, clientY: 0 });
      expect(panel()?.style.transform).toBe("translateY(0px)");
      fireEvent.pointerCancel(bar, { pointerId: 1 });
      expect(panel()?.style.transform).toBe("");
      expect(panel()?.dataset.dragging).toBeUndefined();
    });

    it("opens when let go of past halfway", () => {
      const { onSheetOpenChange } = renderPanel({ layout: "sheet" });
      drag([560, 400, 300], 16, 200);
      expect(onSheetOpenChange).toHaveBeenCalledWith(true);
    });

    it("springs back when let go of short of halfway", () => {
      const { onSheetOpenChange } = renderPanel({ layout: "sheet" });
      drag([560, 450, 400], 16, 200);
      expect(onSheetOpenChange).not.toHaveBeenCalled();
    });

    it("opens on a short, fast flick up", () => {
      const { onSheetOpenChange } = renderPanel({ layout: "sheet" });
      drag([590, 570, 550]);
      expect(onSheetOpenChange).toHaveBeenCalledWith(true);
    });

    it("closes on a short, fast flick down", () => {
      const { onSheetOpenChange } = renderPanel({ layout: "sheet", sheetOpen: true });
      drag([610, 630, 650]);
      expect(onSheetOpenChange).toHaveBeenCalledWith(false);
    });

    it("doesn't toggle at the end of a drag that starts on a button", () => {
      const { onSheetOpenChange } = renderPanel({ layout: "sheet", sheetOpen: true });
      drag([650, 700, 1100], 16, 200);
      expect(onSheetOpenChange).toHaveBeenCalledTimes(1);
      expect(onSheetOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

describe("Mix name", () => {
  const named = { ...mixOf("alpha", "bravo"), name: "Night" };

  it("titles the card with the mix's name, and (edited) once changed", () => {
    const { update } = renderPanel({ mix: named });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Night");
    update({ edited: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Night (edited)");
  });

  it("never marks an unnamed mix (edited)", () => {
    renderPanel({ mix: mixOf("alpha"), edited: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Aural Farm");
  });

  it("shows the name in the peek bar in place of the sounds", () => {
    renderPanel({ layout: "sheet", mix: named, edited: true });
    expect(document.querySelector(".peek-summary")?.textContent).toBe("Night (edited)");
  });
});

describe("Mixes view", () => {
  const mixes = (change: Partial<MixesControls> = {}): MixesControls => ({
    open: false,
    onOpenChange: vi.fn<MixesControls["onOpenChange"]>(),
    presets: [
      {
        name: "Engine Hum",
        description: "A hum.",
        sounds: [{ id: "a", tint: "#123456" }],
        current: false,
      },
    ],
    saved: [],
    suggestedName: "Test Tone",
    canSave: true,
    findSaved: () => undefined,
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
  });

  it("shows no Mixes button unless given the mixes", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Mixes" })).toBeNull();
  });

  it("opens from the Mixes button in the header", () => {
    const controls = mixes();
    renderPanel({ mixes: controls });
    const button = screen.getByRole("button", { name: "Mixes" });
    expect(button.closest(".panel-header-row")).not.toBeNull();
    expect(button.getAttribute("title")).toBe("Mixes (P)");
    fireEvent.click(button);
    expect(controls.onOpenChange).toHaveBeenCalledWith(true);
  });

  it("takes over the panel while open, and closing returns focus to the Mixes button", () => {
    const controls = mixes({ open: true });
    const { update } = renderPanel({ mixes: controls });
    expect(document.querySelector<HTMLElement>(".panel")?.dataset.picker).toBe("true");
    expect(screen.getByRole("heading", { name: "Mixes" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Presets" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add sound" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close mixes" }));
    expect(controls.onOpenChange).toHaveBeenCalledWith(false);
    update({ mixes: { ...controls, open: false } });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Mixes" }));
  });

  it("gives way to the sound picker", () => {
    const controls = mixes({ open: true });
    renderPanel({ mixes: controls, addOpen: true });
    expect(screen.getByRole("combobox", { name: "Search sounds" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mixes" })).toBeNull();
  });

  it("opens from the expanded sheet's bar", () => {
    const controls = mixes();
    const { onAddOpenChange } = renderPanel({ mixes: controls, layout: "sheet", sheetOpen: true });
    fireEvent.click(screen.getByRole("button", { name: "Mixes" }));
    expect(controls.onOpenChange).toHaveBeenCalledWith(true);
    expect(onAddOpenChange).not.toHaveBeenCalled();
  });

  it("expands the sheet, and collapsing the sheet closes it", () => {
    const controls = mixes({ open: true });
    const { onSheetOpenChange } = renderPanel({ mixes: controls, layout: "sheet" });
    expect(document.querySelector<HTMLElement>(".panel")?.dataset.sheet).toBe("expanded");
    fireEvent.click(screen.getByRole("button", { name: "Collapse mixer" }));
    expect(controls.onOpenChange).toHaveBeenCalledWith(false);
    expect(onSheetOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Drawer", () => {
  it("lays the usual panel out as a drawer, with no peek bar", () => {
    renderPanel({ layout: "drawer" });
    expect(document.querySelector<HTMLElement>(".panel")?.dataset.layout).toBe("drawer");
    expect(document.querySelector(".peek-bar")).toBeNull();
    expect(screen.getByRole("heading", { name: "Aural Farm" })).toBeTruthy();
  });
});

describe("Sleep timer", () => {
  const sleep = (change: Partial<SleepTimerControls> = {}): SleepTimerControls => ({
    minutes: undefined,
    remaining: undefined,
    settings: { lastMinutes: undefined, fadeOut: 300, fadeIn: 3 },
    onChoose: vi.fn<SleepTimerControls["onChoose"]>(),
    onSettingsChange: vi.fn<SleepTimerControls["onSettingsChange"]>(),
    ...change,
  });

  it("shows no clock button unless given a timer", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: /Sleep timer/ })).toBeNull();
  });

  it("puts the clock next to Play in the card, showing the time left", () => {
    renderPanel({ sleep: sleep({ minutes: 60, remaining: 42 * 60 }) });
    const button = screen.getByRole("button", { name: "Sleep timer, 42:00 left" });
    expect(button.textContent).toBe("42:00");
    expect(button.closest(".panel-header-row")).not.toBeNull();
    const before = button.closest(".sleep-timer")?.previousElementSibling;
    expect(before?.getAttribute("aria-label")).toBe("Play");
  });

  it("puts the clock next to the peek bar's Play, and the time after the summary", () => {
    renderPanel({ layout: "sheet", sleep: sleep({ minutes: 90, remaining: 3725 }) });
    const button = screen.getByRole("button", { name: "Sleep timer, 1:03:00 left" });
    expect(button.closest(".peek-bar")).not.toBeNull();
    expect(button.textContent).toBe("");
    expect(document.querySelector(".peek-summary + .peek-countdown")?.textContent).toBe("1:03:00");
  });

  it("expands the sheet as its menu opens", () => {
    const { onSheetOpenChange } = renderPanel({ layout: "sheet", sleep: sleep() });
    fireEvent.click(screen.getByRole("button", { name: "Sleep timer" }));
    expect(onSheetOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("dialog", { name: "Sleep timer" }).hidden).toBe(false);
  });
});
