import { defaults } from "../sounds/params";
import type { ParamSchema, ParamValues } from "../sounds/types";

interface ParamSet {
  /** What the set exercises, for test names: "defaults", "wave=triangle", "pitch=max". */
  name: string;
  params: ParamValues;
}

/**
 * The param sets every sound is tested with: the defaults, then each select
 * option, each slider's extremes and each toggle flipped, one change at a time
 * from the defaults.
 */
export function paramSets(schema: ParamSchema): ParamSet[] {
  const base = defaults(schema);
  const sets: ParamSet[] = [{ name: "defaults", params: base }];
  const add = (key: string, label: string, value: ParamValues[string]) => {
    sets.push({ name: `${key}=${label}`, params: { ...base, [key]: value } });
  };
  for (const [key, def] of Object.entries(schema)) {
    switch (def.kind) {
      case "number":
        add(key, "min", def.min);
        add(key, "max", def.max);
        break;
      case "select":
        for (const option of def.options) {
          if (option.value !== def.default) {
            add(key, option.value, option.value);
          }
        }
        break;
      case "boolean":
        add(key, String(!def.default), !def.default);
        break;
      default:
        def satisfies never;
    }
  }
  return sets;
}
