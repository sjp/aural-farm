import { describe, expect, it } from "vitest";
import { defaults, sliderPosition, valueAtPosition } from "../sounds/params";
import { sounds } from "../sounds/registry";
import type { ParamSchema, ParamValues } from "../sounds/types";
import { MAX_LAYERS, defaultLayer, defaultMix, parseHash, serialiseHash, type Mix } from "./mix";

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
