// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, HASH_DEBOUNCE_MS, IDLE_MS, TOAST_MS, type EngineFactory } from "./App";
import type { AudioEngine, EngineState } from "./audio/engine";
import { createPreferences } from "./lib/preferences";
import { parseHash, type Mix } from "./mixes/mix";
import { createSoundLoader } from "./sounds/loader";
import { act } from "./test/act";

const loader = createSoundLoader();

/**
 * A stand-in engine: `play()` reaches `playResult`, `pause()` pauses, and every
 * layer it is given is reported ready at once.
 */
function fakeEngine() {
  let callbacks: Parameters<EngineFactory>[0] | undefined;
  let state: EngineState = "idle";
  const setState = (next: EngineState) => {
    state = next;
    callbacks?.onState(next);
  };
  const controls = { playResult: "playing" as EngineState };
  const engine = {
    get state() {
      return state;
    },
    context: undefined,
    play: vi.fn<AudioEngine["play"]>(() => {
      setState(controls.playResult);
      return Promise.resolve(state);
    }),
    pause: vi.fn<AudioEngine["pause"]>(() => {
      setState("paused");
    }),
    setMix: vi.fn<(mix: Mix) => void>((mix) => {
      for (const layer of mix.layers) {
        callbacks?.onLayerState(layer.id, "ready");
      }
    }),
    retry: vi.fn<AudioEngine["retry"]>(),
    dispose: vi.fn<AudioEngine["dispose"]>(),
  } satisfies AudioEngine;
  const factory: EngineFactory = (given) => {
    callbacks = given;
    return engine;
  };
  return { engine, factory, controls, setState, callbacks: () => callbacks };
}

function renderApp(hash = "", fake = fakeEngine()) {
  window.history.replaceState(null, "", `/${hash}`);
  const replaceState = vi.spyOn(window.history, "replaceState");
  const view = render(
    <App
      initial={parseHash(window.location.hash)}
      loader={loader}
      preferences={createPreferences(() => undefined)}
      createEngine={fake.factory}
    />,
  );
  return { replaceState, ...fake, view };
}

/** Lets the autoplay attempt settle. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function setHash(hash: string) {
  act(() => {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

const panelWrap = () => document.querySelector(".panel-wrap");
const showPanel = () => screen.getByRole("button", { name: /Show controls/, hidden: true });

beforeEach(() => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: query === "(hover: hover)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App hash sync", () => {
  it("writes changes to the hash once the debounce settles", () => {
    const { replaceState } = renderApp("#layers=test-tone");
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "30" } });
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "40" } });
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS - 1);
    });
    expect(replaceState).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#layers=test-tone&test-tone.volume=40");
  });

  it("doesn't rewrite a hash that already matches", () => {
    const { replaceState } = renderApp("#layers=test-tone&test-tone.pitch=330");
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS * 4);
    });
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("applies an edited hash without a reload", () => {
    renderApp("#layers=test-tone");
    setHash("#layers=test-tone&test-tone.wave=triangle&test-tone.volume=15");
    expect(screen.getByRole("button", { name: "Triangle" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Volume").value).toBe("15");
  });

  it("skips a hash that matches the state, so its own writes don't loop", () => {
    const { replaceState } = renderApp("#layers=test-tone&test-tone.pitch=330");
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS);
    });
    // Same mix, spelled out in full: nothing to apply and nothing to write back.
    const full = "#master=70&layers=test-tone&test-tone.pitch=330&test-tone.wave=sine";
    setHash(full);
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS);
    });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe(full);
  });

  it("hides the panel for panel=hidden and shows the corner button", () => {
    renderApp("#layers=test-tone&panel=hidden");
    expect(panelWrap()?.getAttribute("data-visible")).toBe("false");
    expect(showPanel().getAttribute("data-visible")).toBe("true");
    fireEvent.click(showPanel());
    expect(panelWrap()?.getAttribute("data-visible")).toBe("true");
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS);
    });
    expect(window.location.hash).toBe("#layers=test-tone");
  });

  it("writes panel=hidden when the panel is hidden", () => {
    renderApp("#layers=test-tone");
    fireEvent.click(screen.getByRole("button", { name: "Hide controls" }));
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS);
    });
    expect(window.location.hash).toBe("#layers=test-tone&panel=hidden");
  });

  it("resets every layer's settings and volume", () => {
    renderApp("#layers=test-tone&test-tone.volume=20&test-tone.soft=1&test-tone.muted=1");
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS);
    });
    expect(window.location.hash).toBe("#layers=test-tone&test-tone.muted=1");
  });
});

describe("App shortcuts", () => {
  it("toggles the panel with H", () => {
    renderApp();
    fireEvent.keyDown(window, { key: "h" });
    expect(panelWrap()?.getAttribute("data-visible")).toBe("false");
    fireEvent.keyDown(window, { key: "H" });
    expect(panelWrap()?.getAttribute("data-visible")).toBe("true");
  });

  it("ignores keys with modifiers or in form fields", () => {
    renderApp();
    fireEvent.keyDown(window, { key: "h", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("Volume"), { key: "h" });
    expect(panelWrap()?.getAttribute("data-visible")).toBe("true");
  });

  it("opens the shortcuts popover with ? and closes it with Escape", () => {
    renderApp();
    const dialog = document.querySelector<HTMLElement>('[aria-label="Keyboard shortcuts"]');
    expect(dialog?.hidden).toBe(true);
    fireEvent.keyDown(window, { key: "?" });
    expect(dialog?.hidden).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog?.hidden).toBe(true);
  });

  it("toggles fullscreen with F when the browser supports it", () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const request = vi.fn<() => Promise<void>>(() => Promise.resolve());
    document.documentElement.requestFullscreen = request;
    renderApp();
    fireEvent.keyDown(window, { key: "f" });
    expect(request).toHaveBeenCalled();
    Reflect.deleteProperty(document, "fullscreenEnabled");
  });
});

describe("App toasts and idle", () => {
  it("copies a full link with the panel hidden and shows a toast", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp("#layers=test-tone");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const copied = new URL(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied.hash).toBe(
      "#master=70&layers=test-tone&test-tone.volume=70&test-tone.muted=0&test-tone.pitch=220&test-tone.wave=sine&test-tone.soft=0&test-tone.seed=1&panel=hidden",
    );
    expect(screen.getByRole("status").textContent).toBe("Link copied");
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(screen.queryByRole("status")).toBeNull();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("fades the panel when idle, but not while the pointer is over it", () => {
    renderApp();
    act(() => {
      vi.advanceTimersByTime(IDLE_MS);
    });
    expect(panelWrap()?.getAttribute("data-visible")).toBe("false");
    expect(document.querySelector(".app")?.getAttribute("data-idle")).toBe("true");
    act(() => {
      window.dispatchEvent(new Event("pointermove"));
    });
    expect(panelWrap()?.getAttribute("data-visible")).toBe("true");
    const wrap = panelWrap();
    if (wrap) {
      fireEvent.pointerEnter(wrap);
    }
    act(() => {
      vi.advanceTimersByTime(IDLE_MS);
    });
    expect(panelWrap()?.getAttribute("data-visible")).toBe("true");
  });

  it("doesn't fade after touch input", () => {
    renderApp();
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
      vi.advanceTimersByTime(IDLE_MS);
    });
    expect(panelWrap()?.getAttribute("data-visible")).toBe("true");
  });
});

describe("App playback", () => {
  it("tries to play on start-up, after giving the engine the mix", async () => {
    const { engine } = renderApp("#layers=test-tone&test-tone.volume=30");
    await settle();
    expect(engine.setMix).toHaveBeenCalledTimes(1);
    expect(engine.setMix.mock.calls[0]?.[0].layers[0]?.volume).toBe(30);
    expect(engine.play).toHaveBeenCalledTimes(1);
    expect(engine.setMix.mock.invocationCallOrder[0]).toBeLessThan(
      engine.play.mock.invocationCallOrder[0] ?? 0,
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("passes mix changes to the engine", async () => {
    const { engine } = renderApp("#layers=test-tone");
    await settle();
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "40" } });
    expect(engine.setMix.mock.lastCall?.[0].layers[0]?.volume).toBe(40);
  });

  it("toggles with the Play/Pause button", async () => {
    const { engine } = renderApp();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(engine.pause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(engine.play).toHaveBeenCalledTimes(2);
  });

  it("toggles with Space, unless Space presses a button there", async () => {
    const { engine } = renderApp();
    await settle();
    fireEvent.keyDown(window, { key: " " });
    expect(engine.pause).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: " " });
    expect(engine.play).toHaveBeenCalledTimes(2);
    // A slider has no use for Space, so it still toggles there.
    fireEvent.keyDown(screen.getByLabelText("Volume"), { key: " " });
    expect(engine.pause).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("button", { name: "Copy link" }), { key: " " });
    expect(engine.play).toHaveBeenCalledTimes(2);
  });

  it("plays on the first input anywhere after autoplay was blocked", async () => {
    const fake = fakeEngine();
    fake.controls.playResult = "blocked";
    const { engine, controls } = renderApp("", fake);
    await settle();
    expect(screen.getByRole("button", { name: "Tap to play" })).toBeTruthy();
    // The Tap to play button handles its own click, so its pointerdown is skipped.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Tap to play" }));
    expect(engine.play).toHaveBeenCalledTimes(1);
    controls.playResult = "playing";
    fireEvent.pointerDown(document.body);
    await settle();
    expect(engine.play).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    // Once playing, input no longer starts anything.
    fireEvent.keyDown(window, { key: "x" });
    expect(engine.play).toHaveBeenCalledTimes(2);
  });

  it("shows a Tap to play prompt over the page when the panel is hidden", async () => {
    const fake = fakeEngine();
    fake.controls.playResult = "blocked";
    const { engine, controls } = renderApp("#panel=hidden", fake);
    await settle();
    const prompt = document.querySelector<HTMLButtonElement>(".play-prompt");
    expect(prompt?.textContent).toBe("Tap to play");
    controls.playResult = "playing";
    if (prompt) {
      fireEvent.click(prompt);
    }
    await settle();
    expect(engine.play).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".play-prompt")).toBeNull();
  });

  it("retries a failed layer and removes one", async () => {
    const { engine, callbacks } = renderApp("#layers=test-tone");
    await settle();
    act(() => {
      callbacks()?.onLayerState("test-tone", "failed: broke");
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(engine.retry).toHaveBeenCalledWith("test-tone");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(engine.setMix.mock.lastCall?.[0].layers).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(HASH_DEBOUNCE_MS);
    });
    expect(window.location.hash).toBe("#layers=");
  });

  it("disposes the engine on unmount", async () => {
    const { engine, view } = renderApp();
    await settle();
    act(() => {
      view.unmount();
    });
    expect(engine.dispose).toHaveBeenCalled();
  });
});
