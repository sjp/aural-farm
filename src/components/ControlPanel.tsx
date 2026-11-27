import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { isPlaying, type EngineState, type LayerState } from "../audio/engine";
import { MASTER_PARAM, MAX_LAYERS, type Layer, type Mix } from "../mixes/mix";
import { DISPLAY_PARAMS, type DisplaySettings } from "../backdrop/settings";
import type { Preferences } from "../lib/preferences";
import { sounds as registry, type SoundEntry } from "../sounds/registry";
import type { ParamValue } from "../sounds/types";
import {
  FullscreenIcon,
  HideIcon,
  LinkIcon,
  PlusIcon,
  SpeakerIcon,
  SpeakerMutedIcon,
} from "./icons";
import { LayerSection } from "./LayerSection";
import { ParamControl } from "./ParamControl";
import { countChanged } from "./sections";
import { Section } from "./Section";
import { layerNameId, levelBrightness } from "./mixer";
import { PlayButton } from "./PlayButton";

/** The preference holding collapsed sections: "<sound>" for a layer, "<sound>/<section>" inside one. */
const CLOSED_KEY = "closedSections";
/** The preference that is "1" while the Display section is open; it starts closed. */
const DISPLAY_OPEN_KEY = "displayOpen";
/** The Display section's controls, in order. */
const DISPLAY_KEYS = [
  "backdrop",
  "brightness",
  "respond",
] as const satisfies readonly (keyof DisplaySettings)[];

/** Every keyboard shortcut, as shown in the popover. */
const SHORTCUTS: readonly (readonly [key: string, action: string])[] = [
  ["Space", "Play or pause"],
  ["/", "Add a sound"],
  ["1–8", "Mute or unmute layer N"],
  ["Shift+1–8", "Solo or unsolo layer N"],
  ["M", "Mute or unmute everything"],
  ["↑ ↓", "Master volume up or down"],
  ["H", "Hide or show the panel"],
  ["F", "Toggle fullscreen"],
  ["D", "Backdrop: Glow, Night or Off"],
  ["?", "Show these shortcuts"],
];

/** Says why Add sound is disabled in a full mix. */
export const FULL_MIX_HINT = `${String(MAX_LAYERS)} sounds is the most a mix can hold`;

/** How often the tint dots read the layers' levels, in Hz. */
export const LEVEL_RATE_HZ = 15;

/** Where focus goes after the layers change: a layer's name, or Add sound. */
type FocusTarget = { layer: string } | "add";

/** Reads layer levels for the activity dots. */
export interface LevelMeter {
  /** Starts measuring and returns a function that stops. */
  watch: () => () => void;
  /** A layer's RMS level, 0–1. */
  get: (id: string) => number;
}

/** Writes each layer's level to its tint dot, at `LEVEL_RATE_HZ`, while `active`. */
function useLevelDots(
  panel: { current: HTMLElement | null },
  meter: LevelMeter | undefined,
  active: boolean,
): void {
  useEffect(() => {
    if (!meter || !active) {
      return undefined;
    }
    const dots = () =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-level-id]") ?? []);
    const stop = meter.watch();
    const timer = setInterval(() => {
      for (const dot of dots()) {
        const level = levelBrightness(meter.get(dot.dataset.levelId ?? ""));
        dot.style.setProperty("--level", level.toFixed(2));
      }
    }, 1000 / LEVEL_RATE_HZ);
    return () => {
      clearInterval(timer);
      stop();
      for (const dot of dots()) {
        dot.style.removeProperty("--level");
      }
    };
  }, [panel, meter, active]);
}

/**
 * "Add sound" and the list it opens: every sound not already in the mix, in
 * Featured order. Escape or a click elsewhere closes the list.
 */
function AddSound({
  available,
  full,
  open,
  hover,
  onOpenChange,
  onAdd,
}: {
  available: readonly SoundEntry[];
  full: boolean;
  open: boolean;
  hover: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (id: string) => void;
}): JSX.Element {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const shown = open && !full;
  useEffect(() => {
    if (!shown) {
      return undefined;
    }
    ref.current?.querySelector<HTMLElement>(".add-list button, .add-list .hint")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
        ref.current?.querySelector<HTMLElement>(".add-button")?.focus();
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
  }, [shown, onOpenChange]);
  return (
    <div ref={ref} className="add-sound">
      <button
        type="button"
        className="add-button"
        aria-expanded={shown}
        aria-controls={`${id}-list`}
        aria-describedby={full ? `${id}-full` : undefined}
        disabled={full}
        title={hover ? "Add sound (/)" : "Add sound"}
        onClick={() => {
          onOpenChange(!shown);
        }}
      >
        <PlusIcon />
        Add sound
      </button>
      {full && (
        <p id={`${id}-full`} className="hint add-full">
          {FULL_MIX_HINT}
        </p>
      )}
      <ul id={`${id}-list`} className="add-list" aria-label="Sounds to add" hidden={!shown}>
        {available.map((sound) => (
          <li key={sound.id}>
            <button
              type="button"
              onClick={() => {
                onAdd(sound.id);
              }}
            >
              <span className="layer-dot" style={{ "--tint": sound.tint }} aria-hidden="true" />
              {sound.name}
            </button>
          </li>
        ))}
        {available.length === 0 && (
          <li className="hint" tabIndex={-1}>
            Every sound is already in the mix.
          </li>
        )}
      </ul>
    </div>
  );
}

/** The master volume slider and the button that mutes everything. */
function MasterVolume({
  value,
  muted,
  hover,
  onChange,
  onMutedChange,
}: {
  value: number;
  muted: boolean;
  hover: boolean;
  onChange: (value: number) => void;
  onMutedChange: (muted: boolean) => void;
}): JSX.Element {
  const label = muted ? "Unmute everything" : "Mute everything";
  const position = (value - MASTER_PARAM.min) / (MASTER_PARAM.max - MASTER_PARAM.min);
  return (
    <div className="master-row" data-muted={muted}>
      <button
        type="button"
        className="icon-button"
        aria-label="Mute everything"
        aria-pressed={muted}
        title={hover ? `${label} (M)` : label}
        onClick={() => {
          onMutedChange(!muted);
        }}
      >
        {muted ? <SpeakerMutedIcon /> : <SpeakerIcon />}
      </button>
      <input
        type="range"
        aria-label={MASTER_PARAM.label}
        title={hover ? `${MASTER_PARAM.label} (↑ ↓)` : MASTER_PARAM.label}
        style={{ "--p": `${String(position * 100)}%` }}
        min={MASTER_PARAM.min}
        max={MASTER_PARAM.max}
        step={MASTER_PARAM.step}
        value={value}
        onInput={(event) => {
          const next = Number(event.currentTarget.value);
          if (next !== value) {
            onChange(next);
          }
        }}
      />
      <span className="control-value master-value">{value}</span>
    </div>
  );
}

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
  onAddLayer: (id: string) => void;
  preferences: Preferences;
  /** Whether the main pointer can hover: shortcut hints and the popover show only then. */
  hover: boolean;
  onLayerChange: (id: string, change: Partial<Omit<Layer, "id">>) => void;
  onParamChange: (id: string, key: string, value: ParamValue) => void;
  onMasterChange: (master: number) => void;
  /** Muting everything is kept in memory only. */
  masterMuted: boolean;
  onMasterMutedChange: (muted: boolean) => void;
  /** The soloed layers. Solo is kept in memory only. */
  solo: ReadonlySet<string>;
  onToggleSolo: (id: string) => void;
  onClearSolo: () => void;
  onResetAll: () => void;
  onCopyLink: () => void;
  /** Absent when the browser can't go fullscreen. */
  onFullscreen: (() => void) | undefined;
  onHide: () => void;
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  /** Reads the layers' levels for the tint dots. */
  levels?: LevelMeter | undefined;
  /** Whether the dots should follow the levels: only while the panel is seen and playing. */
  levelsActive?: boolean | undefined;
  /** Every sound, in Featured order: the registry, or a stand-in in tests. */
  sounds?: readonly SoundEntry[] | undefined;
  /** The Display settings; the section shows only when they are given. */
  display?: DisplaySettings | undefined;
  onDisplayChange?: ((settings: DisplaySettings) => void) | undefined;
}

/** The Display section: how the backdrop looks on this device. Starts collapsed. */
function DisplaySection({
  settings,
  preferences,
  onChange,
}: {
  settings: DisplaySettings;
  preferences: Preferences;
  onChange: (settings: DisplaySettings) => void;
}): JSX.Element {
  const [open, setOpen] = useState(() => preferences.get(DISPLAY_OPEN_KEY) === "1");
  return (
    <Section
      title="Display"
      className="display-section"
      open={open}
      onToggle={() => {
        setOpen(!open);
        preferences.set(DISPLAY_OPEN_KEY, open ? "0" : "1");
      }}
      changed={countChanged(DISPLAY_PARAMS, settings)}
    >
      {DISPLAY_KEYS.map((key) => {
        const def = DISPLAY_PARAMS[key];
        return (
          <ParamControl
            key={key}
            id={`display-${key}`}
            def={def}
            value={settings[key]}
            onChange={(value) => {
              onChange({ ...settings, [key]: value });
            }}
            onReset={() => {
              onChange({ ...settings, [key]: def.default });
            }}
          />
        );
      })}
    </Section>
  );
}

/** The control panel card: header and toolbar, one row per layer, Add sound, and the footer. */
export function ControlPanel(props: ControlPanelProps): JSX.Element {
  const { mix, preferences, hover, solo } = props;
  const catalogue = props.sounds ?? registry;
  const panelRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState(() => preferences.getSet(CLOSED_KEY));
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const saveClosed = (next: Set<string>) => {
    setClosed(next);
    preferences.setSet(CLOSED_KEY, next);
  };
  const toggle = (key: string) => {
    const next = new Set(closed);
    if (!next.delete(key)) {
      next.add(key);
    }
    saveClosed(next);
  };
  const hint = (title: string, key: string) => (hover ? `${title} (${key})` : title);

  useLevelDots(panelRef, props.levels, props.levelsActive === true);

  // Moves focus once the layer it should go to has rendered.
  useEffect(() => {
    if (focusTarget === null) {
      return;
    }
    const element =
      focusTarget === "add"
        ? panelRef.current?.querySelector<HTMLElement>(".add-button")
        : document.getElementById(layerNameId(focusTarget.layer));
    if (element) {
      element.focus();
      setFocusTarget(null);
    }
  }, [focusTarget, mix.layers]);

  const inMix = new Set(mix.layers.map((l) => l.id));
  const available = catalogue.filter((s) => !inMix.has(s.id));
  const full = mix.layers.length >= MAX_LAYERS;
  const soloActive = mix.layers.some((l) => solo.has(l.id));

  const add = (id: string) => {
    // The new layer starts open and the others close, so the new one is in view.
    const next = new Set(closed);
    for (const layer of mix.layers) {
      next.add(layer.id);
    }
    next.delete(id);
    saveClosed(next);
    props.onAddOpenChange(false);
    props.onAddLayer(id);
    setFocusTarget({ layer: id });
  };

  const remove = (id: string) => {
    const index = mix.layers.findIndex((l) => l.id === id);
    const after = index === -1 ? undefined : mix.layers.at(index + 1);
    setFocusTarget(after ? { layer: after.id } : "add");
    props.onRemoveLayer(id);
  };

  const empty = mix.layers.length === 0;
  // An empty mix has nothing to play; a playing one can still be paused.
  const playDisabled = empty && !isPlaying(props.engineState);

  return (
    <div ref={panelRef} className="panel">
      <header className="panel-header">
        <div className="panel-header-row">
          <PlayButton
            state={props.engineState}
            hover={hover}
            disabled={playDisabled}
            onToggle={props.onTogglePlay}
          />
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
        <MasterVolume
          value={mix.master}
          muted={props.masterMuted}
          hover={hover}
          onChange={props.onMasterChange}
          onMutedChange={props.onMasterMutedChange}
        />
        {soloActive && (
          <div className="solo-bar">
            <span>Solo</span>
            <button type="button" className="text-button" onClick={props.onClearSolo}>
              Clear solo
            </button>
          </div>
        )}
        {props.engineState === "failed" && (
          <p className="audio-error" role="alert">
            Audio isn't available in this browser.
          </p>
        )}
      </header>
      <div className="panel-body">
        {empty && <p className="hint">Add a sound to start</p>}
        {mix.layers.flatMap((layer, index) => {
          const sound = catalogue.find((s) => s.id === layer.id);
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
              index={index}
              hover={hover}
              status={props.layerStates[layer.id]}
              soloed={solo.has(layer.id)}
              onRetry={() => {
                props.onRetryLayer(layer.id);
              }}
              onRemove={() => {
                remove(layer.id);
              }}
              onToggleMute={() => {
                props.onLayerChange(layer.id, { muted: !layer.muted });
              }}
              onToggleSolo={() => {
                props.onToggleSolo(layer.id);
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
        <AddSound
          available={available}
          full={full}
          open={props.addOpen}
          hover={hover}
          onOpenChange={props.onAddOpenChange}
          onAdd={add}
        />
        {props.display && props.onDisplayChange && (
          <DisplaySection
            settings={props.display}
            preferences={preferences}
            onChange={props.onDisplayChange}
          />
        )}
      </div>
      <footer className="panel-footer">
        <div className="footer-actions">
          <button
            type="button"
            className="text-button"
            title="Put every layer's settings and volume, and the master volume, back to their defaults"
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
