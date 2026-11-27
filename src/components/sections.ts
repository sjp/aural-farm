/** Grouping a sound's params into panel sections. */
import { isDefault } from "../sounds/params";
import type { ParamSchema, ParamValues } from "../sounds/types";

/** The section params without a `group` go in. */
const DEFAULT_SECTION = "Settings";

interface SectionGroup {
  name: string;
  keys: string[];
}

/** A schema's params by section, in the order each section first appears. */
export function groupParams(schema: ParamSchema): SectionGroup[] {
  const groups = new Map<string, string[]>();
  for (const [key, def] of Object.entries(schema)) {
    const name = def.group ?? DEFAULT_SECTION;
    const keys = groups.get(name);
    if (keys) {
      keys.push(key);
    } else {
      groups.set(name, [key]);
    }
  }
  return [...groups].map(([name, keys]) => ({ name, keys }));
}

/** How many of `keys` differ from their defaults. */
export function countChanged(
  schema: ParamSchema,
  values: ParamValues,
  keys: readonly string[] = Object.keys(schema),
): number {
  return keys.filter((key) => {
    const def = schema[key];
    return !isDefault(def, values[key] ?? def.default);
  }).length;
}
