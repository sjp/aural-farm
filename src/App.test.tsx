// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App, HASH_DEBOUNCE_MS, IDLE_MS, TOAST_MS } from "./App";
import { createPreferences } from "./lib/preferences";
import { parseHash } from "./mixes/mix";
import { createSoundLoader } from "./sounds/loader";
import { sounds } from "./sounds/registry";
import { act } from "./test/act";

/** Shared, with every sound already loaded, so no layer shows "Loading…". */
const loader = createSoundLoader();

beforeAll(async () => {
  await Promise.all(sounds.map((sound) => loader.load(sound)));
});

function renderApp(hash = "") {
  window.history.replaceState(null, "", `/${hash}`);
  const replaceState = vi.spyOn(window.history, "replaceState");
  render(
    <App
      initial={parseHash(window.location.hash)}
      loader={loader}
      preferences={createPreferences(() => undefined)}
    />,
  );
  return { replaceState };
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
