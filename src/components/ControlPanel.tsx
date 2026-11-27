import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { isPlaying, type EngineState, type LayerState } from "../audio/engine";
import { MASTER_PARAM, MAX_LAYERS, type Layer, type Mix } from "../mixes/mix";
import { DISPLAY_PARAMS, type DisplaySettings } from "../backdrop/settings";
import type { Preferences } from "../lib/preferences";
import { sounds as registry, type SoundEntry } from "../sounds/registry";
import type { ParamValue } from "../sounds/types";
import { BottomSheet } from "./BottomSheet";
import {
  ChevronIcon,
  FullscreenIcon,
  HideIcon,
  LinkIcon,
  MixesIcon,
  PlusIcon,
  SpeakerIcon,
  SpeakerMutedIcon,
} from "./icons";
import { LayerSection } from "./LayerSection";
import { ParamControl } from "./ParamControl";
import { countChanged } from "./sections";
import { Section } from "./Section";
import { FULL_MIX_HINT, layerNameId, levelBrightness, mixSummary } from "./mixer";

import type { PanelLayout } from "./sheet";
import { MixesView, type MixesControls } from "./MixesView";
import { SoundList } from "./SoundList";
import { PlayButton } from "./PlayButton";
import { SleepTimer, type SleepTimerControls } from "./SleepTimer";
import { formatCountdown } from "../lib/sleep-timer";
import { Slider } from "./Slider";

/** The preference holding collapsed sections: "<sound>" for a layer, "<sound>/<section>" inside one. */
const CLOSED_KEY = "closedSections";
/** The preference that is "1" while the Display section is open; it starts closed. */
const DISPLAY_OPEN_KEY = "displayOpen";
/** The Display section's controls, in order. */
const DISPLAY_KEYS = [
  "backdrop",
  "brightness",
  "respond",
  "keepAwake",
] as const satisfies readonly (keyof DisplaySettings)[];
/** The controls in the Display section's Advanced part, collapsed until opened. */
const ADVANCED_DISPLAY_KEYS = ["audioOutput"] as const satisfies readonly (keyof DisplaySettings)[];

/** Every keyboard shortcut, as shown in the popover. */
const SHORTCUTS: readonly (readonly [key: string, action: string])[] = [
  ["Space", "Play or pause"],
  ["/", "Add a sound"],
  ["P", "Presets and saved mixes"],
  ["S", "Star the focused sound"],
  ["1–8", "Mute or unmute layer N"],
  ["Shift+1–8", "Solo or unsolo layer N"],
  ["M", "Mute or unmute everything"],
  ["↑ ↓", "Master volume up or down"],
  ["H", "Hide or show the panel"],
  ["F", "Toggle fullscreen"],
  ["D", "Backdrop: Glow, Night or Off"],
  ["T", "Sleep timer: Off, 15, 30, 60 or 90 min"],
  ["?", "Show these shortcuts"],
];

/** How often the tint dots read the layers' levels, in Hz. */
export const LEVEL_RATE_HZ = 15;

const NO_FAVOURITES: ReadonlySet<string> = new Set();

/** Where focus goes after the layers change or a view closes: a layer's name, Add sound, or Mixes. */
type FocusTarget = { layer: string } | "add" | "mixes";

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

/** "(edited)", after a named mix's name once it has been changed. */
function EditedMark({ edited, className }: { edited: boolean; className: string }) {
  return edited ? <span className={className}> (edited)</span> : null;
}

/** "Add sound", which opens the sound picker, and a note once the mix is full. */
function AddSound({
  full,
  open,
  hover,
  onOpen,
}: {
  full: boolean;
  open: boolean;
  hover: boolean;
  onOpen: () => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="add-sound">
      <button
        type="button"
        className="add-button"
        aria-expanded={open}
        aria-describedby={full ? `${id}-full` : undefined}
        title={hover ? "Add sound (/)" : "Add sound"}
        onClick={onOpen}
      >
        <PlusIcon />
        Add sound
      </button>
      {full && (
        <p id={`${id}-full`} className="hint add-full">
          {FULL_MIX_HINT}
        </p>
      )}
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
      <Slider
        label={MASTER_PARAM.label}
        title={hover ? `${MASTER_PARAM.label} (↑ ↓)` : MASTER_PARAM.label}
        position={position}
        min={MASTER_PARAM.min}
        max={MASTER_PARAM.max}
        step={MASTER_PARAM.step}
        value={value}
        onValue={(next) => {
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
  /** Whether a named mix has been changed since it was loaded or saved. */
  edited?: boolean | undefined;
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
  /** Whether the sound picker has taken over the panel. */
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  /** The starred sound ids. */
  favourites?: ReadonlySet<string> | undefined;
  onToggleFavourite?: ((id: string) => void) | undefined;
  /** Starts loading a sound's code, when the picker expects it to be added. */
  onPrefetch?: ((sound: SoundEntry) => void) | undefined;
  /** Reads the layers' levels for the tint dots. */
  levels?: LevelMeter | undefined;
  /** Whether the dots should follow the levels: only while the panel is seen and playing. */
  levelsActive?: boolean | undefined;
  /** Every sound, in Featured order: the registry, or a stand-in in tests. */
  sounds?: readonly SoundEntry[] | undefined;
  /** The Display settings; the section shows only when they are given. */
  display?: DisplaySettings | undefined;
  onDisplayChange?: ((settings: DisplaySettings) => void) | undefined;
  /** Whether the browser can keep the screen on (the Screen Wake Lock API). */
  wakeLock?: boolean | undefined;
  /** How the panel is laid out for the screen; a floating card by default. */
  layout?: PanelLayout | undefined;
  /** Whether the bottom sheet is expanded. The sound picker expands it too. */
  sheetOpen?: boolean | undefined;
  onSheetOpenChange?: ((open: boolean) => void) | undefined;
  /** The sleep timer; its clock button shows only when it is given. */
  sleep?: SleepTimerControls | undefined;
  /** The presets and saved mixes; the Mixes button shows only when they are given. */
  mixes?: MixesControls | undefined;
}

/** The Display section: how the backdrop looks on this device. Starts collapsed. */
function DisplaySection({
  settings,
  preferences,
  onChange,
  wakeLock,
}: {
  settings: DisplaySettings;
  preferences: Preferences;
  onChange: (settings: DisplaySettings) => void;
  /** Whether the browser can keep the screen on; Keep screen on shows only where it can. */
  wakeLock: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(() => preferences.get(DISPLAY_OPEN_KEY) === "1");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const control = (key: keyof DisplaySettings) => {
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
  };
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
      {DISPLAY_KEYS.filter((key) => key !== "keepAwake" || wakeLock).map((key) => control(key))}
      <Section
        title="Advanced"
        className="display-advanced"
        open={advancedOpen}
        onToggle={() => {
          setAdvancedOpen(!advancedOpen);
        }}
        changed={countChanged(DISPLAY_PARAMS, settings, ADVANCED_DISPLAY_KEYS)}
      >
        {ADVANCED_DISPLAY_KEYS.map((key) => control(key))}
        <p className="display-note">
          Media element keeps sound playing on a locked phone and shows lock-screen controls. Direct
          has less delay. A change applies once the page is reloaded.
        </p>
      </Section>
    </Section>
  );
}

/** The control panel card: header and toolbar, one row per layer, Add sound, and the footer. */
export function ControlPanel(props: ControlPanelProps): JSX.Element {
  const { mix, preferences, hover, solo } = props;
  const edited = mix.name !== undefined && props.edited === true;
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

  const layout = props.layout ?? "card";
  const sheet = layout === "sheet";
  const mixesOpen = props.mixes?.open === true;
  /** Whether the sound picker or the Mixes view has taken over the panel. */
  const takeover = props.addOpen || mixesOpen;
  // Collapsed, the sheet shows only its peek bar.
  const expanded = !sheet || props.sheetOpen === true || takeover;

  useLevelDots(panelRef, props.levels, props.levelsActive === true && expanded);

  // Moves focus once the layer it should go to has rendered.
  useEffect(() => {
    if (focusTarget === null) {
      return;
    }
    const element =
      focusTarget === "add" || focusTarget === "mixes"
        ? panelRef.current?.querySelector<HTMLElement>(
            focusTarget === "add" ? ".add-button" : ".mixes-button",
          )
        : document.getElementById(layerNameId(focusTarget.layer));
    if (element) {
      element.focus();
      setFocusTarget(null);
    }
  }, [focusTarget, mix.layers, props.addOpen, mixesOpen]);

  const inMix = new Set(mix.layers.map((l) => l.id));
  const full = mix.layers.length >= MAX_LAYERS;
  const soloActive = mix.layers.some((l) => solo.has(l.id));

  /** Adds a sound; unless `keepOpen`, the picker closes and focus moves to the new row. */
  const add = (id: string, keepOpen = false) => {
    // The new layer starts open and the others close, so the new one is in view.
    const next = new Set(closed);
    for (const layer of mix.layers) {
      next.add(layer.id);
    }
    next.delete(id);
    saveClosed(next);
    props.onAddLayer(id);
    if (!keepOpen) {
      props.onAddOpenChange(false);
      setFocusTarget({ layer: id });
    }
  };

  const closePicker = (target: FocusTarget) => {
    props.onAddOpenChange(false);
    setFocusTarget(target);
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

  const setSheetOpen = (open: boolean) => {
    if (!open && props.addOpen) {
      props.onAddOpenChange(false);
    }
    if (!open && mixesOpen) {
      props.mixes?.onOpenChange(false);
    }
    props.onSheetOpenChange?.(open);
  };
  const openPicker = () => {
    if (sheet) {
      props.onSheetOpenChange?.(true);
    }
    if (mixesOpen) {
      props.mixes?.onOpenChange(false);
    }
    props.onAddOpenChange(true);
  };
  const toggleMixes = () => {
    if (mixesOpen) {
      props.mixes?.onOpenChange(false);
      return;
    }
    if (sheet) {
      props.onSheetOpenChange?.(true);
    }
    if (props.addOpen) {
      props.onAddOpenChange(false);
    }
    props.mixes?.onOpenChange(true);
  };

  const playButton = (
    <PlayButton
      state={props.engineState}
      hover={hover}
      disabled={playDisabled}
      onToggle={props.onTogglePlay}
    />
  );
  const sleepTimer = (showTime: boolean) =>
    props.sleep && (
      <SleepTimer
        {...props.sleep}
        hover={hover}
        showTime={showTime}
        onOpen={
          sheet
            ? () => {
                props.onSheetOpenChange?.(true);
              }
            : undefined
        }
      />
    );
  const toolbar = (
    <div className="panel-toolbar">
      {props.mixes && (
        <button
          type="button"
          className="icon-button mixes-button"
          aria-label="Mixes"
          aria-expanded={mixesOpen}
          title={hint("Mixes", "P")}
          onClick={toggleMixes}
        >
          <MixesIcon />
        </button>
      )}
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
  );

  const content = (
    <>
      {props.addOpen ? (
        <SoundList
          sounds={catalogue}
          inMix={inMix}
          full={full}
          favourites={props.favourites ?? NO_FAVOURITES}
          onToggleFavourite={(id) => {
            props.onToggleFavourite?.(id);
          }}
          preferences={preferences}
          hover={hover}
          onAdd={add}
          onFocusLayer={(id) => {
            closePicker({ layer: id });
          }}
          onClose={() => {
            closePicker("add");
          }}
          onPrefetch={props.onPrefetch}
        />
      ) : props.mixes && mixesOpen ? (
        <MixesView
          controls={props.mixes}
          hover={hover}
          onClose={() => {
            props.mixes?.onOpenChange(false);
            setFocusTarget("mixes");
          }}
        />
      ) : (
        <>
          <header className="panel-header">
            {/* In the sheet, Play and the toolbar live in the peek bar instead. */}
            {!sheet && (
              <div className="panel-header-row">
                {playButton}
                {sleepTimer(true)}
                <h1 className="panel-title">
                  {mix.name ?? "Aural Farm"}
                  <EditedMark edited={edited} className="panel-title-edited" />
                </h1>
                {toolbar}
              </div>
            )}
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
                  starred={props.favourites?.has(layer.id) === true}
                  onToggleStar={() => {
                    props.onToggleFavourite?.(layer.id);
                  }}
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
            <AddSound full={full} open={props.addOpen} hover={hover} onOpen={openPicker} />
            {props.display && props.onDisplayChange && (
              <DisplaySection
                settings={props.display}
                preferences={preferences}
                onChange={props.onDisplayChange}
                wakeLock={props.wakeLock === true}
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
        </>
      )}
    </>
  );

  if (sheet) {
    return (
      <BottomSheet
        panelRef={panelRef}
        open={expanded}
        onOpenChange={setSheetOpen}
        picker={takeover}
        bar={
          <div className="peek-bar">
            {playButton}
            {sleepTimer(false)}
            <p className="peek-summary">
              {mix.name ?? mixSummary(mix.layers, catalogue)}
              <EditedMark edited={edited} className="peek-edited" />
            </p>
            {props.sleep?.remaining !== undefined && (
              <span className="peek-countdown">{formatCountdown(props.sleep.remaining)}</span>
            )}
            {expanded ? (
              toolbar
            ) : (
              <button
                type="button"
                className="icon-button peek-add"
                aria-label="Add sound"
                title="Add sound"
                onClick={openPicker}
              >
                <PlusIcon />
              </button>
            )}
            <button
              type="button"
              className="icon-button peek-expand"
              aria-label={expanded ? "Collapse mixer" : "Expand mixer"}
              aria-expanded={expanded}
              title={expanded ? "Collapse mixer" : "Expand mixer"}
              onClick={() => {
                setSheetOpen(!expanded);
              }}
            >
              <ChevronIcon />
            </button>
          </div>
        }
      >
        {content}
      </BottomSheet>
    );
  }

  return (
    <div ref={panelRef} className="panel" data-layout={layout} data-picker={takeover}>
      {content}
    </div>
  );
}
