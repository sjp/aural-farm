import type { JSX } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Preferences } from "../lib/preferences";
import { whenIdle } from "../sounds/loader";
import type { SoundEntry } from "../sounds/registry";
import { CloseIcon, StarIcon } from "./icons";
import {
  groupSounds,
  isSortOrder,
  soundCount,
  SORT_ORDERS,
  usedCategories,
  visibleSounds,
  type SortOrder,
} from "./list";
import { FULL_MIX_HINT } from "./mixer";

/** The preference holding the picker's sort order. */
export const SORT_KEY = "soundSort";
/** How many rows PageUp and PageDown move. */
const PAGE_ROWS = 8;
/** How many of the first rows load their code while the browser is idle after opening. */
export const PREFETCH_ROWS = 4;

const COST_LABELS: Readonly<Record<SoundEntry["cost"], string>> = {
  "very low": "Very light",
  low: "Light",
  medium: "Medium",
};

interface SoundListProps {
  /** Every sound, in Featured order. */
  sounds: readonly SoundEntry[];
  /** The ids of the sounds already in the mix. */
  inMix: ReadonlySet<string>;
  /** Whether the mix holds as many sounds as it can. */
  full: boolean;
  favourites: ReadonlySet<string>;
  onToggleFavourite: (id: string) => void;
  preferences: Preferences;
  /** Whether the main pointer can hover: the chip row's scroll buttons show only then. */
  hover: boolean;
  /** Adds a sound; `keepOpen` is set for Shift+Enter, which keeps the picker open. */
  onAdd: (id: string, keepOpen: boolean) => void;
  /** Closes the picker and moves focus to a sound already in the mix. */
  onFocusLayer: (id: string) => void;
  /** Closes the picker. */
  onClose: () => void;
  /** Starts loading a sound's code. */
  onPrefetch?: ((sound: SoundEntry) => void) | undefined;
}

function readSort(preferences: Preferences): SortOrder {
  const stored = preferences.get(SORT_KEY);
  return isSortOrder(stored) ? stored : "featured";
}

/**
 * The category chips: one row that scrolls sideways, with a roving tabindex,
 * faded edges where there's more to scroll, ‹ › buttons on hover devices, and a
 * vertical wheel turned sideways.
 */
function CategoryChips({
  categories,
  selected,
  hover,
  onToggle,
}: {
  categories: readonly string[];
  selected: ReadonlySet<string>;
  hover: boolean;
  onToggle: (category: string) => void;
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return undefined;
    }
    const measure = () => {
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    measure();
    row.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  const scrollBy = (direction: number) => {
    const row = rowRef.current;
    row?.scrollBy({ left: direction * row.clientWidth * 0.7, behavior: "smooth" });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const last = categories.length - 1;
    const next =
      event.key === "ArrowRight"
        ? Math.min(last, focusIndex + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, focusIndex - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    setFocusIndex(next);
    rowRef.current?.querySelectorAll<HTMLElement>(".chip")[next]?.focus();
  };

  return (
    <div className="chips" data-fade-start={edges.start} data-fade-end={edges.end}>
      {hover && (
        <button
          type="button"
          className="chip-scroll chip-scroll-start"
          aria-label="Scroll categories back"
          tabIndex={-1}
          hidden={!edges.start}
          onClick={() => {
            scrollBy(-1);
          }}
        >
          ‹
        </button>
      )}
      <div
        ref={rowRef}
        className="chip-row"
        role="toolbar"
        aria-label="Categories"
        onKeyDown={onKeyDown}
        onWheel={(event) => {
          const row = event.currentTarget;
          if (
            Math.abs(event.deltaY) > Math.abs(event.deltaX) &&
            row.scrollWidth > row.clientWidth
          ) {
            event.preventDefault();
            row.scrollLeft += event.deltaY;
          }
        }}
      >
        {categories.map((category, i) => (
          <button
            key={category}
            type="button"
            className="chip"
            aria-pressed={selected.has(category)}
            tabIndex={i === focusIndex ? 0 : -1}
            onFocus={() => {
              setFocusIndex(i);
            }}
            onClick={() => {
              onToggle(category);
            }}
          >
            {category}
          </button>
        ))}
      </div>
      {hover && (
        <button
          type="button"
          className="chip-scroll chip-scroll-end"
          aria-label="Scroll categories on"
          tabIndex={-1}
          hidden={!edges.end}
          onClick={() => {
            scrollBy(1);
          }}
        >
          ›
        </button>
      )}
    </div>
  );
}

/**
 * The sound picker, which takes over the panel: a search field (an ARIA
 * combobox whose list uses `aria-activedescendant`), category chips, the count
 * and sort, and the sounds, favourites first. Search and chips start empty each
 * time it opens; the sort is remembered.
 */
export function SoundList({
  sounds,
  inMix,
  full,
  favourites,
  onToggleFavourite,
  preferences,
  hover,
  onAdd,
  onFocusLayer,
  onClose,
  onPrefetch,
}: SoundListProps): JSX.Element {
  const id = useId();
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<ReadonlySet<string>>(() => new Set());
  const [sort, setSort] = useState(() => readSort(preferences));
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  /** Set when the active row moved by keyboard, so it is scrolled into view. */
  const scrollPending = useRef(false);

  const visible = visibleSounds(sounds, { sort, query, categories: chips });
  const groups = groupSounds(visible, sort, favourites);
  /** The rows in the order they're shown. */
  const rows = groups.flatMap((g) => g.sounds);
  const activeIndex = Math.max(
    0,
    rows.findIndex((s) => s.id === activeId),
  );
  const active = rows.at(activeIndex);
  const optionId = (soundId: string) => `${id}-option-${soundId}`;
  const anyStarred = sounds.some((s) => favourites.has(s.id));

  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  });

  useEffect(() => {
    // Without preventScroll, iOS scrolls the page to show the field, and the page jumps.
    inputRef.current?.focus({ preventScroll: true });
    if (!onPrefetch) {
      return undefined;
    }
    return whenIdle(() => {
      for (const sound of rowsRef.current.slice(0, PREFETCH_ROWS)) {
        onPrefetch(sound);
      }
    });
    // Only on opening: the first rows as they are then.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scrollPending.current && active) {
      scrollPending.current = false;
      document.getElementById(optionId(active.id))?.scrollIntoView({ block: "nearest" });
    }
  });

  const moveTo = (index: number) => {
    const next = rows.at(Math.min(rows.length - 1, Math.max(0, index)));
    if (next) {
      scrollPending.current = true;
      setActiveId(next.id);
      onPrefetch?.(next);
    }
  };

  const select = (sound: SoundEntry, keepOpen: boolean) => {
    if (inMix.has(sound.id)) {
      onFocusLayer(sound.id);
    } else if (!full) {
      onAdd(sound.id, keepOpen);
    }
  };

  const onInputKeyDown = (event: KeyboardEvent) => {
    const moves = new Map([
      ["ArrowDown", activeIndex + 1],
      ["ArrowUp", activeIndex - 1],
      ["PageDown", activeIndex + PAGE_ROWS],
      ["PageUp", activeIndex - PAGE_ROWS],
      ["Home", 0],
      ["End", rows.length - 1],
    ]);
    const move = moves.get(event.key);
    if (move !== undefined) {
      event.preventDefault();
      moveTo(move);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) {
        select(active, event.shiftKey);
      }
    } else if (event.key === "*") {
      event.preventDefault();
      if (active) {
        onToggleFavourite(active.id);
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    // Clear the search first, then the chips, then close.
    if (query !== "") {
      setQuery("");
      setActiveId(undefined);
      inputRef.current?.focus();
    } else if (chips.size > 0) {
      setChips(new Set());
      setActiveId(undefined);
    } else {
      onClose();
    }
  };

  // Keeps focus in the search field when a row or its star is clicked.
  const keepFocus = (event: MouseEvent) => {
    event.preventDefault();
  };

  return (
    <div className="picker" onKeyDown={onKeyDown}>
      <header className="panel-header picker-header">
        <div className="panel-header-row picker-search-row">
          <input
            ref={inputRef}
            type="text"
            className="picker-search"
            role="combobox"
            aria-label="Search sounds"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active.id) : undefined}
            placeholder="Search sounds"
            autoComplete="off"
            spellcheck={false}
            enterKeyHint="go"
            value={query}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActiveId(undefined);
            }}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Close sound list"
            title={hover ? "Close sound list (Esc)" : "Close sound list"}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <CategoryChips
          categories={usedCategories(sounds)}
          selected={chips}
          hover={hover}
          onToggle={(category) => {
            const next = new Set(chips);
            if (!next.delete(category)) {
              next.add(category);
            }
            setChips(next);
            setActiveId(undefined);
          }}
        />
        <div className="picker-count-row">
          <span className="picker-count" role="status">
            {soundCount(visible.length)}
          </span>
          <select
            aria-label="Sort"
            value={sort}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (isSortOrder(next)) {
                setSort(next);
                setActiveId(undefined);
                preferences.set(SORT_KEY, next);
              }
            }}
          >
            {SORT_ORDERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="picker-body">
        {full && (
          <p className="picker-banner" role="note">
            {FULL_MIX_HINT}. Remove one to add another.
          </p>
        )}
        {!anyStarred && <p className="hint picker-hint">Star sounds to keep them at the top</p>}
        <div id={listId} className="picker-list" role="listbox" aria-label="Sounds">
          {groups.map((group, groupIndex) => {
            const titleId = `${id}-group-${String(groupIndex)}`;
            return (
              <div
                key={group.title}
                className="picker-group"
                role="group"
                aria-labelledby={titleId}
              >
                <div id={titleId} className="picker-group-title" role="presentation">
                  {group.title}
                </div>
                {group.sounds.map((sound) => {
                  const added = inMix.has(sound.id);
                  const starred = favourites.has(sound.id);
                  const nameId = `${optionId(sound.id)}-name`;
                  const detailId = `${optionId(sound.id)}-detail`;
                  const markerId = `${optionId(sound.id)}-in-mix`;
                  return (
                    <div key={sound.id} className="picker-row" role="none">
                      <div
                        id={optionId(sound.id)}
                        className="picker-option"
                        role="option"
                        aria-selected={sound === active}
                        aria-disabled={full && !added ? true : undefined}
                        aria-labelledby={nameId}
                        aria-describedby={added ? `${detailId} ${markerId}` : detailId}
                        data-in-mix={added}
                        onMouseDown={keepFocus}
                        onPointerEnter={() => {
                          onPrefetch?.(sound);
                        }}
                        onClick={(event) => {
                          setActiveId(sound.id);
                          select(sound, event.shiftKey);
                        }}
                      >
                        <span
                          className="layer-dot"
                          style={{ "--tint": sound.tint }}
                          aria-hidden="true"
                        />
                        <span className="picker-text">
                          <span id={nameId} className="picker-name">
                            {sound.name}
                          </span>
                          <span id={detailId} className="picker-description">
                            {sound.description}
                          </span>
                        </span>
                        {sort === "cost" && (
                          <span className="picker-cost" title="How much processing it takes">
                            {COST_LABELS[sound.cost]}
                          </span>
                        )}
                        {added && (
                          <span id={markerId} className="picker-in-mix">
                            In mix ✓
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="icon-button picker-star"
                        tabIndex={-1}
                        aria-label={`Star ${sound.name}`}
                        aria-pressed={starred}
                        title={hover ? `${starred ? "Unstar" : "Star"} (*)` : undefined}
                        onMouseDown={keepFocus}
                        onClick={() => {
                          onToggleFavourite(sound.id);
                        }}
                      >
                        <StarIcon filled={starred} />
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <p className="hint">No sounds match</p>}
      </div>
    </div>
  );
}
