import { describe, expect, it } from "vitest";
import { defaults, sliderPosition, valueAtPosition } from "../sounds/params";
import { sounds } from "../sounds/registry";
import type { ParamSchema, ParamValues } from "../sounds/types";
import {
  MAX_LAYERS,
  MAX_NAME_LENGTH,
  defaultLayer,
  defaultMix,
  parseHash,
  sanitizeName,
  serialiseHash,
  withName,
  type Mix,
} from "./mix";

const tone = {
  id: "tone",
  params: {
    pitch: { kind: "number", label: "Pitch", min: 110, max: 880, step: 1, default: 220 },
    wave: {
      kind: "select",
      label: "Wave",
      options: [
        { value: "sine", label: "Sine" },
        { value: "triangle", label: "Triangle" },
      ],
      default: "sine",
    },
    soft: { kind: "boolean", label: "Soft", default: false },
  } satisfies ParamSchema,
};
const ids = ["tone", "a", "b", "c", "d", "e", "f", "g", "h", "i"];
const catalogue = ids.map((id) => (id === "tone" ? tone : { id, params: {} }));

const parse = (hash: string) => parseHash(hash, catalogue, "tone");
const layerIds = (hash: string) => parse(hash).mix.layers.map((l) => l.id);

describe("parseHash", () => {
  it.each(["", "#", "#master=50", "#panel=hidden"])(
    "reads %j, which has no layers key, as the default mix",
    (hash) => {
      expect(parse(hash).mix.layers).toEqual([defaultLayer(tone)]);
    },
  );

  it("reads an empty layers key as an empty mix", () => {
    expect(parse("#layers=").mix.layers).toEqual([]);
  });

  it("drops unknown ids and repeats", () => {
    expect(layerIds("#layers=a,nope,b,a,tone")).toEqual(["a", "b", "tone"]);
  });

  it("keeps at most the first eight layers", () => {
    expect(layerIds(`#layers=${ids.join(",")}`)).toEqual(ids.slice(0, MAX_LAYERS));
  });

  it("reads volumes, mutes and params", () => {
    const { mix } = parse(
      "#master=40&layers=tone&tone.volume=90&tone.muted=1&tone.pitch=330&tone.wave=triangle&tone.soft=1",
    );
    expect(mix).toEqual({
      master: 40,
      layers: [
        {
          id: "tone",
          volume: 90,
          muted: true,
          params: { pitch: 330, wave: "triangle", soft: true },
        },
      ],
    });
  });

  it("coerces invalid values to their defaults or the nearest valid value", () => {
    const { mix } = parse(
      "#master=abc&layers=tone&tone.volume=150&tone.muted=yes&tone.pitch=12.7&tone.wave=square",
    );
    expect(mix.master).toBe(70);
    expect(mix.layers[0]).toEqual({
      id: "tone",
      volume: 100,
      muted: false,
      params: { pitch: 110, wave: "sine", soft: false },
    });
  });

  it("ignores keys for sounds not in the mix and unknown keys", () => {
    const { mix } = parse("#layers=a&tone.pitch=300&a.nope=1&other=2");
    expect(mix.layers).toEqual([{ id: "a", volume: 70, muted: false, params: {} }]);
  });

  it("reads panel=hidden", () => {
    expect(parse("#panel=hidden").panelHidden).toBe(true);
    expect(parse("#panel=shown").panelHidden).toBe(false);
  });

  it("uses the registry by default", () => {
    expect(parseHash("").mix).toEqual(defaultMix());
    expect(defaultMix().layers).toHaveLength(1);
  });
});

describe("serialiseHash", () => {
  const changed: Mix = {
    master: 70,
    layers: [
      { id: "tone", volume: 80, muted: false, params: { pitch: 330, wave: "sine", soft: false } },
      { id: "a", volume: 70, muted: true, params: {} },
    ],
  };

  it("writes only changed values in the live form", () => {
    expect(serialiseHash({ mix: changed, panelHidden: false }, {}, catalogue)).toBe(
      "#layers=tone,a&tone.volume=80&tone.pitch=330&a.muted=1",
    );
  });

  it("writes every value and the panel state in the full form", () => {
    expect(serialiseHash({ mix: changed, panelHidden: true }, { full: true }, catalogue)).toBe(
      "#master=70&layers=tone,a&tone.volume=80&tone.muted=0&tone.pitch=330&tone.wave=sine&tone.soft=0&a.volume=70&a.muted=1&panel=hidden",
    );
  });

  it("writes an empty mix as an empty layers key", () => {
    expect(serialiseHash({ mix: { master: 70, layers: [] }, panelHidden: false })).toBe("#layers=");
  });

  it.each([false, true])("round-trips (full: %s)", (full) => {
    const state = { mix: changed, panelHidden: full };
    expect(parse(serialiseHash(state, { full }, catalogue))).toEqual(state);
  });
});

describe("sanitizeName", () => {
  it.each([
    ["Rainy Cabin", "Rainy Cabin"],
    ["  Rainy   Cabin  ", "Rainy Cabin"],
    ["Rainy\nCabin", "Rainy Cabin"],
    ["Rainy\r\n\tCabin", "Rainy Cabin"],
    ["Rainy\u2028Cabin", "Rainy Cabin"],
    ["Bell\u0007s\u0000", "Bells"],
    ["Esc\u001b[31m", "Esc[31m"],
    ["\u009bC1", "C1"],
    ["\u202Eniaga\u202C", "niaga"],
    ["a\u202Ab\u202Bc\u202Dd", "abcd"],
    ["\u2066isolated\u2069 \u2067x\u2068", "isolated x"],
    ["zero\u200Bwidth\uFEFF\u2060", "zerowidth"],
    ["", ""],
    [" \n\t ", ""],
    ["\u202E\u200B", ""],
  ])("makes %j %j", (text, expected) => {
    expect(sanitizeName(text)).toBe(expected);
  });

  it("normalises to NFC", () => {
    expect(sanitizeName("Cafe\u0301")).toBe("Caf\u00e9");
  });

  it.each(["Sleep 🌙", "🌧️ + 🔥", "👩‍👩‍👧 family", "🏳️‍🌈"])("keeps emoji in %j", (text) => {
    expect(sanitizeName(text)).toBe(text);
  });

  it("counts the length in code points, not UTF-16 units", () => {
    const moons = "🌙".repeat(MAX_NAME_LENGTH + 5);
    expect(Array.from(sanitizeName(moons))).toHaveLength(MAX_NAME_LENGTH);
    expect(sanitizeName("a".repeat(100))).toBe("a".repeat(MAX_NAME_LENGTH));
    // 40 emoji are 80 UTF-16 units but still fit.
    expect(sanitizeName("🌙".repeat(MAX_NAME_LENGTH))).toBe("🌙".repeat(MAX_NAME_LENGTH));
  });

  it("drops a space the cut leaves at the end", () => {
    expect(sanitizeName(`${"a".repeat(MAX_NAME_LENGTH - 1)} b`)).toBe("a".repeat(39));
  });
});

describe("mix names in the hash", () => {
  const mix: Mix = { master: 70, layers: [{ id: "a", volume: 70, muted: false, params: {} }] };

  it("writes the name first, percent-encoded", () => {
    expect(serialiseHash({ mix: { ...mix, name: "Rainy Cabin" }, panelHidden: false })).toBe(
      "#name=Rainy%20Cabin&layers=a",
    );
  });

  it("writes no name key for an unnamed mix", () => {
    expect(serialiseHash({ mix, panelHidden: false }, {}, catalogue)).toBe("#layers=a");
  });

  it.each(["Rainy Cabin", "Sleep 🌙", "a & b = c, d", "100% #focus", "日本語の名前", "👩‍👩‍👧"])(
    "round-trips %j in both forms",
    (name) => {
      const state = { mix: { ...mix, name }, panelHidden: false };
      for (const full of [false, true]) {
        expect(parse(serialiseHash(state, { full }, catalogue))).toEqual(state);
      }
    },
  );

  it("sanitises a pasted name", () => {
    expect(parse("#name=%E2%80%AEevil%0Aname%07&layers=a").mix.name).toBe("evil name");
  });

  it.each(["#name=&layers=a", "#name=%20%0A&layers=a", "#name=%E2%80%8B&layers=a"])(
    "drops a name that sanitises to nothing in %s",
    (hash) => {
      expect(parse(hash).mix).not.toHaveProperty("name");
    },
  );

  it("keeps a name on the default mix", () => {
    expect(parse("#name=Hello").mix).toEqual({ ...defaultMix(catalogue, "tone"), name: "Hello" });
  });
});

describe("withName", () => {
  const mix: Mix = { master: 70, layers: [], name: "Old" };

  it("sets a sanitised name", () => {
    expect(withName(mix, " New\n")).toEqual({ master: 70, layers: [], name: "New" });
  });

  it.each([undefined, null, "", "\u200B"])("removes the name for %j", (name) => {
    expect(withName(mix, name)).toEqual({ master: 70, layers: [] });
  });
});

describe("mute and solo in the hash", () => {
  const layer = (id: string, muted: boolean) => ({ id, volume: 70, muted, params: {} });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("round-trips a mute of %s and %s", (first, second) => {
    const state = {
      mix: { master: 70, layers: [layer("a", first), layer("b", second)] },
      panelHidden: false,
    };
    for (const full of [false, true]) {
      expect(parse(serialiseHash(state, { full }, catalogue))).toEqual(state);
    }
  });

  it("never writes a solo: it lives outside the mix", () => {
    // Even a mix object carrying extra fields, as a soloed layer might in the UI,
    // writes only the mix's own keys.
    const layers = [{ ...layer("a", false), soloed: true }, layer("b", true)];
    const state = { mix: { master: 70, layers, solo: ["a"] }, panelHidden: false };
    for (const full of [false, true]) {
      expect(serialiseHash(state, { full }, catalogue)).not.toMatch(/solo/);
    }
  });

  it("ignores a solo key in a pasted hash", () => {
    expect(parse("#layers=a,b&a.solo=1&solo=a").mix.layers).toEqual([
      layer("a", false),
      layer("b", false),
    ]);
  });
});

/** Mixes for every sound: at its defaults, and at each select option and slider extreme. */
function variants(sound: (typeof sounds)[number]): [string, ParamValues][] {
  const base = defaults(sound.params);
  const out: [string, ParamValues][] = [["defaults", base]];
  for (const [key, def] of Object.entries(sound.params)) {
    switch (def.kind) {
      case "number":
        out.push([`${key}=min`, { ...base, [key]: def.min }]);
        out.push([
          `${key}=max`,
          { ...base, [key]: valueAtPosition(def, sliderPosition(def, def.max)) },
        ]);
        break;
      case "select":
        for (const option of def.options) {
          out.push([`${key}=${option.value}`, { ...base, [key]: option.value }]);
        }
        break;
      case "boolean":
        out.push([`${key}=on`, { ...base, [key]: true }]);
        out.push([`${key}=off`, { ...base, [key]: false }]);
        break;
      default:
        throw new Error("unknown param kind");
    }
  }
  return out;
}

const cases = sounds.flatMap((sound) =>
  variants(sound).flatMap(([name, params]) =>
    [false, true].map((full) => [sound.id, name, full, params] as const),
  ),
);

describe("every sound round-trips through the hash", () => {
  it.each(cases)("%s with %s (full: %s)", (id, _name, full, params) => {
    const mix: Mix = { master: 55, layers: [{ id, volume: 0, muted: true, params }] };
    const state = { mix, panelHidden: false };
    expect(parseHash(serialiseHash(state, { full }))).toEqual(state);
  });
});
