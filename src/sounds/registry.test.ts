import { describe, expect, it } from "vitest";
import { DEFAULT_SOUND_ID, getSound, sounds } from "./registry";
import { SOUND_CATEGORIES } from "./types";

/** The categories every sound could use from the start; any added later needs four sounds. */
const ORIGINAL_CATEGORIES: ReadonlySet<string> = new Set([
  "Noise",
  "Sci-fi",
  "Nature",
  "Machines",
  "Places",
  "Tonal",
  "Cosy",
  "Sleep",
  "Focus",
]);
const MIN_SOUNDS_FOR_NEW_CATEGORY = 4;
/** Keys a layer uses for itself in the URL hash. */
const RESERVED_KEYS = ["volume", "muted"];

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w !== ""),
  );
}

describe("registry", () => {
  it("has unique ids", () => {
    const ids = sounds.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has the default sound", () => {
    expect(getSound(DEFAULT_SOUND_ID)).toBeDefined();
    expect(getSound("no-such-sound")).toBeUndefined();
  });

  it("lists the default sound, Starship Engine Core, first", () => {
    expect(DEFAULT_SOUND_ID).toBe("engine-core");
    expect(sounds[0]?.id).toBe(DEFAULT_SOUND_ID);
  });

  it("has no placeholder test tone", () => {
    expect(getSound("test-tone")).toBeUndefined();
  });

  it.each(SOUND_CATEGORIES.filter((c) => !ORIGINAL_CATEGORIES.has(c)))(
    "has enough sounds in the added category %s",
    (category) => {
      const count = sounds.filter((s) => s.categories.includes(category)).length;
      expect(count).toBeGreaterThanOrEqual(MIN_SOUNDS_FOR_NEW_CATEGORY);
    },
  );
});

describe.each(sounds.map((s) => [s.id, s] as const))("%s", (_, sound) => {
  it("has a URL-safe id", () => {
    expect(sound.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("has 1–3 known categories without repeats", () => {
    expect(sound.categories.length).toBeGreaterThanOrEqual(1);
    expect(sound.categories.length).toBeLessThanOrEqual(3);
    expect(new Set(sound.categories).size).toBe(sound.categories.length);
    for (const category of sound.categories) {
      expect(SOUND_CATEGORIES).toContain(category);
    }
  });

  it("has a few lowercase tags that add new search words", () => {
    expect(sound.tags.length).toBeGreaterThanOrEqual(1);
    expect(sound.tags.length).toBeLessThanOrEqual(8);
    expect(new Set(sound.tags).size).toBe(sound.tags.length);
    const known = words(`${sound.name} ${sound.description} ${sound.categories.join(" ")}`);
    for (const tag of sound.tags) {
      expect(tag).toBe(tag.toLowerCase());
      expect(tag.trim()).toBe(tag);
      expect(tag).not.toBe("");
      expect(known.has(tag)).toBe(false);
    }
  });

  it("has a #rrggbb tint", () => {
    expect(sound.tint).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("uses plain, unreserved param keys", () => {
    for (const key of Object.keys(sound.params)) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(RESERVED_KEYS).not.toContain(key);
    }
  });

  it("loads a definition whose metadata matches", async () => {
    const definition = await sound.load();
    const { load: _load, ...meta } = sound;
    const { create, loopPeriod, ...loadedMeta } = definition;
    expect(loadedMeta).toEqual(meta);
    expect(typeof create).toBe("function");
    expect(["function", "undefined"]).toContain(typeof loopPeriod);
  });
});
