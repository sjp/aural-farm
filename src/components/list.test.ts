import { describe, expect, it } from "vitest";
import type { SoundMeta } from "../sounds/types";
import {
  foldText,
  groupSounds,
  isSortOrder,
  soundCount,
  SORT_ORDERS,
  usedCategories,
  visibleSounds,
  type SortOrder,
} from "./list";

type Listed = Pick<SoundMeta, "id" | "name" | "description" | "tags" | "categories" | "cost">;

/** A small catalogue in Featured order. */
const SOUNDS: Listed[] = [
  {
    id: "engine",
    name: "Starship Engine",
    description: "A deep hum in a metal room.",
    tags: ["warp", "reactor"],
    categories: ["Sci-fi", "Machines"],
    cost: "medium",
  },
  {
    id: "rain",
    name: "Rain",
    description: "Steady rain on a roof.",
    tags: ["storm", "drizzle"],
    categories: ["Nature", "Sleep", "Cosy"],
    cost: "low",
  },
  {
    id: "cafe",
    name: "Café",
    description: "Chatter and cups, with rain outside.",
    tags: ["coffee", "crowd"],
    categories: ["Places", "Focus", "Cosy"],
    cost: "medium",
  },
  {
    id: "fan",
    name: "Fan",
    description: "A box fan's whirr.",
    tags: ["air", "white"],
    categories: ["Machines", "Sleep"],
    cost: "very low",
  },
  {
    id: "brown",
    name: "Brown Noise",
    description: "Deep, soft noise.",
    tags: ["static"],
    categories: ["Noise", "Sleep"],
    cost: "low",
  },
];

const ids = (sounds: readonly Listed[]) => sounds.map((s) => s.id);
const none: ReadonlySet<string> = new Set();
const show = (sort: SortOrder, query = "", categories: ReadonlySet<string> = none) =>
  ids(visibleSounds(SOUNDS, { sort, query, categories }));

describe("visibleSounds", () => {
  it.each<[SortOrder, string[]]>([
    ["featured", ["engine", "rain", "cafe", "fan", "brown"]],
    ["az", ["brown", "cafe", "fan", "rain", "engine"]],
    ["category", ["brown", "engine", "rain", "fan", "cafe"]],
    ["cost", ["fan", "rain", "brown", "engine", "cafe"]],
  ])("sorts %s", (sort, expected) => {
    expect(show(sort)).toEqual(expected);
  });

  it.each([
    ["the name", "starship", ["engine"]],
    ["the description", "roof", ["rain"]],
    ["a tag", "warp", ["engine"]],
    ["a category", "places", ["cafe"]],
    ["part of a word", "whir", ["fan"]],
  ])("finds a word in %s", (_, query, expected) => {
    expect(show("featured", query)).toEqual(expected);
  });

  it("ignores case and accents, both ways", () => {
    expect(show("featured", "CAFE")).toEqual(["cafe"]);
    expect(show("featured", "brówn")).toEqual(["brown"]);
  });

  it("needs every word to match", () => {
    expect(show("featured", "deep noise")).toEqual(["brown"]);
    expect(show("featured", "deep nothing")).toEqual([]);
    expect(show("featured", "  ")).toHaveLength(SOUNDS.length);
  });

  it("ranks name matches first, then keeps the sort", () => {
    // "rain" is Rain's name and in Café's description.
    expect(show("featured", "rain")).toEqual(["rain", "cafe"]);
    expect(show("az", "deep")).toEqual(["brown", "engine"]);
    expect(show("az", "deep brown")).toEqual(["brown"]);
  });

  it("keeps sounds in any selected category", () => {
    expect(show("featured", "", new Set(["Sleep"]))).toEqual(["rain", "fan", "brown"]);
    expect(show("featured", "", new Set(["Noise", "Places"]))).toEqual(["cafe", "brown"]);
    expect(show("featured", "rain", new Set(["Places"]))).toEqual(["cafe"]);
  });
});

describe("groupSounds", () => {
  const groups = (sort: SortOrder, favourites: ReadonlySet<string>) =>
    groupSounds(visibleSounds(SOUNDS, { sort, query: "", categories: none }), sort, favourites).map(
      (g) => [g.title, ids(g.sounds)],
    );

  it("puts everything under More sounds with no favourites", () => {
    expect(groups("featured", none)).toEqual([
      ["More sounds", ["engine", "rain", "cafe", "fan", "brown"]],
    ]);
  });

  it("lists favourites first, in the sort's order, ignoring unknown ids", () => {
    expect(groups("az", new Set(["rain", "brown", "gone"]))).toEqual([
      ["Favourites", ["brown", "rain"]],
      ["More sounds", ["cafe", "fan", "engine"]],
    ]);
  });

  it("groups the rest under their primary category in the By category sort", () => {
    expect(groups("category", new Set(["fan"]))).toEqual([
      ["Favourites", ["fan"]],
      ["Noise", ["brown"]],
      ["Sci-fi", ["engine"]],
      ["Nature", ["rain"]],
      ["Places", ["cafe"]],
    ]);
  });

  it("leaves out More sounds when every visible sound is starred", () => {
    const visible = visibleSounds(SOUNDS, { sort: "featured", query: "fan", categories: none });
    expect(groupSounds(visible, "featured", new Set(["fan"])).map((g) => g.title)).toEqual([
      "Favourites",
    ]);
  });
});

describe("list helpers", () => {
  it("lists only the categories that hold a sound, in the fixed order", () => {
    expect(usedCategories(SOUNDS)).toEqual([
      "Noise",
      "Sci-fi",
      "Nature",
      "Machines",
      "Places",
      "Cosy",
      "Sleep",
      "Focus",
    ]);
  });

  it("counts sounds", () => {
    expect(soundCount(1)).toBe("1 sound");
    expect(soundCount(23)).toBe("23 sounds");
    expect(soundCount(0)).toBe("0 sounds");
  });

  it("folds text for search", () => {
    expect(foldText("Crème Brûlée")).toBe("creme brulee");
  });

  it("knows its sort orders", () => {
    expect(SORT_ORDERS.map((o) => o.label)).toEqual([
      "Featured",
      "A–Z",
      "By category",
      "Lightest first",
    ]);
    expect(isSortOrder("cost")).toBe(true);
    expect(isSortOrder("random")).toBe(false);
  });
});
