import type { JSX } from "preact";
import type { ParamSchema, ParamValue, ParamValues } from "../sounds/types";
import { countChanged, groupParams } from "./sections";
import { ParamControl } from "./ParamControl";
import { Section } from "./Section";

interface ParamSectionsProps {
  /** Makes control ids unique across layers. */
  idPrefix: string;
  schema: ParamSchema;
  values: ParamValues;
  /** Names of the sections that are collapsed. */
  closed: ReadonlySet<string>;
  onToggle: (section: string) => void;
  onParamChange: (key: string, value: ParamValue) => void;
}

/**
 * A schema's controls, grouped into collapsible sections. With only one section
 * there's nothing to collapse, so it has no header.
 */
export function ParamSections({
  idPrefix,
  schema,
  values,
  closed,
  onToggle,
  onParamChange,
}: ParamSectionsProps): JSX.Element | null {
  const groups = groupParams(schema);
  const controls = (keys: readonly string[]) => (
    <div className="controls">
      {keys.map((key) => {
        const def = schema[key];
        return (
          <ParamControl
            key={key}
            id={`${idPrefix}-${key}`}
            def={def}
            value={values[key] ?? def.default}
            onChange={(value) => {
              onParamChange(key, value);
            }}
            onReset={() => {
              onParamChange(key, def.default);
            }}
          />
        );
      })}
    </div>
  );
  if (groups.length === 0) {
    return null;
  }
  if (groups.length === 1) {
    return controls(groups[0].keys);
  }
  return (
    <>
      {groups.map(({ name, keys }) => (
        <Section
          key={name}
          title={name}
          open={!closed.has(name)}
          onToggle={() => {
            onToggle(name);
          }}
          changed={countChanged(schema, values, keys)}
        >
          {controls(keys)}
        </Section>
      ))}
    </>
  );
}
