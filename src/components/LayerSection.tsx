import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { VOLUME_PARAM, type Layer } from "../mixes/mix";
import { createLatest, type SoundLoader } from "../sounds/loader";
import type { SoundEntry } from "../sounds/registry";
import type { ParamValue } from "../sounds/types";
import { ParamSections } from "./ParamSections";
import { countChanged } from "./sections";
import { ParamControl } from "./ParamControl";
import { Section } from "./Section";

/** "Loading…" appears only for loads slower than this, so fast loads don't flash it. */
export const LOADING_DELAY_MS = 300;

type LoadStatus = "ready" | "loading" | "slow" | "error";

/** Loads a sound's implementation, reporting progress; `retry` starts a failed load again. */
function useSoundLoad(sound: SoundEntry, loader: SoundLoader): [LoadStatus, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<LoadStatus>(() =>
    loader.get(sound.id) ? "ready" : "loading",
  );
  useEffect(() => {
    if (loader.get(sound.id)) {
      setStatus("ready");
      return undefined;
    }
    setStatus("loading");
    const latest = createLatest<unknown>();
    const timer = setTimeout(() => {
      setStatus((s) => (s === "loading" ? "slow" : s));
    }, LOADING_DELAY_MS);
    latest.run(
      loader.load(sound),
      () => {
        clearTimeout(timer);
        setStatus("ready");
      },
      (error: unknown) => {
        clearTimeout(timer);
        console.error(`Couldn't load ${sound.name}:`, error);
        setStatus("error");
      },
    );
    return () => {
      clearTimeout(timer);
      latest.cancel();
    };
  }, [sound, loader, attempt]);
  return [
    status,
    () => {
      setAttempt((n) => n + 1);
    },
  ];
}

interface LayerSectionProps {
  layer: Layer;
  sound: SoundEntry;
  loader: SoundLoader;
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
  loader,
  open,
  onToggle,
  closedSections,
  onToggleSection,
  onVolumeChange,
  onParamChange,
}: LayerSectionProps): JSX.Element {
  const [status, retry] = useSoundLoad(sound, loader);
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
      {status === "slow" && (
        <p className="loading" role="status">
          Loading…
        </p>
      )}
      {status === "error" && (
        <div className="sound-error" role="alert">
          <p>Couldn't load {sound.name}</p>
          <button type="button" onClick={retry}>
            Retry
          </button>
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
