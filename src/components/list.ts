/**
 * What the sound picker shows: the sounds that match the search and the chosen
 * categories, in the chosen order, split into groups. Pure functions of the
 * sounds' metadata, so the picker's component only renders the result.
 */
import { SOUND_CATEGORIES, type SoundMeta } from "../sounds/types";

/** The picker's sort orders, as stored in the preferences. */
export const SORT_ORDERS = [
  { value: "featured", label: "Featured" },
  { value: "az", label: "A–Z" },
  { value: "category", label: "By category" },
  { value: "cost", label: "Lightest first" },
] as const;

export type SortOrder = (typeof SORT_ORDERS)[number]["value"];

export function isSortOrder(value: unknown): value is SortOrder {
  return SORT_ORDERS.some((o) => o.value === value);
}

type Category = SoundMeta["categories"][number];

/** The sound fields the list reads. */
type Listed = Pick<SoundMeta, "id" | "name" | "description" | "tags" | "categories" | "cost">;

interface ListOptions {
  sort: SortOrder;
  /** The search text, as typed. */
  query: string;
  /** The selected category chips. A sound matches if it's in any of them; none selected matches all. */
  categories: ReadonlySet<string>;
}

interface ListGroup<S extends Listed> {
  /** "Favourites", "More sounds", or a category in the By category sort. */
  title: string;
  sounds: S[];
}

const COST_ORDER: Readonly<Record<Listed["cost"], number>> = {
  "very low": 0,
  low: 1,
  medium: 2,
};

/** Lower case without accents, so "Cafe" finds "Café" and "café" finds "Cafe". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function queryWords(query: string): string[] {
  return foldText(query)
    .split(/\s+/)
    .filter((w) => w !== "");
}

/** The categories that hold at least one sound, in the fixed category order. */
export function usedCategories(sounds: readonly Listed[]): Category[] {
  return SOUND_CATEGORIES.filter((c) => sounds.some((s) => s.categories.includes(c)));
}

function primary(sound: Listed): Category {
  return sound.categories[0];
}

/**
 * The sounds to show, in order: those in any selected category whose name,
 * description, tags or categories contain every search word. Sounds whose name
 * matches more of the words come first; otherwise the sort decides, and ties
 * keep the Featured (registry) order. By category orders by primary category.
 */
export function visibleSounds<S extends Listed>(
  sounds: readonly S[],
  { sort, query, categories }: ListOptions,
): S[] {
  const words = queryWords(query);
  const featured = new Map(sounds.map((s, i) => [s.id, i]));
  const categoryIndex = (s: S) => SOUND_CATEGORIES.indexOf(primary(s));
  const nameHits = new Map<string, number>();
  const matches = sounds.filter((sound) => {
    if (categories.size > 0 && !sound.categories.some((c) => categories.has(c))) {
      return false;
    }
    const name = foldText(sound.name);
    const rest = foldText([sound.description, ...sound.tags, ...sound.categories].join(" "));
    let hits = 0;
    for (const word of words) {
      if (name.includes(word)) {
        hits++;
      } else if (!rest.includes(word)) {
        return false;
      }
    }
    nameHits.set(sound.id, hits);
    return true;
  });
  const orders: Readonly<Record<SortOrder, (a: S, b: S) => number>> = {
    // Featured is the registry's order, the final tie-break below.
    featured: () => 0,
    az: (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    category: (a, b) => categoryIndex(a) - categoryIndex(b),
    cost: (a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost],
  };
  const order = orders[sort];
  return matches.toSorted(
    (a, b) =>
      (nameHits.get(b.id) ?? 0) - (nameHits.get(a.id) ?? 0) ||
      order(a, b) ||
      (featured.get(a.id) ?? 0) - (featured.get(b.id) ?? 0),
  );
}

/**
 * Splits visible sounds into groups, keeping their order within each: starred
 * sounds first under "Favourites", then the rest under "More sounds", or under
 * their primary category in the By category sort. Empty groups are left out.
 */
export function groupSounds<S extends Listed>(
  visible: readonly S[],
  sort: SortOrder,
  favourites: ReadonlySet<string>,
): ListGroup<S>[] {
  const starred = visible.filter((s) => favourites.has(s.id));
  const rest = visible.filter((s) => !favourites.has(s.id));
  const groups: ListGroup<S>[] = [{ title: "Favourites", sounds: starred }];
  if (sort === "category") {
    for (const category of SOUND_CATEGORIES) {
      groups.push({ title: category, sounds: rest.filter((s) => primary(s) === category) });
    }
  } else {
    groups.push({ title: "More sounds", sounds: rest });
  }
  return groups.filter((g) => g.sounds.length > 0);
}

/** "1 sound", "23 sounds". */
export function soundCount(count: number): string {
  return `${String(count)} ${count === 1 ? "sound" : "sounds"}`;
}
