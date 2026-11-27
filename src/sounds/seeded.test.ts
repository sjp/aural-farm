import { describe, expect, it } from "vitest";

/**
 * Sounds must be reproducible from their seed (shared links, export in chunks), so
 * nothing in the sound or audio code may draw from `Math.random`. Tests are exempt.
 */
const sources = {
  ...import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>(["../audio/**/*.ts", "!../audio/**/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

describe("seeded randomness", () => {
  it("finds the sound and audio sources", () => {
    expect(Object.keys(sources)).toContain("./registry.ts");
    expect(Object.keys(sources)).toContain("../audio/scope.ts");
  });

  it.each(Object.entries(sources))("%s doesn't use Math.random", (_, source) => {
    expect(source).not.toMatch(/\bMath\s*\.\s*random\b/);
  });
});
