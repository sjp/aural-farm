// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  HASH_DEBOUNCE_MS,
  IDLE_MS,
  STORAGE_FAILED,
  TOAST_MS,
  UNDO_TOAST_MS,
  type EngineFactory,
} from "./App";
import type { AudioEngine, EngineState } from "./audio/engine";
import { createFavourites } from "./lib/favourites";
import { createPreferences } from "./lib/preferences";
import { createInstallPrompt } from "./lib/install-prompt";
import type { AppUpdates } from "./lib/service-worker";
import { createStore } from "./lib/store";
import { MAX_LAYERS, parseHash, type Mix } from "./mixes/mix";
import { createSavedMixes, MIXES_KEY, type SavedMixes } from "./mixes/mixes";
import type { Preset } from "./mixes/presets";
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
    setSleepTimer: vi.fn<AudioEngine["setSleepTimer"]>(),
    sleepRemaining: vi.fn<AudioEngine["sleepRemaining"]>(() => undefined),
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

/** Presets made of test sounds. */
const TEST_PRESETS: Preset[] = [
  {
    id: "duo",
    name: "Duo",
    description: "Alpha and Bravo together.",
    hash: "#name=Duo&layers=alpha,bravo&alpha.volume=50&bravo.level=9",
  },
  {
    id: "charlie",
    name: "Charlie Alone",
    description: "Just Charlie.",
    hash: "#name=Charlie%20Alone&layers=charlie",
  },
];

/** Saved mixes kept in a map, as localStorage would keep them. */
function memoryMixes() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  return { data, savedMixes: createSavedMixes(() => storage) };
}

/** Renders the app with `sounds` (the test catalogue by default), whose default is Test Tone. */
function renderApp(
  hash = "",
  fake = fakeEngine(),
  sounds: SoundEntry[] = catalogue,
  savedMixes: SavedMixes = memoryMixes().savedMixes,
) {
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
      savedMixes={savedMixes}
      presets={TEST_PRESETS}
    />,
  );
  return { replaceState, ...fake, view, savedMixes };
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

describe("App mix names", () => {
  const heading = () => screen.getByRole("heading", { level: 1 });

  it("shows a named mix's name in the header and the page title", () => {
    renderMixer("#name=Night%20Drive&layers=alpha");
    expect(heading().textContent).toBe("Night Drive");
    expect(document.title).toBe("Night Drive · Aural Farm");
  });

  it("shows the app's name for an unnamed mix", () => {
    renderMixer("#layers=alpha");
    expect(heading().textContent).toBe("Aural Farm");
    expect(document.title).toBe("Aural Farm");
  });

  it("keeps the name when the mix is edited, marking it (edited) until it's back as it was", () => {
    renderMixer("#name=Night&layers=alpha");
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "30" } });
    expect(heading().textContent).toBe("Night (edited)");
    expect(writtenHash()).toBe("#name=Night&layers=alpha&alpha.volume=30");
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "70" } });
    expect(heading().textContent).toBe("Night");
  });

  it("takes a pasted hash as the mix to compare against", () => {
    renderMixer("#name=Night&layers=alpha");
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "30" } });
    setHash("#name=Day&layers=bravo");
    expect(heading().textContent).toBe("Day");
  });
});

describe("App mixes", () => {
  const heading = () => screen.getByRole("heading", { level: 1 }).textContent;
  const group = (name: string) => within(screen.getByRole("group", { name }));
  const openMixes = () => {
    fireEvent.keyDown(window, { key: "p", code: "KeyP" });
  };
  const closeMixes = () => {
    fireEvent.click(screen.getByRole("button", { name: "Close mixes" }));
  };
  const applyPreset = (name: RegExp) => {
    fireEvent.click(group("Presets").getByRole("button", { name }));
  };
  const saveAs = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    const field = screen.getByRole("textbox", { name: "Mix name" });
    fireEvent.input(field, { target: { value: name } });
    fireEvent.submit(field);
  };
  const toast = () => screen.getByRole("status");

  it("opens with P, in place of the picker, and lists the presets", () => {
    renderMixer("#layers=alpha");
    fireEvent.keyDown(window, { key: "/" });
    openMixes();
    expect(screen.queryByRole("listbox", { name: "Sounds" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Mixes" })).toBeTruthy();
    const duo = group("Presets").getByRole("button", { name: /^Duo/ });
    expect(duo.textContent).toContain("Alpha and Bravo together.");
    expect(duo.querySelectorAll(".layer-dot")).toHaveLength(2);
    // / goes back to the picker.
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByRole("listbox", { name: "Sounds" })).toBeTruthy();
  });

  it("applies a preset through the engine's diff, with its name, and marks it playing", () => {
    const { engine } = renderMixer("#layers=alpha");
    openMixes();
    applyPreset(/^Duo/);
    const mix = engine.setMix.mock.lastCall?.[0];
    expect(mix?.name).toBe("Duo");
    expect(mix?.layers.map((l) => [l.id, l.volume, l.params])).toEqual([
      ["alpha", 50, { level: 5 }],
      ["bravo", 70, { level: 9 }],
    ]);
    expect(
      group("Presets").getByRole("button", { name: /^Duo/ }).getAttribute("aria-current"),
    ).toBe("true");
    expect(writtenHash()).toBe("#name=Duo&layers=alpha,bravo&alpha.volume=50&bravo.level=9");
    expect(document.title).toBe("Duo · Aural Farm");
    closeMixes();
    expect(heading()).toBe("Duo");
  });

  it("offers Undo when the mix it replaces isn't kept anywhere", () => {
    renderMixer("#layers=alpha&alpha.volume=33");
    openMixes();
    applyPreset(/^Duo/);
    expect(toast().textContent).toContain("Replaced your mix");
    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    expect(writtenHash()).toBe("#layers=alpha&alpha.volume=33");
  });

  it("leaves the toast up for five seconds", () => {
    renderMixer("#layers=alpha");
    openMixes();
    applyPreset(/^Duo/);
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    });
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("replaces a preset or saved mix without asking, since it's kept", () => {
    renderMixer("#layers=alpha");
    openMixes();
    applyPreset(/^Duo/);
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS);
    });
    applyPreset(/^Charlie Alone/);
    expect(screen.queryByRole("status")).toBeNull();
    expect(writtenHash()).toBe("#name=Charlie%20Alone&layers=charlie");
  });

  it("does nothing when the preset is already playing", () => {
    const { engine } = renderMixer("#name=Charlie%20Alone&layers=charlie");
    openMixes();
    const calls = engine.setMix.mock.calls.length;
    applyPreset(/^Charlie Alone/);
    expect(engine.setMix.mock.calls.length).toBe(calls);
  });

  it("clears solo for the new mix, and Undo brings it back", () => {
    const { engine } = renderMixer("#layers=alpha,bravo");
    fireEvent.keyDown(window, { key: "!", code: "Digit1", shiftKey: true });
    expect([...(engine.setSolo.mock.lastCall?.[0] ?? [])]).toEqual(["alpha"]);
    openMixes();
    applyPreset(/^Duo/);
    expect([...(engine.setSolo.mock.lastCall?.[0] ?? [])]).toEqual([]);
    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    expect([...(engine.setSolo.mock.lastCall?.[0] ?? [])]).toEqual(["alpha"]);
  });

  it("saves the mix under a name, in full, and names the mix playing", () => {
    const mixes = memoryMixes();
    renderApp("#layers=alpha,bravo&alpha.volume=40", fakeEngine(), catalogue, mixes.savedMixes);
    openMixes();
    fireEvent.click(screen.getByRole("button", { name: "Save mix…" }));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Mix name" }).value).toBe(
      "Alpha + Bravo",
    );
    const field = screen.getByRole("textbox", { name: "Mix name" });
    fireEvent.input(field, { target: { value: "Evening" } });
    fireEvent.submit(field);
    expect(toast().textContent).toBe("Saved Evening");
    expect(JSON.parse(mixes.data.get(MIXES_KEY) ?? "[]")).toEqual([
      {
        name: "Evening",
        hash: "#name=Evening&master=70&layers=alpha,bravo&alpha.volume=40&alpha.muted=0&alpha.level=5&bravo.volume=70&bravo.muted=0&bravo.level=5",
        savedAt: Date.now(),
      },
    ]);
    const row = group("My mixes").getByRole("button", { name: /^Evening/ });
    expect(row.textContent).toContain("Alpha + Bravo");
    expect(row.getAttribute("aria-current")).toBe("true");
    closeMixes();
    expect(heading()).toBe("Evening");
  });

  it("asks before saving over a mix of the same name", () => {
    const { savedMixes } = renderMixer("#layers=alpha");
    openMixes();
    saveAs("Evening");
    closeMixes();
    fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
    fireEvent.keyDown(window, { key: "/" });
    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));
    openMixes();
    saveAs("evening");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(savedMixes.get()).toHaveLength(1);
    expect(savedMixes.get()[0]?.hash).toContain("layers=bravo");
  });

  it("marks a saved mix (edited) once changed, and offers Undo when replacing the changes", () => {
    renderMixer("#layers=alpha");
    openMixes();
    saveAs("Evening");
    closeMixes();
    fireEvent.input(screen.getByLabelText("Volume"), { target: { value: "30" } });
    expect(heading()).toBe("Evening (edited)");
    openMixes();
    applyPreset(/^Duo/);
    expect(toast().textContent).toContain("Replaced your mix");
  });

  it("deletes a saved mix with Undo", () => {
    const { savedMixes } = renderMixer("#layers=alpha");
    openMixes();
    saveAs("Evening");
    fireEvent.click(screen.getByRole("button", { name: "Delete Evening" }));
    expect(savedMixes.get()).toEqual([]);
    expect(toast().textContent).toContain("Deleted Evening");
    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    expect(savedMixes.get().map((m) => m.name)).toEqual(["Evening"]);
  });

  it("renames a saved mix, and the mix playing with it", () => {
    const { savedMixes } = renderMixer("#layers=alpha");
    openMixes();
    saveAs("Evening");
    fireEvent.click(screen.getByRole("button", { name: "Rename Evening" }));
    const field = screen.getByRole("textbox", { name: "New name for Evening" });
    fireEvent.input(field, { target: { value: "Night" } });
    fireEvent.submit(field);
    expect(savedMixes.get()[0]?.name).toBe("Night");
    expect(savedMixes.get()[0]?.hash).toMatch(/^#name=Night&/);
    closeMixes();
    expect(heading()).toBe("Night");
  });

  it("applies a saved mix", () => {
    const { savedMixes } = renderMixer("#layers=alpha");
    savedMixes.save("Later", "#name=Later&layers=charlie,delta");
    openMixes();
    fireEvent.click(group("My mixes").getByRole("button", { name: /^Later/ }));
    expect(writtenHash()).toBe("#name=Later&layers=charlie,delta");
  });

  it("says so when the browser won't store the mix", () => {
    const fail = () => {
      throw new Error("QuotaExceededError");
    };
    const savedMixes = createSavedMixes(() => ({ getItem: () => null, setItem: fail }));
    renderApp("#layers=alpha", fakeEngine(), catalogue, savedMixes);
    openMixes();
    saveAs("Evening");
    expect(toast().textContent).toBe(STORAGE_FAILED);
    expect(group("My mixes").getByRole("button", { name: /^Evening/ })).toBeTruthy();
  });

  it("shows (edited) on opening a saved name whose mix differs", () => {
    const mixes = memoryMixes();
    mixes.savedMixes.save("Evening", "#name=Evening&layers=alpha");
    renderApp(
      "#name=Evening&layers=alpha&alpha.volume=20",
      fakeEngine(),
      catalogue,
      mixes.savedMixes,
    );
    expect(heading()).toBe("Evening (edited)");
  });

  it("follows mixes saved in another tab", () => {
    const mixes = memoryMixes();
    renderApp("#layers=alpha", fakeEngine(), catalogue, mixes.savedMixes);
    openMixes();
    act(() => {
      mixes.data.set(
        MIXES_KEY,
        JSON.stringify([{ name: "Elsewhere", hash: "#layers=bravo", savedAt: 1 }]),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: MIXES_KEY }));
    });
    expect(group("My mixes").getByRole("button", { name: /^Elsewhere/ })).toBeTruthy();
  });
});

describe("App mixes file", () => {
  const openMixes = () => {
    fireEvent.keyDown(window, { key: "p", code: "KeyP" });
  };
  const importText = async (text: string) => {
    const input = screen.getByLabelText<HTMLInputElement>("Import mixes file");
    const file = new File([text], "aural-farm-mixes.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const fileOf = (mixes: unknown[]) => JSON.stringify({ app: "aural-farm", version: 1, mixes });
  const toast = () => screen.getByRole("status").textContent;

  it("exports the saved mixes as aural-farm-mixes.json", async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn<(blob: Blob) => string>((blob) => {
      blobs.push(blob);
      return "blob:mixes";
    });
    const revokeObjectURL = vi.fn<(url: string) => void>();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { savedMixes } = renderMixer("#layers=alpha");
    savedMixes.save("Evening", "#name=Evening&layers=alpha");
    openMixes();
    fireEvent.click(screen.getByRole("button", { name: "Export my mixes" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toMatchObject({ download: "aural-farm-mixes.json" });
    const text = await blobs.at(0)?.text();
    expect(JSON.parse(text ?? "")).toEqual({
      app: "aural-farm",
      version: 1,
      mixes: savedMixes.get(),
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mixes");
  });

  it("imports new mixes", async () => {
    const { savedMixes } = renderMixer("#layers=alpha");
    openMixes();
    await importText(
      fileOf([
        { name: "One", hash: "#layers=alpha", savedAt: 1 },
        { name: "Two", hash: "#layers=bravo", savedAt: 2 },
      ]),
    );
    expect(toast()).toBe("Imported 2 mixes");
    expect(savedMixes.get().map((m) => m.name)).toEqual(["Two", "One"]);
  });

  it.each([
    [
      "Replace",
      "#name=evening&master=70&layers=bravo&bravo.volume=70&bravo.muted=0&bravo.level=5",
      "Imported 2 mixes",
    ],
    ["Keep mine", "#layers=alpha", "Imported 1 mix"],
  ])("asks before replacing a saved mix: %s", async (answer, hash, message) => {
    const { savedMixes } = renderMixer("#layers=alpha");
    savedMixes.save("Evening", "#layers=alpha");
    openMixes();
    await importText(
      fileOf([
        { name: "evening", hash: "#layers=bravo", savedAt: 1 },
        { name: "New", hash: "#layers=bravo", savedAt: 2 },
      ]),
    );
    expect(savedMixes.get()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: answer }));
    expect(toast()).toBe(message);
    expect(savedMixes.byName("Evening")?.hash).toBe(hash);
    expect(savedMixes.get()).toHaveLength(2);
  });

  it("cancels an import that would replace a mix", async () => {
    const { savedMixes } = renderMixer("#layers=alpha");
    savedMixes.save("Evening", "#layers=alpha");
    openMixes();
    await importText(fileOf([{ name: "Evening", hash: "#layers=bravo", savedAt: 1 }]));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(savedMixes.get()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
  });

  it.each([
    ["not JSON", "nope", "That file isn't a mixes file."],
    [
      "a bad hash",
      fileOf([{ name: "A", hash: "#layers=nope", savedAt: 1 }]),
      "no sounds this app knows",
    ],
  ])("refuses %s, saying why", async (_case, text, message) => {
    const { savedMixes } = renderMixer("#layers=alpha");
    openMixes();
    await importText(text);
    expect(toast()).toContain(message);
    expect(savedMixes.get()).toEqual([]);
  });

  it("refuses a huge file without reading it", async () => {
    renderMixer("#layers=alpha");
    openMixes();
    const input = screen.getByLabelText<HTMLInputElement>("Import mixes file");
    const file = new File(["x"], "big.json");
    Object.defineProperty(file, "size", { value: 10_000_000 });
    const text = vi.spyOn(file, "text");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(text).not.toHaveBeenCalled();
    expect(toast()).toContain("too large");
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

  it("shows a named mix's name in the session", async () => {
    const { session } = renderWithSession("#name=Night&layers=test-tone,alpha");
    await settle();
    expect(session.metadata?.title).toBe("Night");
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

  it("cancels the sleep timer when stopped from the session", async () => {
    const { handlers, engine } = renderWithSession("#layers=test-tone");
    await settle();
    fireEvent.keyDown(window, { key: "t" });
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(15 * 60, 300);
    act(() => {
      handlers.get("stop")?.({ action: "stop" });
    });
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole("button", { name: "Sleep timer" }).dataset.running).toBe("false");
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
    expect(keys).toEqual([
      "Space",
      "/",
      "P",
      "S",
      "1–8",
      "Shift+1–8",
      "M",
      "↑ ↓",
      "H",
      "F",
      "D",
      "T",
      "?",
    ]);
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

describe("App sleep timer", () => {
  function renderTimer(preferences = createPreferences(() => undefined)) {
    const fake = fakeEngine();
    window.history.replaceState(null, "", "/#layers=alpha");
    render(
      <App
        initial={parseHash(window.location.hash, catalogue, TEST_TONE_ID)}
        loader={loader}
        preferences={preferences}
        favourites={createFavourites(() => undefined)}
        createEngine={fake.factory}
        sounds={catalogue}
        defaultSoundId={TEST_TONE_ID}
      />,
    );
    return { ...fake, preferences };
  }
  const clock = () => screen.getByRole("button", { name: /^Sleep timer/ });
  const toast = () => screen.getByRole("status").textContent;

  beforeEach(() => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  });

  it("cycles Off → 15 → 30 → 60 → 90 min → Off with T, saying so", async () => {
    const { engine } = renderTimer();
    await settle();
    const steps: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(window, { key: i === 2 ? "T" : "t" });
      steps.push(toast());
    }
    expect(steps).toEqual([
      "Sleep timer: 15 min",
      "Sleep timer: 30 min",
      "Sleep timer: 1 h",
      "Sleep timer: 1 h 30",
      "Sleep timer: Off",
    ]);
    expect(engine.setSleepTimer.mock.calls).toEqual([
      [15 * 60, 300],
      [30 * 60, 300],
      [60 * 60, 300],
      [90 * 60, 300],
      [undefined],
    ]);
  });

  it("shows the time left from the engine, each minute and then each second", async () => {
    const { engine } = renderTimer();
    await settle();
    let left = 61 * 60 + 30;
    engine.sleepRemaining.mockImplementation(() => left);
    fireEvent.keyDown(window, { key: "t" });
    expect(clock().getAttribute("aria-label")).toBe("Sleep timer, 1:02:00 left");
    const advance = async (seconds: number) => {
      left -= seconds;
      await act(async () => {
        // A little over, as an update lands just after the text would change.
        await vi.advanceTimersByTimeAsync(seconds * 1000 + 50);
      });
    };
    await advance(29);
    expect(clock().textContent).toBe("1:02:00");
    await advance(1);
    expect(clock().textContent).toBe("1:01:00");
    left = 120;
    await advance(60);
    expect(clock().textContent).toBe("1:00");
    await advance(1);
    expect(clock().textContent).toBe("0:59");
  });

  it("resets to Off when the engine says the timer ran out", async () => {
    const { callbacks } = renderTimer();
    await settle();
    fireEvent.keyDown(window, { key: "t" });
    expect(clock().dataset.running).toBe("true");
    act(() => {
      callbacks()?.onSleepEnd?.();
    });
    expect(clock().dataset.running).toBe("false");
    fireEvent.keyDown(window, { key: "t" });
    expect(toast()).toBe("Sleep timer: 15 min");
  });

  it("starts a timer from the menu with the fade-out chosen, and remembers both", async () => {
    const { engine, preferences } = renderTimer();
    await settle();
    fireEvent.click(clock());
    const menu = screen.getByRole("dialog", { name: "Sleep timer" });
    const fadeOut = within(menu).getByRole("group", { name: "Fade out over" });
    fireEvent.click(within(fadeOut).getByRole("button", { name: "1 min" }));
    const lengths = within(menu).getByRole("group", { name: "Sleep timer" });
    fireEvent.click(within(lengths).getByRole("button", { name: "45 min" }));
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(45 * 60, 60);
    expect(preferences.get("sleep.lastMinutes")).toBe("45");
    expect(preferences.get("sleep.fadeOut")).toBe("60");
    // The timer isn't part of the link.
    expect(writtenHash()).toBe("#layers=alpha");
  });

  it("gives a running timer a new fade-out without moving its end", async () => {
    const { engine } = renderTimer();
    await settle();
    fireEvent.keyDown(window, { key: "t" });
    engine.sleepRemaining.mockReturnValue(600);
    fireEvent.click(clock());
    const fadeOut = screen.getByRole("group", { name: "Fade out over" });
    fireEvent.click(within(fadeOut).getByRole("button", { name: "15 min" }));
    expect(engine.setSleepTimer).toHaveBeenLastCalledWith(600, 900);
  });

  it("starts Off on every visit, offering the last length first", async () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("sleep.lastMinutes", "90");
    const { engine } = renderTimer(preferences);
    await settle();
    expect(clock().dataset.running).toBe("false");
    expect(engine.setSleepTimer).not.toHaveBeenCalled();
    fireEvent.click(clock());
    expect(document.activeElement?.textContent).toBe("1 h 30");
  });

  it("sets the Play fade-in from the preference, and when it changes", async () => {
    const preferences = createPreferences(() => undefined);
    preferences.set("fadeIn", "10");
    const { engine } = renderTimer(preferences);
    await settle();
    expect(engine.setPlayFadeIn).toHaveBeenCalledWith(10);
    expect(engine.setPlayFadeIn.mock.invocationCallOrder[0]).toBeLessThan(
      engine.play.mock.invocationCallOrder[0] ?? 0,
    );
    fireEvent.click(clock());
    const fadeIn = screen.getByRole("group", { name: "Fade in on Play" });
    fireEvent.click(within(fadeIn).getByRole("button", { name: "Instant" }));
    expect(engine.setPlayFadeIn).toHaveBeenLastCalledWith(0.1);
    expect(preferences.get("fadeIn")).toBe("0.1");
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

describe("App updates", () => {
  /** A stand-in for the service worker's updates, made ready by `set(true)`. */
  function fakeUpdates() {
    const store = createStore(false);
    const updates = {
      subscribe: store.subscribe,
      ready: store.get,
      apply: vi.fn<AppUpdates["apply"]>(),
      check: vi.fn<AppUpdates["check"]>(),
    } satisfies AppUpdates;
    return { updates, store };
  }

  function renderWithUpdates(updates: AppUpdates, fake = fakeEngine()) {
    window.history.replaceState(null, "", "/");
    render(
      <App
        initial={parseHash("", catalogue, TEST_TONE_ID)}
        loader={loader}
        preferences={createPreferences(() => undefined)}
        favourites={createFavourites(() => undefined)}
        createEngine={fake.factory}
        sounds={catalogue}
        defaultSoundId={TEST_TONE_ID}
        updates={updates}
      />,
    );
    return fake;
  }

  const updateToast = () =>
    screen.queryAllByRole("status").find((el) => el.textContent.includes("new version"));

  it("shows nothing until a new version is ready", async () => {
    const { updates } = fakeUpdates();
    renderWithUpdates(updates);
    await settle();
    expect(updateToast()).toBeUndefined();
  });

  it("keeps the toast up, saying Reload stops the sound while it plays", async () => {
    const { updates, store } = fakeUpdates();
    renderWithUpdates(updates);
    await settle();
    act(() => {
      store.set(true);
    });
    expect(updateToast()?.textContent).toBe(
      "A new version is ready. Reloading keeps your mix but stops the sound.Reload",
    );
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(updateToast()).toBeDefined();
  });

  it("leaves out the warning while paused", async () => {
    const { updates, store } = fakeUpdates();
    renderWithUpdates(updates);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => {
      store.set(true);
    });
    expect(updateToast()?.textContent).toBe("A new version is ready.Reload");
  });

  it("reloads only when Reload is pressed", async () => {
    const { updates, store } = fakeUpdates();
    renderWithUpdates(updates);
    await settle();
    act(() => {
      store.set(true);
    });
    expect(updates.apply).not.toHaveBeenCalled();
    const toast = updateToast();
    if (!toast) {
      throw new Error("No update toast");
    }
    fireEvent.click(within(toast).getByRole("button", { name: "Reload" }));
    expect(updates.apply).toHaveBeenCalledOnce();
  });

  it("shows another toast alongside it", async () => {
    const { updates, store } = fakeUpdates();
    renderWithUpdates(updates);
    await settle();
    act(() => {
      store.set(true);
    });
    fireEvent.keyDown(window, { key: "d" });
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  it("looks for a new version when the page is shown again", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const { updates } = fakeUpdates();
    renderWithUpdates(updates);
    await settle();
    updates.check.mockClear();
    hidden.mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(updates.check).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(updates.check).toHaveBeenCalledOnce();
  });
});

describe("App install", () => {
  function renderWithInstall(standalone: boolean) {
    vi.mocked(window.matchMedia).mockImplementation(
      (query) =>
        ({
          matches:
            query === "(hover: hover)" || (standalone && query === "(display-mode: standalone)"),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const target = new EventTarget();
    const install = createInstallPrompt(target);
    const preferences = createPreferences(() => undefined);
    preferences.set("displayOpen", "1");
    window.history.replaceState(null, "", "/");
    render(
      <App
        initial={parseHash("", catalogue, TEST_TONE_ID)}
        loader={loader}
        preferences={preferences}
        favourites={createFavourites(() => undefined)}
        createEngine={fakeEngine().factory}
        sounds={catalogue}
        defaultSoundId={TEST_TONE_ID}
        install={install}
      />,
    );
    const prompt = vi.fn<() => Promise<unknown>>(() => Promise.resolve(undefined));
    const offer = () => {
      act(() => {
        target.dispatchEvent(
          Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt }),
        );
      });
    };
    return { offer, prompt };
  }

  const installButton = () => screen.queryByRole("button", { name: "Install app" });

  it("offers Install app once the browser does, and shows its dialog", async () => {
    const { offer, prompt } = renderWithInstall(false);
    await settle();
    expect(installButton()).toBeNull();
    offer();
    const button = installButton();
    if (!button) {
      throw new Error("No Install app button");
    }
    fireEvent.click(button);
    expect(prompt).toHaveBeenCalledOnce();
    expect(installButton()).toBeNull();
  });

  it("never offers it in the installed app", async () => {
    const { offer } = renderWithInstall(true);
    await settle();
    offer();
    expect(installButton()).toBeNull();
  });
});
