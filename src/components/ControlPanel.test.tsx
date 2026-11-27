// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { createPreferences, type Preferences } from "../lib/preferences";
import { defaultMix, type Mix } from "../mixes/mix";
import type { SoundLoader } from "../sounds/loader";
import { sounds } from "../sounds/registry";
import type { SoundDefinition } from "../sounds/types";
import { act } from "../test/act";
import { ControlPanel } from "./ControlPanel";
import { LOADING_DELAY_MS } from "./LayerSection";

const testTone = sounds[0];

/** A loader whose loads finish only when the test says so. */
function manualLoader() {
  let settle: { resolve: (d: SoundDefinition) => void; reject: (e: Error) => void } | undefined;
  const load = vi.fn<SoundLoader["load"]>(
    () =>
      new Promise<SoundDefinition>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  const loader: SoundLoader = {
    get: () => undefined,
    load,
    prefetch: vi.fn<SoundLoader["prefetch"]>(),
  };
  return {
    loader,
    load,
    resolve: async () => {
      const definition = await testTone.load();
      settle?.resolve(definition);
    },
    reject: () => {
      settle?.reject(new Error("offline"));
    },
  };
}

function renderPanel(
  options: {
    mix?: Mix;
    loader?: SoundLoader;
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
  };
  const view = render(
    <ControlPanel
      mix={options.mix ?? defaultMix()}
      loader={options.loader ?? manualLoader().loader}
      preferences={options.preferences ?? createPreferences(() => undefined)}
      hover={options.hover ?? true}
      onFullscreen={options.onFullscreen}
      shortcutsOpen={false}
      {...handlers}
    />,
  );
  return { ...handlers, view };
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

  it("shows Loading… only for slow loads", async () => {
    const { loader, resolve } = manualLoader();
    renderPanel({ loader });
    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    });
    expect(screen.queryByText("Loading…")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Loading…")).toBeTruthy();
    await act(async () => {
      await resolve();
    });
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("offers a retry when a load fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { loader, load, reject } = manualLoader();
    renderPanel({ loader });
    await act(async () => {
      reject();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load Test Tone");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
