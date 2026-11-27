import type { JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createAudioEngine,
  isPlaying,
  type AudioEngine,
  type EngineState,
  type LayerState,
} from "./audio/engine";
import { tintWeights } from "./backdrop/colours";
import { loadDisplay } from "./backdrop/settings";
import { Backdrop, type MasterMeter } from "./components/Backdrop";
import { ControlPanel, FULL_MIX_HINT, type LevelMeter } from "./components/ControlPanel";
import { PlayIcon, SlidersIcon } from "./components/icons";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { PLAY_TOGGLE_ATTRIBUTE } from "./components/PlayButton";
import { useExternalStore } from "./hooks/useExternalStore";
import { useIdle, useTouchPointer } from "./hooks/useIdle";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { copyText } from "./lib/clipboard";
import { createPreferences, type Preferences } from "./lib/preferences";
import { createStore } from "./lib/store";
import {
  defaultLayer,
  MASTER_PARAM,
  MAX_LAYERS,
  parseHash,
  serialiseHash,
  VOLUME_PARAM,
  type HashState,
  type Layer,
} from "./mixes/mix";
import type { SoundLoader } from "./sounds/loader";
import { defaults } from "./sounds/params";
import { DEFAULT_SOUND_ID, sounds as registry, type SoundEntry } from "./sounds/registry";
import type { ParamValue } from "./sounds/types";

/** The panel and cursor fade after this long without input. */
export const IDLE_MS = 3000;
/** Hash writes wait this long after the last change, so dragging a slider writes once. */
export const HASH_DEBOUNCE_MS = 250;
export const TOAST_MS = 2500;
/** "Removed <name>" stays up this long, so there's time to press Undo. */
export const UNDO_TOAST_MS = 5000;
/** How far ↑ and ↓ move the master volume. */
const MASTER_STEP = 5;

interface Toast {
  id: number;
  message: string;
  /** A button in the toast, such as Undo. */
  action: { label: string; run: () => void } | undefined;
  duration: number;
}

/** Whether a key press belongs to a form field rather than to the shortcuts. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

/** Whether a Space press on `target` already does something there (presses a button, types). */
function spaceIsTaken(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return target.type !== "range";
  }
  return (
    isTyping(target) ||
    (target instanceof HTMLElement && target.closest("button, a[href], summary") !== null)
  );
}

/** Whether an input event landed on a control that toggles playback itself. */
function onPlayToggle(event: Event): boolean {
  return (
    (event instanceof KeyboardEvent && event.key === " ") ||
    (event.target instanceof Element && event.target.closest(`[${PLAY_TOGGLE_ATTRIBUTE}]`) !== null)
  );
}

/** Whether a key press has no focused control to go to, so arrow keys are free for shortcuts. */
function nothingFocused(target: EventTarget | null): boolean {
  return (
    !(target instanceof Element) || target === document.body || target === document.documentElement
  );
}

/** The layer number (1–8) a key press names, from the key's position so Shift doesn't change it. */
function layerNumber(event: KeyboardEvent): number | undefined {
  const digit = /^(?:Digit|Numpad)([1-8])$/.exec(event.code)?.[1] ?? /^[1-8]$/.exec(event.key)?.[0];
  return digit === undefined ? undefined : Number(digit);
}

/** Input events that count as a user gesture, which lets a blocked context start. */
const GESTURES = ["pointerdown", "pointerup", "keydown"] as const;

/** What the engine reports, for the UI. */
interface Playback {
  state: EngineState;
  layers: Readonly<Record<string, LayerState>>;
}

type EngineCallbacks = Pick<Parameters<typeof createAudioEngine>[0], "onState" | "onLayerState">;

/** Makes the app's engine; tests pass a stand-in. */
export type EngineFactory = (callbacks: EngineCallbacks) => AudioEngine;

function browserEngine(loader: SoundLoader): EngineFactory {
  return (callbacks) =>
    createAudioEngine({
      // The "playback" latency hint picks a larger buffer, which saves power.
      createContext: () => new AudioContext({ latencyHint: "playback" }),
      loader,
      ...callbacks,
    });
}

function fullscreenAvailable(): boolean {
  // Missing in some browsers (older iOS Safari), whatever the DOM types say.
  return (document.fullscreenEnabled as boolean | undefined) === true;
}

interface AppProps {
  /** The state read from the URL hash at start-up. */
  initial: HashState;
  loader: SoundLoader;
  preferences?: Preferences;
  createEngine?: EngineFactory;
  /** Every sound, in Featured order: the registry, or a stand-in in tests. */
  sounds?: readonly SoundEntry[] | undefined;
  /** The sound a hash without `layers` holds. */
  defaultSoundId?: string;
}

export function App({
  initial,
  loader,
  preferences: givenPreferences,
  createEngine,
  sounds = registry,
  defaultSoundId = DEFAULT_SOUND_ID,
}: AppProps): JSX.Element {
  const [state, setState] = useState(initial);
  const [solo, setSolo] = useState<ReadonlySet<string>>(() => new Set());
  const [masterMuted, setMasterMuted] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const [preferences] = useState(() => givenPreferences ?? createPreferences());
  const [toast, setToast] = useState<Toast | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [overPanel, setOverPanel] = useState(false);
  const [canFullscreen] = useState(fullscreenAvailable);
  const hover = useMediaQuery("(hover: hover)");
  const idle = useIdle(IDLE_MS);
  const touch = useTouchPointer();

  const [playback] = useState(() => createStore<Playback>({ state: "idle", layers: {} }));
  const [engine] = useState(() =>
    (createEngine ?? browserEngine(loader))({
      onState: (engineState) => {
        playback.set({ ...playback.get(), state: engineState });
      },
      onLayerState: (id, layerState) => {
        const current = playback.get();
        playback.set({ ...current, layers: { ...current.layers, [id]: layerState } });
      },
    }),
  );
  const { state: engineState, layers: layerStates } = useExternalStore(
    playback.subscribe,
    playback.get,
  );

  useEffect(
    () => () => {
      engine.dispose();
    },
    [engine],
  );

  useEffect(() => {
    engine.setMix(state.mix);
  }, [engine, state.mix]);

  useEffect(() => {
    engine.setSolo(solo);
  }, [engine, solo]);

  useEffect(() => {
    engine.setMasterMuted(masterMuted);
  }, [engine, masterMuted]);

  const levels = useMemo<LevelMeter>(
    () => ({ watch: engine.watchLevels, get: engine.getLevel }),
    [engine],
  );

  const [display] = useState(() => loadDisplay(preferences));
  const masterLevel = useMemo<MasterMeter>(
    () => ({ watch: engine.watchMasterLevel, get: engine.getMasterLevel }),
    [engine],
  );
  const tints = useMemo(() => new Map(sounds.map((s) => [s.id, s.tint])), [sounds]);
  const backdropTints = useMemo(
    () => tintWeights(state.mix, tints, solo, masterMuted),
    [state.mix, tints, solo, masterMuted],
  );

  // A fresh visit or a shared link starts playing. If the browser blocks that, the
  // first tap, click or key press anywhere starts it instead.
  useEffect(() => {
    let active = true;
    const onGesture = (event: Event) => {
      if (playback.get().state !== "blocked") {
        stopListening();
      } else if (!onPlayToggle(event)) {
        void engine.play();
      }
    };
    const stopListening = () => {
      for (const type of GESTURES) {
        window.removeEventListener(type, onGesture, true);
      }
    };
    const autoplay = async () => {
      // An empty mix has nothing to play: wait for the Play button instead.
      if (stateRef.current.mix.layers.length === 0) {
        return;
      }
      const result = await engine.play();
      if (active && result === "blocked") {
        for (const type of GESTURES) {
          window.addEventListener(type, onGesture, true);
        }
      }
    };
    void autoplay();
    return () => {
      active = false;
      stopListening();
    };
  }, [engine, playback]);

  const togglePlay = useCallback(() => {
    if (isPlaying(playback.get().state)) {
      engine.pause();
    } else if (stateRef.current.mix.layers.length > 0) {
      void engine.play();
    }
  }, [engine, playback]);

  // State → hash, debounced. replaceState keeps edits out of the back button's history.
  useEffect(() => {
    const timer = setTimeout(() => {
      const hash = serialiseHash(state, {}, sounds);
      if (window.location.hash !== hash) {
        const url = new URL(window.location.href);
        url.hash = hash;
        window.history.replaceState(window.history.state, "", url.href);
      }
    }, HASH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state, sounds]);

  // Hash → state, for edited or pasted hashes. One that matches the state is skipped.
  useEffect(() => {
    const onHashChange = () => {
      const next = parseHash(window.location.hash, sounds, defaultSoundId);
      if (serialiseHash(next, {}, sounds) !== serialiseHash(stateRef.current, {}, sounds)) {
        setState(next);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [sounds, defaultSoundId]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setToast(null);
    }, toast.duration);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  const showToast = useCallback(
    (message: string, action?: Toast["action"], duration = action ? UNDO_TOAST_MS : TOAST_MS) => {
      setToast((t) => ({ id: (t?.id ?? 0) + 1, message, action, duration }));
    },
    [],
  );

  const setPanelHidden = useCallback((panelHidden: boolean) => {
    setState((s) => ({ ...s, panelHidden }));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const fail = () => {
      showToast("Fullscreen unavailable");
    };
    try {
      const result = document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen();
      result.catch(fail);
    } catch {
      fail();
    }
  }, [showToast]);

  const copyLink = useCallback(() => {
    const url = new URL(window.location.href);
    url.hash = serialiseHash({ ...stateRef.current, panelHidden: true }, { full: true }, sounds);
    void copyText(url.href).then((ok) => {
      showToast(ok ? "Link copied" : "Couldn't copy the link");
      return undefined;
    });
  }, [showToast, sounds]);

  const updateLayer = useCallback((id: string, change: (layer: Layer) => Layer) => {
    setState((s) => ({
      ...s,
      mix: { ...s.mix, layers: s.mix.layers.map((l) => (l.id === id ? change(l) : l)) },
    }));
  }, []);

  const onLayerChange = useCallback(
    (id: string, change: Partial<Omit<Layer, "id">>) => {
      updateLayer(id, (l) => ({ ...l, ...change }));
    },
    [updateLayer],
  );

  const onParamChange = useCallback(
    (id: string, key: string, value: ParamValue) => {
      updateLayer(id, (l) => ({ ...l, params: { ...l.params, [key]: value } }));
    },
    [updateLayer],
  );

  const onAddLayer = useCallback(
    (id: string) => {
      const sound = sounds.find((s) => s.id === id);
      if (!sound) {
        return;
      }
      setState((s) =>
        s.mix.layers.length >= MAX_LAYERS || s.mix.layers.some((l) => l.id === id)
          ? s
          : { ...s, mix: { ...s.mix, layers: [...s.mix.layers, defaultLayer(sound)] } },
      );
    },
    [sounds],
  );

  /** Puts a removed layer back where it was, unless its sound is back already or the mix is full. */
  const restoreLayer = useCallback((layer: Layer, index: number) => {
    setState((s) => {
      const { layers } = s.mix;
      if (layers.length >= MAX_LAYERS || layers.some((l) => l.id === layer.id)) {
        return s;
      }
      const next = [...layers];
      next.splice(Math.min(index, next.length), 0, layer);
      return { ...s, mix: { ...s.mix, layers: next } };
    });
  }, []);

  const onRemoveLayer = useCallback(
    (id: string) => {
      const { layers } = stateRef.current.mix;
      const index = layers.findIndex((l) => l.id === id);
      const layer = index === -1 ? undefined : layers.at(index);
      if (!layer) {
        return;
      }
      setState((s) => ({
        ...s,
        mix: { ...s.mix, layers: s.mix.layers.filter((l) => l.id !== id) },
      }));
      setSolo((current) => {
        if (!current.has(id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      const name = sounds.find((s) => s.id === id)?.name ?? id;
      showToast(`Removed ${name}`, {
        label: "Undo",
        run: () => {
          restoreLayer(layer, index);
        },
      });
    },
    [restoreLayer, showToast, sounds],
  );

  const onToggleSolo = useCallback((id: string) => {
    setSolo((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const onClearSolo = useCallback(() => {
    setSolo(new Set());
  }, []);

  const onMasterChange = useCallback((master: number) => {
    setState((s) => ({ ...s, mix: { ...s.mix, master } }));
  }, []);

  const toggleMute = useCallback((index: number) => {
    setState((s) => {
      const target = s.mix.layers.at(index);
      if (!target) {
        return s;
      }
      const layers = s.mix.layers.map((l) => (l === target ? { ...l, muted: !l.muted } : l));
      return { ...s, mix: { ...s.mix, layers } };
    });
  }, []);

  const onRetryLayer = useCallback(
    (id: string) => {
      engine.retry(id);
    },
    [engine],
  );

  const onResetAll = useCallback(() => {
    setState((s) => ({
      ...s,
      mix: {
        ...s.mix,
        master: MASTER_PARAM.default,
        layers: s.mix.layers.map((l) => {
          const sound = sounds.find((entry) => entry.id === l.id);
          return {
            ...l,
            volume: VOLUME_PARAM.default,
            params: sound ? defaults(sound.params) : l.params,
          };
        }),
      },
    }));
  }, [sounds]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === " ") {
        if (!spaceIsTaken(event.target)) {
          event.preventDefault();
          togglePlay();
        }
        return;
      }
      if (isTyping(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      const number = layerNumber(event);
      if (number !== undefined) {
        const layer = stateRef.current.mix.layers.at(number - 1);
        if (event.shiftKey && layer) {
          onToggleSolo(layer.id);
        } else if (!event.shiftKey) {
          toggleMute(number - 1);
        }
      } else if (event.key === "/") {
        event.preventDefault();
        setPanelHidden(false);
        if (stateRef.current.mix.layers.length >= MAX_LAYERS) {
          showToast(FULL_MIX_HINT);
        } else {
          setAddOpen(true);
        }
      } else if (key === "m") {
        setMasterMuted((muted) => !muted);
      } else if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        nothingFocused(event.target)
      ) {
        event.preventDefault();
        const step = event.key === "ArrowUp" ? MASTER_STEP : -MASTER_STEP;
        setState((s) => {
          const master = Math.min(
            MASTER_PARAM.max,
            Math.max(MASTER_PARAM.min, s.mix.master + step),
          );
          return master === s.mix.master ? s : { ...s, mix: { ...s.mix, master } };
        });
      } else if (key === "h") {
        setPanelHidden(!stateRef.current.panelHidden);
      } else if (key === "f" && canFullscreen) {
        toggleFullscreen();
      } else if (event.key === "?" && hover) {
        setPanelHidden(false);
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [
    canFullscreen,
    hover,
    onToggleSolo,
    setPanelHidden,
    showToast,
    toggleFullscreen,
    toggleMute,
    togglePlay,
  ]);

  // The panel fades with the cursor when idle, except on touch (there's no pointer
  // to bring it back) and while the pointer rests on it.
  const fade = idle && !touch && !overPanel;
  const { panelHidden } = state;

  return (
    <div className="app" data-idle={fade} data-backdrop={display.backdrop}>
      <Backdrop
        mode={display.backdrop}
        brightness={display.brightness}
        respond={display.respond}
        tints={backdropTints}
        playing={engineState === "playing"}
        level={masterLevel}
      />
      <PanelErrorBoundary>
        <div
          className="panel-wrap"
          data-visible={!panelHidden && !fade}
          inert={panelHidden}
          onPointerEnter={() => {
            setOverPanel(true);
          }}
          onPointerLeave={() => {
            setOverPanel(false);
          }}
        >
          <ControlPanel
            mix={state.mix}
            engineState={engineState}
            layerStates={layerStates}
            onTogglePlay={togglePlay}
            onRetryLayer={onRetryLayer}
            onRemoveLayer={onRemoveLayer}
            onAddLayer={onAddLayer}
            preferences={preferences}
            hover={hover}
            onLayerChange={onLayerChange}
            onParamChange={onParamChange}
            onMasterChange={onMasterChange}
            masterMuted={masterMuted}
            onMasterMutedChange={setMasterMuted}
            solo={solo}
            onToggleSolo={onToggleSolo}
            onClearSolo={onClearSolo}
            onResetAll={onResetAll}
            onCopyLink={copyLink}
            onFullscreen={canFullscreen ? toggleFullscreen : undefined}
            onHide={() => {
              setPanelHidden(true);
            }}
            shortcutsOpen={shortcutsOpen}
            onShortcutsOpenChange={setShortcutsOpen}
            addOpen={addOpen}
            onAddOpenChange={setAddOpen}
            levels={levels}
            levelsActive={!panelHidden && !fade && engineState === "playing"}
            sounds={sounds}
          />
        </div>
      </PanelErrorBoundary>
      {engineState === "blocked" && panelHidden && (
        <button
          type="button"
          className="play-prompt play-blocked"
          onClick={togglePlay}
          {...{ [PLAY_TOGGLE_ATTRIBUTE]: true }}
        >
          <PlayIcon />
          Tap to play
        </button>
      )}
      {toast && (
        <div
          key={toast.id}
          className="toast"
          role="status"
          data-action={toast.action !== undefined}
        >
          {toast.message}
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                toast.action?.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className="show-panel"
        data-visible={panelHidden && !fade}
        aria-label="Show controls"
        title={hover ? "Show controls (H)" : "Show controls"}
        onClick={() => {
          setPanelHidden(false);
        }}
      >
        <SlidersIcon />
      </button>
    </div>
  );
}
