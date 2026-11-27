import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { VOLUME_PARAM, type Layer } from "../mixes/mix";
import type { LayerState } from "../audio/engine";
import type { SoundEntry } from "../sounds/registry";
import type { ParamValue } from "../sounds/types";
import { ChevronIcon, CloseIcon, StarIcon } from "./icons";
import { ParamSections } from "./ParamSections";
import { layerNameId } from "./mixer";
import { countChanged } from "./sections";
import { ParamControl } from "./ParamControl";

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
  /** The layer's position in the mix, from 0; its shortcuts use the number after it. */
  index: number;
  /** Whether to add shortcuts to tooltips. */
  hover: boolean;
  /** What the engine reports for this layer; undefined until it has looked at it. */
  status: LayerState | undefined;
  soloed: boolean;
  /** Whether the sound is starred; the star shows while the row is expanded. */
  starred: boolean;
  onToggleStar: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
  open: boolean;
  onToggle: () => void;
  /** Names of this layer's collapsed param sections. */
  closedSections: ReadonlySet<string>;
  onToggleSection: (section: string) => void;
  onVolumeChange: (volume: number) => void;
  onParamChange: (key: string, value: ParamValue) => void;
}

/**
 * One row of the mixer: a tint dot that glows with the layer's level, the name,
 * a star while expanded, Solo, Mute, a chevron that shows the sound's settings,
 * Remove, and the volume, which is always shown.
 */
export function LayerSection({
  layer,
  sound,
  index,
  hover,
  status,
  soloed,
  starred,
  onToggleStar,
  onRetry,
  onRemove,
  onToggleMute,
  onToggleSolo,
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
  const nameId = layerNameId(layer.id);
  const bodyId = `layer-${layer.id}-settings`;
  const { name } = sound;
  const hint = (title: string, key: string) =>
    hover && index < 8 ? `${title} (${key}${String(index + 1)})` : title;
  return (
    <section
      className="panel-section layer"
      aria-labelledby={nameId}
      data-layer-id={layer.id}
      data-muted={layer.muted}
      data-soloed={soloed}
    >
      <div className="layer-row">
        <span
          className="layer-dot"
          data-level-id={layer.id}
          style={{ "--tint": sound.tint }}
          aria-hidden="true"
        />
        <div className="layer-name">
          <h2 id={nameId} className="layer-title" tabIndex={-1}>
            {name}
          </h2>
          {changed > 0 && <span className="section-changed">{changed} changed</span>}
          {sound.hint !== undefined && <p className="layer-hint">{sound.hint}</p>}
        </div>
        <div className="layer-actions">
          {open && (
            <button
              type="button"
              className="icon-button layer-star"
              aria-label={`Star ${name}`}
              aria-pressed={starred}
              title={hover ? `${starred ? "Unstar" : "Star"} (S)` : starred ? "Unstar" : "Star"}
              onClick={onToggleStar}
            >
              <StarIcon filled={starred} />
            </button>
          )}
          <button
            type="button"
            className="layer-toggle"
            aria-label={`Solo ${name}`}
            aria-pressed={soloed}
            title={hint(soloed ? "Unsolo" : "Solo", "Shift+")}
            onClick={onToggleSolo}
          >
            S
          </button>
          <button
            type="button"
            className="layer-toggle"
            aria-label={`Mute ${name}`}
            aria-pressed={layer.muted}
            title={hint(layer.muted ? "Unmute" : "Mute", "")}
            onClick={onToggleMute}
          >
            M
          </button>
          <button
            type="button"
            className="icon-button layer-expand"
            aria-label={`Show ${name} settings`}
            aria-expanded={open}
            aria-controls={bodyId}
            title={open ? "Hide settings" : "Show settings"}
            onClick={onToggle}
          >
            <ChevronIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${name}`}
            title="Remove"
            onClick={onRemove}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      {slow && (
        <p className="loading" role="status">
          Loading…
        </p>
      )}
      {error !== undefined && (
        <div className="sound-error" role="alert">
          <p>
            Couldn't play {name}: {error}
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
      <div className="controls layer-volume">
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
      <div
        id={bodyId}
        className="layer-settings"
        role="region"
        aria-labelledby={nameId}
        hidden={!open}
      >
        <ParamSections
          idPrefix={layer.id}
          schema={sound.params}
          values={layer.params}
          closed={closedSections}
          onToggle={onToggleSection}
          onParamChange={onParamChange}
        />
      </div>
    </section>
  );
}
