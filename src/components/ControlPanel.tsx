import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { EngineState, LayerState } from "../audio/engine";
import type { Layer, Mix } from "../mixes/mix";
import type { Preferences } from "../lib/preferences";
import { getSound } from "../sounds/registry";
import type { ParamValue } from "../sounds/types";
import { FullscreenIcon, HideIcon, LinkIcon } from "./icons";
import { LayerSection } from "./LayerSection";
import { PlayButton } from "./PlayButton";

/** The preference holding collapsed sections: "<sound>" for a layer, "<sound>/<section>" inside one. */
const CLOSED_KEY = "closedSections";

/** Every keyboard shortcut, as shown in the popover. */
const SHORTCUTS: readonly (readonly [key: string, action: string])[] = [
  ["Space", "Play or pause"],
  ["H", "Hide or show the panel"],
  ["F", "Toggle fullscreen"],
  ["?", "Show these shortcuts"],
];

function Shortcuts({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target) !== true) {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, onOpenChange]);
  return (
    <div ref={ref} className="shortcuts">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        aria-controls={id}
        title="Keyboard shortcuts (?)"
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        Shortcuts
      </button>
      <div
        id={id}
        className="shortcuts-popover"
        role="dialog"
        aria-label="Keyboard shortcuts"
        hidden={!open}
      >
        <dl>
          {SHORTCUTS.map(([key, action]) => (
            <div key={key}>
              <dt>
                <kbd>{key}</kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

interface ControlPanelProps {
  mix: Mix;
  engineState: EngineState;
  /** The engine's state for each layer, by sound id. */
  layerStates: Readonly<Record<string, LayerState>>;
  onTogglePlay: () => void;
  onRetryLayer: (id: string) => void;
  onRemoveLayer: (id: string) => void;
  preferences: Preferences;
  /** Whether the main pointer can hover: shortcut hints and the popover show only then. */
  hover: boolean;
  onLayerChange: (id: string, change: Partial<Omit<Layer, "id">>) => void;
  onParamChange: (id: string, key: string, value: ParamValue) => void;
  onResetAll: () => void;
  onCopyLink: () => void;
  /** Absent when the browser can't go fullscreen. */
  onFullscreen: (() => void) | undefined;
  onHide: () => void;
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
}

/** The control panel card: header and toolbar, one section per layer, and the footer. */
export function ControlPanel(props: ControlPanelProps): JSX.Element {
  const { mix, preferences, hover } = props;
  const [closed, setClosed] = useState(() => preferences.getSet(CLOSED_KEY));
  const toggle = (key: string) => {
    const next = new Set(closed);
    if (!next.delete(key)) {
      next.add(key);
    }
    setClosed(next);
    preferences.setSet(CLOSED_KEY, next);
  };
  const hint = (title: string, key: string) => (hover ? `${title} (${key})` : title);

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="panel-header-row">
          <PlayButton state={props.engineState} hover={hover} onToggle={props.onTogglePlay} />
          <h1 className="panel-title">Aural Farm</h1>
          <div className="panel-toolbar">
            <button
              type="button"
              className="icon-button"
              aria-label="Copy link"
              title="Copy link"
              onClick={props.onCopyLink}
            >
              <LinkIcon />
            </button>
            {props.onFullscreen && (
              <button
                type="button"
                className="icon-button"
                aria-label="Fullscreen"
                title={hint("Fullscreen", "F")}
                onClick={props.onFullscreen}
              >
                <FullscreenIcon />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Hide controls"
              title={hint("Hide controls", "H")}
              onClick={props.onHide}
            >
              <HideIcon />
            </button>
          </div>
        </div>
        {props.engineState === "failed" && (
          <p className="audio-error" role="alert">
            Audio isn't available in this browser.
          </p>
        )}
      </header>
      <div className="panel-body">
        {mix.layers.length === 0 && <p className="hint">The mix is empty.</p>}
        {mix.layers.flatMap((layer) => {
          const sound = getSound(layer.id);
          if (!sound) {
            return [];
          }
          const prefix = `${layer.id}/`;
          const closedSections = new Set(
            [...closed].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
          );
          return [
            <LayerSection
              key={layer.id}
              layer={layer}
              sound={sound}
              status={props.layerStates[layer.id]}
              onRetry={() => {
                props.onRetryLayer(layer.id);
              }}
              onRemove={() => {
                props.onRemoveLayer(layer.id);
              }}
              open={!closed.has(layer.id)}
              onToggle={() => {
                toggle(layer.id);
              }}
              closedSections={closedSections}
              onToggleSection={(section) => {
                toggle(prefix + section);
              }}
              onVolumeChange={(volume) => {
                props.onLayerChange(layer.id, { volume });
              }}
              onParamChange={(key, value) => {
                props.onParamChange(layer.id, key, value);
              }}
            />,
          ];
        })}
      </div>
      <footer className="panel-footer">
        <div className="footer-actions">
          <button
            type="button"
            className="text-button"
            title="Put every layer's settings and volume back to their defaults"
            onClick={props.onResetAll}
          >
            Reset all
          </button>
          {hover && (
            <Shortcuts open={props.shortcutsOpen} onOpenChange={props.onShortcutsOpenChange} />
          )}
        </div>
      </footer>
    </div>
  );
}
