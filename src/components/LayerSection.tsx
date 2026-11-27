import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { VOLUME_PARAM, type Layer } from "../mixes/mix";
import type { LayerState } from "../audio/engine";
import type { SoundEntry } from "../sounds/registry";
import type { ParamValue } from "../sounds/types";
import { ParamSections } from "./ParamSections";
import { countChanged } from "./sections";
import { ParamControl } from "./ParamControl";
import { Section } from "./Section";

/** "Loading…" appears only for loads slower than this, so fast loads don't flash it. */
export const LOADING_DELAY_MS = 300;

/** Whether `active` has stayed true for `LOADING_DELAY_MS`. */
function useSlow(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!active) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setSlow(true);
    }, LOADING_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [active]);
  return slow && active;
}

/** The message of a failed layer state, or undefined if it hasn't failed. */
function failure(status: LayerState | undefined): string | undefined {
  return status?.startsWith("failed: ") === true ? status.slice("failed: ".length) : undefined;
}

interface LayerSectionProps {
  layer: Layer;
  sound: SoundEntry;
  /** What the engine reports for this layer; undefined until it has looked at it. */
  status: LayerState | undefined;
  onRetry: () => void;
  onRemove: () => void;
  open: boolean;
  onToggle: () => void;
  /** Names of this layer's collapsed param sections. */
  closedSections: ReadonlySet<string>;
  onToggleSection: (section: string) => void;
  onVolumeChange: (volume: number) => void;
  onParamChange: (key: string, value: ParamValue) => void;
}

/** One layer of the mix: its name, volume and the sound's own settings. */
export function LayerSection({
  layer,
  sound,
  status,
  onRetry,
  onRemove,
  open,
  onToggle,
  closedSections,
  onToggleSection,
  onVolumeChange,
  onParamChange,
}: LayerSectionProps): JSX.Element {
  const slow = useSlow(status === undefined || status === "loading");
  const error = failure(status);
  const changed =
    countChanged(sound.params, layer.params) + (layer.volume === VOLUME_PARAM.default ? 0 : 1);
  return (
    <Section
      className="layer"
      title={sound.name}
      open={open}
      onToggle={onToggle}
      changed={changed}
      note={sound.hint === undefined ? null : <p className="layer-hint">{sound.hint}</p>}
    >
      {slow && (
        <p className="loading" role="status">
          Loading…
        </p>
      )}
      {error !== undefined && (
        <div className="sound-error" role="alert">
          <p>
            Couldn't play {sound.name}: {error}
          </p>
          <div className="sound-error-actions">
            <button type="button" onClick={onRetry}>
              Retry
            </button>
            <button type="button" onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      )}
      <div className="controls">
        <ParamControl
          id={`${layer.id}-volume`}
          def={VOLUME_PARAM}
          value={layer.volume}
          onChange={(value) => {
            onVolumeChange(Number(value));
          }}
          onReset={() => {
            onVolumeChange(VOLUME_PARAM.default);
          }}
        />
      </div>
      <ParamSections
        idPrefix={layer.id}
        schema={sound.params}
        values={layer.params}
        closed={closedSections}
        onToggle={onToggleSection}
        onParamChange={onParamChange}
      />
    </Section>
  );
}
