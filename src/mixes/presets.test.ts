import { describe, expect, it } from "vitest";
import { getSound } from "../sounds/registry";
import { MAX_LAYERS, parseHash, serialiseHash } from "./mix";
import { presets } from "./presets";

const layerList = (hash: string) => new URLSearchParams(hash.slice(1)).get("layers") ?? "";

describe("presets", () => {
  it("has some", () => {
    expect(presets.length).toBeGreaterThan(0);
  });

  it("has unique ids and names", () => {
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    expect(new Set(presets.map((p) => p.name.toLowerCase())).size).toBe(presets.length);
  });

  it.each(presets)("$id uses only registered sounds", ({ hash }) => {
    const missing = layerList(hash)
      .split(",")
      .filter((id) => getSound(id) === undefined);
    expect(missing).toEqual([]);
  });

  it.each(presets)("$id has 1–8 layers", ({ hash }) => {
    const { layers } = parseHash(hash).mix;
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.length).toBeLessThanOrEqual(MAX_LAYERS);
    expect(layers).toHaveLength(layerList(hash).split(",").length);
  });

  it.each(presets)("$id round-trips unchanged in the full form", ({ hash }) => {
    expect(serialiseHash(parseHash(hash), { full: true })).toBe(hash);
  });

  it.each(presets)("$id carries its name in the hash", ({ hash, name }) => {
    expect(parseHash(hash).mix.name).toBe(name);
  });

  it.each(presets)("$id has a kebab-case id and a one-line description", ({ id, description }) => {
    expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(description).not.toMatch(/\n/);
    expect(description.length).toBeLessThanOrEqual(80);
  });
});
