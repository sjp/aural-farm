// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { createPreferences, type Preferences } from "../lib/preferences";
import type { SoundEntry } from "../sounds/registry";
import { defineSoundMeta, type SoundMeta } from "../sounds/types";
import { act } from "../test/act";
import { PREFETCH_ROWS, SORT_KEY, SoundList } from "./SoundList";

const notLoadable = () => Promise.reject(new Error("Not loadable in tests"));

function sound(
  id: string,
  name: string,
  categories: SoundMeta["categories"],
  cost: SoundMeta["cost"],
  description = `${name} for tests.`,
): SoundEntry {
  return {
    ...defineSoundMeta({
      id,
      name,
      description,
      categories,
      tags: [],
      cost,
      tint: "#808080",
      params: {},
    }),
    load: notLoadable,
  };
}

/** A small catalogue in Featured order. */
const SOUNDS: SoundEntry[] = [
  sound("engine", "Engine", ["Sci-fi", "Machines"], "medium", "A deep hum."),
  sound("rain", "Rain", ["Nature", "Sleep"], "low", "Rain on a roof."),
  sound("cafe", "Café", ["Places", "Focus"], "medium", "Cups, chatter and rain outside."),
  sound("fan", "Fan", ["Machines", "Sleep"], "very low"),
  sound("brown", "Brown Noise", ["Noise", "Sleep"], "low"),
  sound("wind", "Wind", ["Nature"], "very low"),
  ...Array.from({ length: 10 }, (_, i) =>
    sound(`tone-${String(i)}`, `Tone ${String(i)}`, ["Tonal"], "low"),
  ),
];

interface Options {
  inMix?: string[];
  full?: boolean;
  favourites?: string[];
  preferences?: Preferences;
  hover?: boolean;
}

function renderList(options: Options = {}) {
  const handlers = {
    onAdd: vi.fn<(id: string, keepOpen: boolean) => void>(),
    onFocusLayer: vi.fn<(id: string) => void>(),
    onClose: vi.fn<() => void>(),
    onToggleFavourite: vi.fn<(id: string) => void>(),
    onPrefetch: vi.fn<(sound: SoundEntry) => void>(),
  };
  const preferences = options.preferences ?? createPreferences(() => undefined);
  const list = (o: Options) => (
    <div className="panel">
      <SoundList
        sounds={SOUNDS}
        inMix={new Set(o.inMix)}
        full={o.full ?? false}
        favourites={new Set(o.favourites)}
        preferences={preferences}
        hover={o.hover ?? true}
        {...handlers}
      />
    </div>
  );
  const view = render(list(options));
  const update = (change: Options) => {
    view.rerender(list({ ...options, ...change }));
  };
  return { ...handlers, preferences, update, unmount: view.unmount };
}

const search = () => screen.getByRole<HTMLInputElement>("combobox", { name: "Search sounds" });
const listbox = () => screen.getByRole("listbox", { name: "Sounds" });
const options = () => within(listbox()).queryAllByRole("option");
const optionNames = () => options().map((o) => o.querySelector(".picker-name")?.textContent);
const activeName = () => {
  const id = search().getAttribute("aria-activedescendant");
  return id === null
    ? undefined
    : document.getElementById(id)?.querySelector(".picker-name")?.textContent;
};
const key = (k: string, init: Partial<KeyboardEventInit> = {}) => {
  fireEvent.keyDown(search(), { key: k, ...init });
};
const type = (text: string) => {
  fireEvent.input(search(), { target: { value: text } });
};
const chip = (name: string) => within(screen.getByRole("toolbar")).getByRole("button", { name });

describe("SoundList", () => {
  it("is a combobox over the list, focused on opening, with the first row active", () => {
    renderList();
    const input = search();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-controls")).toBe(listbox().id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(activeName()).toBe("Engine");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe(`${String(SOUNDS.length)} sounds`);
  });

  it("moves through the list with the arrows, Page keys, Home and End", () => {
    const { onPrefetch } = renderList();
    key("ArrowDown");
    expect(activeName()).toBe("Rain");
    // Focusing a row by keyboard loads its code.
    expect(onPrefetch).toHaveBeenLastCalledWith(SOUNDS[1]);
    key("ArrowUp");
    key("ArrowUp");
    expect(activeName()).toBe("Engine");
    key("PageDown");
    expect(activeName()).toBe("Tone 2");
    key("End");
    expect(activeName()).toBe("Tone 9");
    key("ArrowDown");
    expect(activeName()).toBe("Tone 9");
    key("PageUp");
    expect(activeName()).toBe("Tone 1");
    key("Home");
    expect(activeName()).toBe("Engine");
  });

  it("adds the active row with Enter, and keeps the picker open with Shift+Enter", () => {
    const { onAdd } = renderList();
    key("ArrowDown");
    key("Enter");
    expect(onAdd).toHaveBeenLastCalledWith("rain", false);
    key("Enter", { shiftKey: true });
    expect(onAdd).toHaveBeenLastCalledWith("rain", true);
  });

  it("adds a clicked row, or keeps the picker open with Shift", () => {
    const { onAdd } = renderList();
    fireEvent.click(screen.getByRole("option", { name: "Wind" }));
    expect(onAdd).toHaveBeenLastCalledWith("wind", false);
    fireEvent.click(screen.getByRole("option", { name: "Fan" }), { shiftKey: true });
    expect(onAdd).toHaveBeenLastCalledWith("fan", true);
  });

  it("marks sounds in the mix, and focuses them in the mixer instead of adding", () => {
    const { onAdd, onFocusLayer } = renderList({ inMix: ["rain"] });
    const rain = screen.getByRole("option", { name: "Rain" });
    expect(rain.textContent).toContain("In mix ✓");
    expect(screen.getByRole("option", { name: "Engine" }).textContent).not.toContain("In mix");
    fireEvent.click(rain);
    key("Enter", { shiftKey: true });
    expect(onFocusLayer).toHaveBeenCalledTimes(2);
    expect(onFocusLayer).toHaveBeenLastCalledWith("rain");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables the sounds not in a full mix, and says why", () => {
    const { onAdd, onFocusLayer } = renderList({ inMix: ["rain"], full: true });
    expect(screen.getByRole("note").textContent).toBe(
      "8 sounds is the most a mix can hold. Remove one to add another.",
    );
    const engine = screen.getByRole("option", { name: "Engine" });
    expect(engine.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("option", { name: "Rain" }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(engine);
    key("Enter");
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Rain" }));
    expect(onFocusLayer).toHaveBeenCalledWith("rain");
  });

  it("has no banner while the mix has room", () => {
    renderList();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("searches, counts what matches, and makes the first match active", () => {
    renderList();
    key("ArrowDown");
    type("RAIN");
    // The name match first, then the description match.
    expect(optionNames()).toEqual(["Rain", "Café"]);
    expect(screen.getByRole("status").textContent).toBe("2 sounds");
    expect(activeName()).toBe("Rain");
    type("cafe cups");
    expect(optionNames()).toEqual(["Café"]);
    expect(screen.getByRole("status").textContent).toBe("1 sound");
    type("nothing like this");
    expect(options()).toEqual([]);
    expect(screen.getByText("No sounds match")).toBeTruthy();
    key("Enter");
  });

  it("clears the search, then the chips, then closes on Escape", () => {
    const { onClose } = renderList();
    type("rain");
    fireEvent.click(chip("Sleep"));
    expect(optionNames()).toEqual(["Rain"]);
    key("Escape");
    expect(search().value).toBe("");
    expect(optionNames()).toEqual(["Rain", "Fan", "Brown Noise"]);
    expect(onClose).not.toHaveBeenCalled();
    // From a chip, too.
    fireEvent.keyDown(chip("Sleep"), { key: "Escape" });
    expect(optionNames()).toHaveLength(SOUNDS.length);
    expect(chip("Sleep").getAttribute("aria-pressed")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with the close button", () => {
    const { onClose } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Close sound list" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("stars the active row with *, and with its star button", () => {
    const { onToggleFavourite, update } = renderList();
    key("ArrowDown");
    key("*");
    expect(onToggleFavourite).toHaveBeenLastCalledWith("rain");
    expect(search().value).toBe("");
    const star = screen.getByRole("button", { name: "Star Wind" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(star);
    expect(onToggleFavourite).toHaveBeenLastCalledWith("wind");
    update({ favourites: ["wind"] });
    expect(screen.getByRole("button", { name: "Star Wind" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("lists favourites first, and hints at starring when there are none", () => {
    const { update } = renderList({ favourites: ["gone-sound"] });
    expect(screen.getByText("Star sounds to keep them at the top")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Favourites" })).toBeNull();
    update({ favourites: ["wind", "rain"] });
    expect(screen.queryByText("Star sounds to keep them at the top")).toBeNull();
    const names = (group: string) =>
      within(screen.getByRole("group", { name: group }))
        .getAllByRole("option")
        .map((o) => o.querySelector(".picker-name")?.textContent);
    expect(names("Favourites")).toEqual(["Rain", "Wind"]);
    expect(names("More sounds")[0]).toBe("Engine");
    expect(activeName()).toBe("Rain");
  });

  describe("sort", () => {
    it("remembers the chosen sort", () => {
      const { preferences } = renderList();
      const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort" });
      expect(select.value).toBe("featured");
      fireEvent.change(select, { target: { value: "az" } });
      expect(preferences.get(SORT_KEY)).toBe("az");
      expect(optionNames().slice(0, 4)).toEqual(["Brown Noise", "Café", "Engine", "Fan"]);
    });

    it("starts from the remembered sort, ignoring an unknown one", () => {
      const preferences = createPreferences(() => undefined);
      preferences.set(SORT_KEY, "random");
      renderList({ preferences });
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort" }).value).toBe(
        "featured",
      );
    });

    it("groups by primary category", () => {
      const preferences = createPreferences(() => undefined);
      preferences.set(SORT_KEY, "category");
      renderList({ preferences });
      const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-labelledby"));
      const titles = groups.map((id) =>
        id === null ? "" : document.getElementById(id)?.textContent,
      );
      expect(titles).toEqual(["Noise", "Sci-fi", "Nature", "Machines", "Places", "Tonal"]);
    });

    it("shows a cost badge only when lightest first", () => {
      const preferences = createPreferences(() => undefined);
      preferences.set(SORT_KEY, "cost");
      renderList({ preferences });
      expect(optionNames().slice(0, 2)).toEqual(["Fan", "Wind"]);
      expect(screen.getByRole("option", { name: "Fan" }).textContent).toContain("Very light");
      fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
        target: { value: "featured" },
      });
      expect(document.querySelector(".picker-cost")).toBeNull();
    });
  });

  describe("category chips", () => {
    it("shows only categories that have a sound, in order", () => {
      renderList();
      const names = within(screen.getByRole("toolbar", { name: "Categories" }))
        .getAllByRole("button")
        .map((b) => b.textContent);
      expect(names).toEqual([
        "Noise",
        "Sci-fi",
        "Nature",
        "Machines",
        "Places",
        "Tonal",
        "Sleep",
        "Focus",
      ]);
    });

    it("keeps sounds in any selected category", () => {
      renderList();
      fireEvent.click(chip("Noise"));
      expect(chip("Noise").getAttribute("aria-pressed")).toBe("true");
      expect(optionNames()).toEqual(["Brown Noise"]);
      fireEvent.click(chip("Places"));
      expect(optionNames()).toEqual(["Café", "Brown Noise"]);
      fireEvent.click(chip("Noise"));
      expect(optionNames()).toEqual(["Café"]);
    });

    it("is one tab stop, moved by the arrow keys, Home and End", () => {
      renderList();
      const tabStops = () =>
        within(screen.getByRole("toolbar"))
          .getAllByRole("button")
          .filter((b) => b.tabIndex === 0)
          .map((b) => b.textContent);
      expect(tabStops()).toEqual(["Noise"]);
      chip("Noise").focus();
      fireEvent.keyDown(chip("Noise"), { key: "ArrowRight" });
      expect(document.activeElement).toBe(chip("Sci-fi"));
      expect(tabStops()).toEqual(["Sci-fi"]);
      fireEvent.keyDown(chip("Sci-fi"), { key: "End" });
      expect(document.activeElement).toBe(chip("Focus"));
      fireEvent.keyDown(chip("Focus"), { key: "ArrowRight" });
      expect(document.activeElement).toBe(chip("Focus"));
      fireEvent.keyDown(chip("Focus"), { key: "Home" });
      expect(document.activeElement).toBe(chip("Noise"));
      fireEvent.keyDown(chip("Noise"), { key: "ArrowLeft" });
      expect(tabStops()).toEqual(["Noise"]);
    });

    it("has scroll buttons only on hover devices, kept out of the tab order", () => {
      const { update } = renderList({ hover: true });
      const back = screen.getByLabelText("Scroll categories back");
      expect(back.tabIndex).toBe(-1);
      update({ hover: false });
      expect(screen.queryByLabelText("Scroll categories back")).toBeNull();
    });
  });

  describe("prefetching", () => {
    it("loads the first rows' code once the browser is idle", () => {
      const { onPrefetch } = renderList();
      expect(onPrefetch).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(onPrefetch.mock.calls.map(([s]) => s.id)).toEqual(
        SOUNDS.slice(0, PREFETCH_ROWS).map((s) => s.id),
      );
    });

    it("loads a row's code when the pointer moves over it", () => {
      const { onPrefetch } = renderList();
      fireEvent.pointerEnter(screen.getByRole("option", { name: "Wind" }));
      expect(onPrefetch).toHaveBeenCalledWith(SOUNDS[5]);
    });

    it("doesn't prefetch once closed before the browser was idle", () => {
      const { onPrefetch, unmount } = renderList();
      unmount();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(onPrefetch).not.toHaveBeenCalled();
    });
  });
});
