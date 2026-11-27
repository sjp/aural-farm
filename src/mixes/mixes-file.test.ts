import { describe, expect, it } from "vitest";
import { MAX_HASH_LENGTH, MAX_SAVED_MIXES, type SavedMix } from "./mixes";
import { MAX_FILE_LENGTH, MIXES_FILE_NAME, mixesFile, readMixesFile } from "./mixes-file";

const catalogue = [
  {
    id: "tone",
    params: {
      pitch: { kind: "number", label: "Pitch", min: 110, max: 880, step: 1, default: 220 },
    },
  },
  { id: "a", params: {} },
] as const;

const read = (text: string) => readMixesFile(text, catalogue);
const file = (mixes: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ app: "aural-farm", version: 1, mixes, ...extra });
const mix = (name: string, hash = "#layers=tone", savedAt = 1) => ({ name, hash, savedAt });
const errorOf = (text: string) => {
  const result = read(text);
  return result.ok ? undefined : result.error;
};

describe("mixesFile", () => {
  it("round-trips through readMixesFile", () => {
    const saved: SavedMix[] = [
      { name: "Rain", hash: "#name=Rain&master=70&layers=a&a.volume=70&a.muted=0", savedAt: 5 },
    ];
    expect(read(mixesFile(saved))).toEqual({ ok: true, mixes: saved });
    expect(MIXES_FILE_NAME).toBe("aural-farm-mixes.json");
  });

  it("writes the app, a version and the mixes", () => {
    expect(JSON.parse(mixesFile([]))).toEqual({ app: "aural-farm", version: 1, mixes: [] });
  });
});

describe("readMixesFile", () => {
  it("rewrites each hash in full, named after its entry", () => {
    expect(read(file([mix(" Night‮ ", "#layers=tone&tone.pitch=330&panel=hidden", 9)]))).toEqual({
      ok: true,
      mixes: [
        {
          name: "Night",
          hash: "#name=Night&master=70&layers=tone&tone.volume=70&tone.muted=0&tone.pitch=330",
          savedAt: 9,
        },
      ],
    });
  });

  it("drops sounds it doesn't know, keeping the rest", () => {
    const result = read(file([mix("A", "#layers=future-sound,a")]));
    expect(result.ok && result.mixes[0]?.hash).toBe(
      "#name=A&master=70&layers=a&a.volume=70&a.muted=0",
    );
  });

  it.each([
    ["not JSON", "{ nope", "isn't a mixes file"],
    ["an array", "[]", "isn't a mixes file"],
    ["null", "null", "isn't a mixes file"],
    [
      "another app's file",
      JSON.stringify({ app: "other", version: 1, mixes: [] }),
      "isn't a mixes file",
    ],
    [
      "no mixes array",
      JSON.stringify({ app: "aural-farm", version: 1, mixes: {} }),
      "isn't a mixes file",
    ],
    ["no version", JSON.stringify({ app: "aural-farm", mixes: [] }), "isn't a mixes file"],
    ["a newer version", file([], { version: 2 }), "newer version"],
    ["no mixes", file([]), "holds no mixes"],
    ["a mix that isn't an object", file(["#layers=a"]), "Mix 1 isn't a mix"],
    ["a mix that is an array", file([[]]), "Mix 1 isn't a mix"],
    ["a missing key", file([{ name: "A", hash: "#layers=a" }]), "exactly a name"],
    ["an extra key", file([{ ...mix("A"), extra: 1 }]), "exactly a name"],
    [
      "a name that isn't text",
      file([mix("A"), { ...mix("B"), name: 3 }]),
      "Mix 2 has no usable name",
    ],
    ["an empty name", file([mix(" ​ ")]), "Mix 1 has no usable name"],
    ["a huge name", file([mix("x".repeat(201))]), "Mix 1 has no usable name"],
    [
      "a savedAt that isn't a number",
      file([mix("A", "#layers=a", "1" as unknown as number)]),
      "savedAt",
    ],
    ["a negative savedAt", file([mix("A", "#layers=a", -1)]), "savedAt"],
    ["a fractional savedAt", file([mix("A", "#layers=a", 1.5)]), "savedAt"],
    ["a hash that isn't text", file([{ ...mix("A"), hash: 1 }]), '"A" has no valid mix hash'],
    ["a hash without #", file([mix("A", "layers=a")]), "no valid mix hash"],
    [
      "a huge hash",
      file([mix("A", `#layers=a&${"x".repeat(MAX_HASH_LENGTH)}`)]),
      "no valid mix hash",
    ],
    ["a hash without layers", file([mix("A", "#master=50")]), '"A" has no layers'],
    ["an empty mix", file([mix("A", "#layers=")]), "no sounds this app knows"],
    ["a mix of unknown sounds", file([mix("A", "#layers=nope,other")]), "no sounds this app knows"],
    [
      "a repeated name",
      file([mix("Rain"), mix("Wind"), mix("RAIN")]),
      '"RAIN" is in the file twice',
    ],
  ])("refuses %s", (_case, text, message) => {
    expect(errorOf(text)).toContain(message);
  });

  it("refuses too many mixes", () => {
    const mixes = Array.from({ length: MAX_SAVED_MIXES + 1 }, (_, i) => mix(`Mix ${String(i)}`));
    expect(errorOf(file(mixes))).toContain("more than 100 mixes");
  });

  it("accepts 100 mixes", () => {
    const mixes = Array.from({ length: MAX_SAVED_MIXES }, (_, i) => mix(`Mix ${String(i)}`));
    const result = read(file(mixes));
    expect(result.ok && result.mixes).toHaveLength(MAX_SAVED_MIXES);
  });

  it("refuses a huge file before parsing it", () => {
    expect(errorOf(" ".repeat(MAX_FILE_LENGTH + 1))).toContain("too large");
  });

  it("refuses the whole file for one bad mix", () => {
    expect(read(file([mix("Good"), mix("Bad", "#nope")])).ok).toBe(false);
  });
});
