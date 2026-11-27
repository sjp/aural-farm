import { describe, expect, it } from "vitest";

/**
 * A sound may use another sound's metadata, but never its implementation: shared
 * code belongs in `src/audio`, so each sound's chunk stays independent.
 */
const sources = import.meta.glob<string>(["./*/**/*.ts", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Specifiers of runtime imports, static and dynamic (`import type` is skipped). */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const m of source.matchAll(
    /^\s*(?:import|export)\s+(type\s+|)([^"';]*?)\s*(?:from\s*|)["']([^"']+)["']/gm,
  )) {
    const [, typeKeyword, clause, specifier] = m;
    const allTypes = /^\{(\s*type\s+[^,}]+,?)+\s*\}$/.test(clause);
    if (typeKeyword === "" && !allTypes) {
      specifiers.push(specifier);
    }
  }
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

/** Resolves a relative specifier against a file path like `./rain/rain.ts`. */
function resolve(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/** The sound folder a path inside `src/sounds` belongs to, if any: `./rain/x.ts` → "rain". */
function soundFolder(path: string): string | undefined {
  return /^\.\/([^/]+)\//.exec(path)?.[1];
}

/** Imports from `path` into another sound's folder that aren't its metadata. */
function crossSoundImports(path: string, source: string): string[] {
  const own = soundFolder(path);
  return runtimeImports(source).filter((specifier) => {
    const target = resolve(path, specifier);
    const folder = soundFolder(target);
    return folder !== undefined && folder !== own && !target.endsWith(".meta");
  });
}

describe("sound imports", () => {
  it("finds the sound sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(sources))("%s imports no other sound's implementation", (path, source) => {
    expect(crossSoundImports(path, source)).toEqual([]);
  });

  it("spots static, dynamic and re-exported imports, and allows metadata and types", () => {
    const source = [
      'import { a } from "../rain/rain";',
      'import type { B } from "../wind/wind";',
      'import { c } from "../wind/wind.meta";',
      'export { d } from "../fan/fan-dsp";',
      'const e = import("../stream/stream");',
      'import { f } from "./own-dsp";',
      'import { g } from "../../audio/scope";',
    ].join("\n");
    expect(crossSoundImports("./drone/drone.ts", source)).toEqual([
      "../rain/rain",
      "../fan/fan-dsp",
      "../stream/stream",
    ]);
  });
});
