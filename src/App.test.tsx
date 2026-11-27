// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, HASH_DEBOUNCE_MS, IDLE_MS, TOAST_MS, UNDO_TOAST_MS, type EngineFactory } from "./App";
import type { AudioEngine, EngineState } from "./audio/engine";
import { createFavourites } from "./lib/favourites";
import { createPreferences } from "./lib/preferences";
import { MAX_LAYERS, parseHash, type Mix } from "./mixes/mix";
import { createSoundLoader } from "./sounds/loader";
import type { SoundEntry } from "./sounds/registry";
import { act } from "./test/act";
import { TEST_TONE_ID, testCatalogue } from "./test/catalogue";
import { fakeMediaSession } from "./test/fake-media";

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
    setSolo: vi.fn<AudioEngine["setSolo"]>(),
    setMasterMuted: vi.fn<AudioEngine["setMasterMuted"]>(),
    setPlayFadeIn: vi.fn<AudioEngine["setPlayFadeIn"]>(),
    watchLevels: vi.fn<AudioEngine["watchLevels"]>(() => () => undefined),
    getLevel: vi.fn<AudioEngine["getLevel"]>(() => 0),
    watchMasterLevel: vi.fn<AudioEngine["watchMasterLevel"]>(() => () => undefined),
    getMasterLevel: vi.fn<AudioEngine["getMasterLevel"]>(() => 0),
    dispose: vi.fn<AudioEngine["dispose"]>(),
  } satisfies AudioEngine;
  const factory: EngineFactory = (given) => {
    callbacks = given;
    return engine;
  };
  return { engine, factory, controls, setState, callbacks: () => callbacks };
}

const catalogue = testCatalogue();

/** Renders the app with `sounds` (the test catalogue by default), whose default is Test Tone. */
function renderApp(hash = "", fake = fakeEngine(), sounds: SoundEntry[] = catalogue) {
  window.history.replaceState(null, "", `/${hash}`);
  const replaceState = vi.spyOn(window.history, "replaceState");
  const view = render(
    <App
      initial={parseHash(window.location.hash, sounds, TEST_TONE_ID)}
      loader={loader}
      preferences={createPreferences(() => undefined)}
      favourites={createFavourites(() => undefined)}
      createEngine={fake.factory}
      sounds={sounds}
      defaultSoundId={TEST_TONE_ID}
    />,
  );
  return { replaceState, ...fake, view };
}

/** Renders the app with the test catalogue: Test Tone, then Alpha to India. */
function renderMixer(hash: string) {
  return renderApp(hash, fakeEngine(), catalogue);
}

/** The hash once the debounce has written it. */
function writtenHash() {
  act(() => {
    vi.advanceTimersByTime(HASH_DEBOUNCE_MS);
  });
  return window.location.hash;
}

const rowNames = () =>
  [...document.querySelectorAll(".layer .layer-title")].map((el) => el.textContent);

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

  it("resets every layer's settings and volume, and the master volume, but keeps mutes", () => {
    renderApp("#master=30&layers=test-tone&test-tone.volume=20&test-tone.soft=1&test-tone.muted=1");
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

describe("App media session and wake lock", () => {
  beforeEach(() => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  });

  function renderWithSession(hash: string, preferences = createPreferences(() => undefined)) {
    const fake = fakeEngine();
    const { session, handlers } = fakeMediaSession();
    const requests: string[] = [];
    const released: number[] = [];
    window.history.replaceState(null, "", `/${hash}`);
    render(
      <App
        initial={parseHash(window.location.hash, catalogue, TEST_TONE_ID)}
        loader={loader}
        preferences={preferences}
        favourites={createFavourites(() => undefined)}
        createEngine={fake.factory}
        sounds={catalogue}
        defaultSoundId={TEST_TONE_ID}
        mediaSession={session}
        mediaMetadata={(init) => ({ ...init }) as unknown as MediaMetadata}
        wakeLock={{
          request: (type) => {
            requests.push(type);
            const index = requests.length;
            return Promise.resolve({
              released: false,
              release: () => {
                released.push(index);
                return Promise.resolve();
              },
              addEventListener: () => undefined,
            });
          },
        }}
      />,
    );
    return { ...fake, session, handlers, requests, released };
  }

  it("names the mix's sounds in the session and follows changes", async () => {
    const { session } = renderWithSession("#layers=test-tone,alpha");
    await settle();
    expect(session.metadata?.title).toBe("Test Tone + Alpha");
    expect(session.metadata?.artist).toBe("Aural Farm");
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove/ })[1]);
    expect(session.metadata?.title).toBe("Test Tone");
  });

  it("mirrors the engine's state and plays, pauses and stops from the session", async () => {
    const { session, handlers, engine } = renderWithSession("#layers=test-tone");
    await settle();
    expect(session.playbackState).toBe("playing");
    act(() => {
      handlers.get("pause")?.({ action: "pause" });
    });
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(session.playbackState).toBe("paused");
    act(() => {
      handlers.get("play")?.({ action: "play" });
    });
    expect(engine.play).toHaveBeenCalledTimes(2);
    act(() => {
      handlers.get("stop")?.({ action: "stop" });
    });
    expect(engine.pause).toHaveBeenCalledTimes(2);
  });

  it("keeps the screen on with Keep screen on, only while playing", async () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("display.keepAwake", "1");
    const { requests, released, handlers } = renderWithSession("#layers=test-tone", preferences);
    await settle();
    expect(requests).toEqual(["screen"]);
    act(() => {
      handlers.get("pause")?.({ action: "pause" });
    });
    await settle();
    expect(released).toEqual([1]);
  });

  it("leaves the screen alone without Keep screen on", async () => {
    const { requests } = renderWithSession("#layers=test-tone");
    await settle();
    expect(requests).toEqual([]);
  });
});

describe("App mixer", () => {
  it("adds a sound at volume 70 at the end of the mix", () => {
    const { engine } = renderMixer("#layers=alpha");
    fireEvent.click(screen.getByRole("button", { name: "Add sound" }));
    fireEvent.click(screen.getByRole("option", { name: "Charlie" }));
    expect(rowNames()).toEqual(["Alpha", "Charlie"]);
    expect(engine.setMix.mock.lastCall?.[0].layers.at(-1)).toMatchObject({
      id: "charlie",
      volume: 70,
      muted: false,
    });
    expect(screen.queryByRole("listbox", { name: "Sounds" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Charlie" }));
    expect(writtenHash()).toBe("#layers=alpha,charlie");
  });

  it("removes a layer with an Undo toast that restores it in place", () => {
    renderMixer("#layers=alpha,bravo,charlie&bravo.volume=30&bravo.level=9&bravo.muted=1");
    fireEvent.click(screen.getByRole("button", { name: "Remove Bravo" }));
    expect(rowNames()).toEqual(["Alpha", "Charlie"]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Charlie" }));
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Removed Bravo");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(writtenHash()).toBe(
      "#layers=alpha,bravo,charlie&bravo.volume=30&bravo.muted=1&bravo.level=9",
    );
  });

  it("restores the last layer at the end, even after another was added", () => {
    renderMixer("#layers=alpha,bravo");
    fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Add sound" }));
    fireEvent.click(screen.getByRole("option", { name: "Delta" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Delta"]);
  });

  it("keeps the Undo toast for 5 s", () => {
    renderMixer("#layers=alpha");
    fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it(`holds at most ${String(MAX_LAYERS)} layers`, () => {
    renderMixer("#layers=alpha,bravo,charlie,delta,echo,foxtrot,golf");
    fireEvent.click(screen.getByRole("button", { name: "Add sound" }));
    fireEvent.click(screen.getByRole("option", { name: "Hotel" }));
    expect(rowNames()).toHaveLength(MAX_LAYERS);
    expect(screen.getByText("8 sounds is the most a mix can hold")).toBeTruthy();
    // `/` still opens the picker, where the sounds not in the mix can't be picked.
    fireEvent.keyDown(window, { key: "/", code: "Slash" });
    expect(screen.getByRole("note").textContent).toContain("8 sounds is the most a mix can hold");
    const india = screen.getByRole("option", { name: "India" });
    expect(india.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(india);
    expect(screen.getByRole("option", { name: "Alpha" }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close sound list" }));
    expect(rowNames()).not.toContain("India");
  });

  it("doesn't restore a layer into a full mix", () => {
    renderMixer("#layers=alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel");
    fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Add sound" }));
    fireEvent.click(screen.getByRole("option", { name: "India" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(rowNames()).not.toContain("Alpha");
    expect(rowNames()).toHaveLength(MAX_LAYERS);
  });

  it("solos through the engine, never the hash, and clears", () => {
    const { engine } = renderMixer("#layers=alpha,bravo");
    fireEvent.click(screen.getByRole("button", { name: "Solo Bravo" }));
    expect(engine.setSolo.mock.lastCall?.[0]).toEqual(new Set(["bravo"]));
    expect(writtenHash()).toBe("#layers=alpha,bravo");
    fireEvent.click(screen.getByRole("button", { name: "Clear solo" }));
    expect(engine.setSolo.mock.lastCall?.[0]).toEqual(new Set());
  });

  it("drops a removed layer's solo", () => {
    const { engine } = renderMixer("#layers=alpha,bravo");
    fireEvent.click(screen.getByRole("button", { name: "Solo Bravo" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Bravo" }));
    expect(engine.setSolo.mock.lastCall?.[0]).toEqual(new Set());
    expect(screen.queryByRole("button", { name: "Clear solo" })).toBeNull();
  });

  it("mutes a layer in the hash", () => {
    renderMixer("#layers=alpha,bravo");
    fireEvent.click(screen.getByRole("button", { name: "Mute Bravo" }));
    expect(writtenHash()).toBe("#layers=alpha,bravo&bravo.muted=1");
  });

  it("sets the master volume in the hash, and mutes everything outside it", () => {
    const { engine } = renderMixer("#layers=alpha");
    fireEvent.input(screen.getByLabelText("Master volume"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Mute everything" }));
    expect(engine.setMasterMuted.mock.lastCall?.[0]).toBe(true);
    expect(writtenHash()).toBe("#master=40&layers=alpha");
  });

  it("shows the empty state, doesn't autoplay it, and ignores Space", async () => {
    const { engine } = renderMixer("#layers=");
    await settle();
    expect(screen.getByText("Add a sound to start")).toBeTruthy();
    expect(engine.play).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: " " });
    expect(engine.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add sound" }));
    fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it("reads levels only while the panel is seen and the mix is playing", async () => {
    const { engine } = renderMixer("#layers=alpha");
    await settle();
    expect(engine.watchLevels).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide controls" }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const reads = engine.getLevel.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(engine.getLevel.mock.calls.length).toBe(reads);
  });
});

describe("App mixer shortcuts", () => {
  const press = (key: string, code: string, shiftKey = false) => {
    fireEvent.keyDown(window, { key, code, shiftKey });
  };
  const pressed = (label: string) =>
    screen.getByRole("button", { name: label }).getAttribute("aria-pressed");

  it("opens the sound picker with /, its search focused", () => {
    renderMixer("#layers=alpha&panel=hidden");
    press("/", "Slash");
    expect(panelWrap()?.getAttribute("data-visible")).toBe("true");
    expect(screen.getByRole("listbox", { name: "Sounds" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search sounds" }));
    // Typing in the search doesn't trigger shortcuts.
    fireEvent.keyDown(document.activeElement ?? window, { key: "m", code: "KeyM" });
    expect(screen.queryByRole("button", { name: "Mute everything" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add sound" }));
    expect(pressed("Mute everything")).toBe("false");
  });

  it("stars the focused layer with S, saying so", () => {
    renderMixer("#layers=alpha,bravo");
    // Nothing focused: nothing to star.
    press("s", "KeyS");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Mute Bravo" }), {
      key: "s",
      code: "KeyS",
    });
    expect(screen.getByRole("status").textContent).toBe("Starred Bravo");
    // Also on a slider, which can't take letters.
    const volume = screen.getAllByLabelText("Volume").at(1);
    fireEvent.keyDown(volume ?? window, { key: "S", code: "KeyS", shiftKey: true });
    expect(screen.getByRole("status").textContent).toBe("Unstarred Bravo");
    fireEvent.keyDown(screen.getByRole("button", { name: "Mute Alpha" }), {
      key: "s",
      code: "KeyS",
    });
    fireEvent.click(screen.getByRole("button", { name: "Show Alpha settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Alpha settings" }));
    expect(screen.getByRole("button", { name: "Star Alpha" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // The picker lists it under Favourites.
    press("/", "Slash");
    const favourites = screen.getByRole("group", { name: "Favourites" });
    expect(
      within(favourites)
        .getAllByRole("option")
        .map((o) => o.id.endsWith("alpha")),
    ).toEqual([true]);
  });

  it("mutes layer N with 1–8 and solos it with Shift", () => {
    const { engine } = renderMixer("#layers=alpha,bravo");
    press("2", "Digit2");
    expect(pressed("Mute Bravo")).toBe("true");
    press("2", "Digit2");
    expect(pressed("Mute Bravo")).toBe("false");
    press("!", "Digit1", true);
    expect(pressed("Solo Alpha")).toBe("true");
    expect(engine.setSolo.mock.lastCall?.[0]).toEqual(new Set(["alpha"]));
    press("!", "Digit1", true);
    expect(pressed("Solo Alpha")).toBe("false");
    // No layer 3: nothing happens.
    press("3", "Digit3");
    press("#", "Digit3", true);
    expect(writtenHash()).toBe("#layers=alpha,bravo");
  });

  it("mutes everything with M", () => {
    const { engine } = renderMixer("#layers=alpha");
    press("m", "KeyM");
    expect(pressed("Mute everything")).toBe("true");
    expect(engine.setMasterMuted.mock.lastCall?.[0]).toBe(true);
    press("M", "KeyM", true);
    expect(pressed("Mute everything")).toBe("false");
  });

  it("moves the master volume by 5 with the arrows when nothing has focus", () => {
    renderMixer("#master=98&layers=alpha");
    press("ArrowUp", "ArrowUp");
    expect(screen.getByLabelText<HTMLInputElement>("Master volume").value).toBe("100");
    press("ArrowDown", "ArrowDown");
    press("ArrowDown", "ArrowDown");
    expect(writtenHash()).toBe("#master=90&layers=alpha");
    // On a focused control the arrows are the control's own.
    fireEvent.keyDown(screen.getByRole("button", { name: "Copy link" }), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByLabelText("Volume"), { key: "ArrowUp" });
    expect(writtenHash()).toBe("#master=90&layers=alpha");
  });

  it("ignores the mixer shortcuts in form fields", () => {
    renderMixer("#layers=alpha");
    const volume = screen.getByLabelText("Volume");
    fireEvent.keyDown(volume, { key: "1", code: "Digit1" });
    fireEvent.keyDown(volume, { key: "m", code: "KeyM" });
    fireEvent.keyDown(volume, { key: "/", code: "Slash" });
    expect(pressed("Mute Alpha")).toBe("false");
    expect(pressed("Mute everything")).toBe("false");
    expect(screen.queryByRole("listbox", { name: "Sounds" })).toBeNull();
  });

  it("lists every shortcut in the popover", () => {
    renderMixer("#layers=alpha");
    const keys = [...document.querySelectorAll(".shortcuts-popover kbd")].map((k) => k.textContent);
    expect(keys).toEqual(["Space", "/", "S", "1–8", "Shift+1–8", "M", "↑ ↓", "H", "F", "D", "?"]);
  });

  it("cycles the backdrop Glow → Night → Off with D, saving it and saying so", () => {
    renderMixer("#layers=alpha");
    const backdrop = () => document.querySelector<HTMLElement>(".app")?.dataset.backdrop;
    expect(backdrop()).toBe("glow");
    fireEvent.keyDown(window, { key: "d" });
    expect(backdrop()).toBe("night");
    expect(screen.getByRole("status").textContent).toBe("Backdrop: Night");
    fireEvent.keyDown(window, { key: "D" });
    expect(backdrop()).toBe("off");
    expect(document.querySelector(".backdrop")?.getAttribute("data-backdrop")).toBe("off");
    fireEvent.keyDown(window, { key: "d" });
    expect(backdrop()).toBe("glow");
  });
});

describe("Panel layout", () => {
  /** Makes `queries` (and hover) match, as on a phone or a small window. */
  function screenMatching(...queries: string[]) {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: queries.includes(query),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
  }
  const panel = () => document.querySelector<HTMLElement>(".panel");
  const app = () => document.querySelector<HTMLElement>(".app");

  it("is a floating card on a wide, tall screen", () => {
    renderApp("#layers=test-tone");
    expect(app()?.dataset.layout).toBe("card");
    expect(panel()?.dataset.layout).toBe("card");
  });

  it("is a bottom sheet in portrait, collapsed until expanded", () => {
    screenMatching("(max-width: 640px)");
    renderApp("#layers=test-tone");
    expect(app()?.dataset.layout).toBe("sheet");
    expect(app()?.dataset.sheet).toBe("collapsed");
    expect(panel()?.dataset.layout).toBe("sheet");
    fireEvent.click(screen.getByRole("button", { name: "Expand mixer" }));
    expect(app()?.dataset.sheet).toBe("expanded");
    expect(panel()?.dataset.sheet).toBe("expanded");
    fireEvent.click(screen.getByRole("button", { name: "Collapse mixer" }));
    expect(app()?.dataset.sheet).toBe("collapsed");
  });

  it("expands the sheet for the sound picker when / opens it, and keeps it open after adding", () => {
    screenMatching("(max-width: 640px)");
    renderMixer("#layers=test-tone");
    fireEvent.keyDown(window, { key: "/" });
    expect(app()?.dataset.sheet).toBe("expanded");
    fireEvent.click(screen.getByRole("option", { name: /Alpha/ }));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(app()?.dataset.sheet).toBe("expanded");
    expect(document.activeElement?.textContent).toBe("Alpha");
  });

  it("is a drawer on a short, landscape screen, even a narrow one", () => {
    screenMatching("(max-height: 500px)", "(max-width: 640px)");
    renderApp("#layers=test-tone");
    expect(app()?.dataset.layout).toBe("drawer");
    expect(app()?.dataset.sheet).toBeUndefined();
    expect(panel()?.dataset.layout).toBe("drawer");
  });
});
