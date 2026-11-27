import { describe, expect, it } from "vitest";
import { sounds } from "./registry";

/** Every sound metadata module's source, by path. */
const metaSources = import.meta.glob<string>("./*/*.meta.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const registrySource = import.meta.glob<string>("./registry.ts", {
  query: "?raw",
  import: "default",
  eager: true,
})["./registry.ts"];

/** Specifiers of the static imports that load code at runtime (not `import type`). */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  // Every group always participates, so each is a string (empty when absent).
  for (const m of source.matchAll(
    /^\s*import\s+(type\s+|)([^"';]*?)\s*(?:from\s*|)["']([^"']+)["']/gm,
  )) {
    const [, typeKeyword, clause, specifier] = m;
    const allTypes = /^\{(\s*type\s+[^,}]+,?)+\s*\}$/.test(clause);
    if (typeKeyword === "" && !allTypes) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("sound metadata modules", () => {
  it("exist for every registered sound", () => {
    for (const sound of sounds) {
      expect(Object.keys(metaSources)).toContain(`./${sound.id}/${sound.id}.meta.ts`);
    }
  });

  it.each(Object.entries(metaSources))(
    "%s imports only types, param options and other metadata",
    (_, source) => {
      expect(source).not.toMatch(/\bimport\s*\(/);
      for (const specifier of runtimeImports(source)) {
        expect(specifier).toMatch(/^(\.\.\/types|\.\.\/param-options|\.{1,2}\/.*\.meta)$/);
      }
    },
  );

  it("registry.ts imports only metadata at runtime", () => {
    const specifiers = runtimeImports(registrySource);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/\.meta$/);
    }
  });

  it("the import check sees through type-only imports", () => {
    const source = [
      'import type { A } from "./a";',
      'import { type B } from "./b";',
      'import { c } from "./c";',
      'import "./d";',
    ].join("\n");
    expect(runtimeImports(source)).toEqual(["./c", "./d"]);
  });
});

describe.each(sounds.map((s) => [s.id, s] as const))("%s metadata", (_, sound) => {
  it("has a name and description", () => {
    expect(sound.name.trim()).not.toBe("");
    expect(sound.description.trim()).not.toBe("");
  });

  it("keeps its hint, if any, short and without a full stop", () => {
    const hint = sound.hint ?? "Short";
    expect(hint.trim()).not.toBe("");
    expect(hint.length).toBeLessThanOrEqual(32);
    expect(hint).not.toMatch(/\.$/);
  });

  it.each(Object.entries(sound.params))(
    "labels param %s and names its group, if any",
    (_key, def) => {
      expect(def.label.trim()).not.toBe("");
      // An unset group is fine; a set one must name a section.
      expect(def.group ?? "Settings").toMatch(/\S/);
    },
  );
});
