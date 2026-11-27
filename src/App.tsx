import type { JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createAudioEngine,
  isPlaying,
  type AudioEngine,
  type EngineState,
  type LayerState,
} from "./audio/engine";
import {
  chooseOutputRoute,
  detectOutputFeatures,
  pageOutputElement,
  preferPlaybackSession,
} from "./audio/output";
import { tintWeights } from "./backdrop/colours";
import {
  backdropLabel,
  loadDisplay,
  nextBackdrop,
  saveDisplay,
  type DisplaySettings,
} from "./backdrop/settings";
import { Backdrop, type MasterMeter } from "./components/Backdrop";
import { ControlPanel, type LevelMeter } from "./components/ControlPanel";
import { PlayIcon, SlidersIcon } from "./components/icons";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { PLAY_TOGGLE_ATTRIBUTE } from "./components/PlayButton";
import { pageTitle } from "./components/mixer";
import { usePanelLayout } from "./components/sheet";
import { useDocumentVisible } from "./hooks/useDocumentVisible";
import { useExternalStore } from "./hooks/useExternalStore";
import { useIdle, useTouchPointer } from "./hooks/useIdle";
import { useKeyboardInset } from "./hooks/useKeyboardInset";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { browserMediaSession, browserMetadata, useMediaSession } from "./hooks/useMediaSession";
import { useWakeLock } from "./hooks/useWakeLock";
import { copyText } from "./lib/clipboard";
import { createFavourites, type Favourites } from "./lib/favourites";
import { mediaTitle, type MediaSessionLike, type MetadataFactory } from "./lib/media-session";
import { createPreferences, type Preferences } from "./lib/preferences";
import {
  countdownDelay,
  loadSleepSettings,
  nextCycleMinutes,
  saveSleepSettings,
  timerLabel,
  type SleepSettings,
} from "./lib/sleep-timer";
import { createStore } from "./lib/store";
import { browserWakeLock, type WakeLockLike } from "./lib/wake-lock";
import {
  defaultLayer,
  MASTER_PARAM,
  MAX_LAYERS,
  parseHash,
  serialiseHash,
  VOLUME_PARAM,
  type HashState,
  type Layer,
  type Mix,
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

/** A mix as the full hash form writes it, to tell whether two mixes are the same. */
function mixKey(mix: Mix, sounds: readonly SoundEntry[]): string {
  return serialiseHash({ mix, panelHidden: false }, { full: true }, sounds);
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

/** Input types a key press can't type into, so letter shortcuts still apply on them. */
const KEYLESS_INPUTS: ReadonlySet<string> = new Set(["range", "checkbox", "radio", "button"]);

/** Whether a key press types text (or picks a select's option) where it lands. */
function typesText(target: EventTarget | null): boolean {
  return (
    isTyping(target) && !(target instanceof HTMLInputElement && KEYLESS_INPUTS.has(target.type))
  );
}

/** The sound id of the mixer row holding `target`, if any. */
function layerOf(target: EventTarget | null): string | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-layer-id]")?.dataset.layerId
    : undefined;
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

type EngineCallbacks = Pick<
  Parameters<typeof createAudioEngine>[0],
  "onState" | "onLayerState" | "onSleepEnd"
>;

/** A running sleep timer's length. Each start makes a new one, so a restart reads the time afresh. */
interface SleepRun {
  minutes: number;
}

/** Makes the app's engine; tests pass a stand-in. */
export type EngineFactory = (callbacks: EngineCallbacks) => AudioEngine;

function browserEngine(loader: SoundLoader, preferences: Preferences): EngineFactory {
  return (callbacks) =>
    createAudioEngine({
      createContext: () => {
        preferPlaybackSession();
        // The "playback" latency hint picks a larger buffer, which saves power.
        return new AudioContext({ latencyHint: "playback" });
      },
      // Read when the context is made, so a changed Audio output applies after a reload.
      mediaElement: () =>
        chooseOutputRoute(loadDisplay(preferences).audioOutput, detectOutputFeatures()) === "media"
          ? pageOutputElement()
          : undefined,
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
  /** The starred sounds; tests pass one backed by memory. */
  favourites?: Favourites;
  createEngine?: EngineFactory;
  /** Every sound, in Featured order: the registry, or a stand-in in tests. */
  sounds?: readonly SoundEntry[] | undefined;
  /** The sound a hash without `layers` holds. */
  defaultSoundId?: string;
  /** The lock screen's and media keys' controls; tests pass a fake. */
  mediaSession?: MediaSessionLike | undefined;
  mediaMetadata?: MetadataFactory | undefined;
  /** Keeps the screen on; tests pass a fake. */
  wakeLock?: WakeLockLike | undefined;
}

export function App({
  initial,
  loader,
  preferences: givenPreferences,
  favourites: givenFavourites,
  createEngine,
  sounds = registry,
  defaultSoundId = DEFAULT_SOUND_ID,
  mediaSession = browserMediaSession(),
  mediaMetadata = browserMetadata(),
  wakeLock = browserWakeLock(),
}: AppProps): JSX.Element {
  const [state, setState] = useState(initial);
  const [solo, setSolo] = useState<ReadonlySet<string>>(() => new Set());
  const [masterMuted, setMasterMuted] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // The bottom sheet starts collapsed to its peek bar.
  const [sheetOpen, setSheetOpen] = useState(false);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  // What a named mix was when it was loaded or saved; any other mix of that name is "edited".
  const [baseline, setBaseline] = useState(() => mixKey(initial.mix, sounds));
  const currentKey = useMemo(() => mixKey(state.mix, sounds), [state.mix, sounds]);
  const edited = state.mix.name !== undefined && currentKey !== baseline;
  const [preferences] = useState(() => givenPreferences ?? createPreferences());
  const [favourites] = useState(() => givenFavourites ?? createFavourites());
  const starred = useExternalStore(favourites.subscribe, favourites.get);
  const [toast, setToast] = useState<Toast | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [overPanel, setOverPanel] = useState(false);
  const [canFullscreen] = useState(fullscreenAvailable);
  const hover = useMediaQuery("(hover: hover)");
  const idle = useIdle(IDLE_MS);
  const touch = useTouchPointer();
  const layout = usePanelLayout();
  useKeyboardInset();

  // The sleep timer isn't in the hash and starts Off on every visit.
  const [sleep, setSleep] = useState<SleepRun | undefined>(undefined);
  const sleepRef = useRef(sleep);
  useLayoutEffect(() => {
    sleepRef.current = sleep;
  });
  const [sleepSettings, setSleepSettings] = useState(() => loadSleepSettings(preferences));
  const sleepSettingsRef = useRef(sleepSettings);
  useLayoutEffect(() => {
    sleepSettingsRef.current = sleepSettings;
  });
  const visible = useDocumentVisible();
  const [sleepRemaining, setSleepRemaining] = useState<number | undefined>(undefined);

  const [playback] = useState(() => createStore<Playback>({ state: "idle", layers: {} }));
  const [engine] = useState(() =>
    (createEngine ?? browserEngine(loader, preferences))({
      onState: (engineState) => {
        playback.set({ ...playback.get(), state: engineState });
      },
      onLayerState: (id, layerState) => {
        const current = playback.get();
        playback.set({ ...current, layers: { ...current.layers, [id]: layerState } });
      },
      onSleepEnd: () => {
        setSleep(undefined);
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

  // Before the autoplay below, so the first play fades in as set.
  useEffect(() => {
    engine.setPlayFadeIn(sleepSettings.fadeIn);
  }, [engine, sleepSettings.fadeIn]);

  // The countdown reads the audio clock, which stands still while paused. It
  // updates when its text would change: each minute, then each second in the last.
  useEffect(() => {
    if (!sleep) {
      setSleepRemaining(undefined);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const left = engine.sleepRemaining();
      setSleepRemaining(left);
      if (left !== undefined && visible && engineState === "playing") {
        timer = setTimeout(update, countdownDelay(left));
      }
    };
    update();
    return () => {
      clearTimeout(timer);
    };
  }, [engine, sleep, engineState, visible]);

  const changeSleepSettings = useCallback(
    (next: SleepSettings) => {
      const previous = sleepSettingsRef.current;
      sleepSettingsRef.current = next;
      setSleepSettings(next);
      saveSleepSettings(preferences, next);
      // A new fade-out applies to the running timer, which keeps its end.
      if (next.fadeOut !== previous.fadeOut && sleepRef.current) {
        engine.setSleepTimer(engine.sleepRemaining(), next.fadeOut);
      }
    },
    [engine, preferences],
  );

  /** Starts a sleep timer of `minutes`, restarting any other, or turns it off. */
  const chooseSleep = useCallback(
    (minutes: number | undefined) => {
      if (minutes === undefined) {
        engine.setSleepTimer(undefined);
        sleepRef.current = undefined;
        setSleep(undefined);
        return;
      }
      engine.setSleepTimer(minutes * 60, sleepSettingsRef.current.fadeOut);
      const next = { minutes };
      sleepRef.current = next;
      setSleep(next);
      changeSleepSettings({ ...sleepSettingsRef.current, lastMinutes: minutes });
    },
    [engine, changeSleepSettings],
  );

  const levels = useMemo<LevelMeter>(
    () => ({ watch: engine.watchLevels, get: engine.getLevel }),
    [engine],
  );

  const [display, setDisplay] = useState(() => loadDisplay(preferences));
  const changeDisplay = useCallback(
    (next: DisplaySettings) => {
      setDisplay(next);
      saveDisplay(preferences, next);
    },
    [preferences],
  );
  const displayRef = useRef(display);
  useLayoutEffect(() => {
    displayRef.current = display;
  });
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

  const sessionTitle = useMemo(
    () =>
      mediaTitle(
        state.mix.layers.flatMap((layer) => sounds.find((s) => s.id === layer.id)?.name ?? []),
        state.mix.name,
      ),
    [state.mix.layers, state.mix.name, sounds],
  );
  useEffect(() => {
    document.title = pageTitle(state.mix.name);
  }, [state.mix.name]);
  const sessionActions = useMemo(
    () => ({
      play: () => {
        if (stateRef.current.mix.layers.length > 0) {
          void engine.play();
        }
      },
      pause: () => {
        engine.pause();
      },
      stop: () => {
        chooseSleep(undefined);
        engine.pause();
      },
    }),
    [engine, chooseSleep],
  );
  useMediaSession(sessionTitle, engineState, sessionActions, mediaSession, mediaMetadata);
  // Only while playing: a paused mix shouldn't keep the device awake.
  useWakeLock(display.keepAwake && isPlaying(engineState), wakeLock);

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
        setBaseline(mixKey(next.mix, sounds));
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

  const onPrefetch = useCallback(
    (sound: SoundEntry) => {
      loader.prefetch(sound);
    },
    [loader],
  );

  const toggleFavourite = useCallback(
    (id: string) => {
      const name = sounds.find((s) => s.id === id)?.name ?? id;
      showToast(favourites.toggle(id) ? `Starred ${name}` : `Unstarred ${name}`);
    },
    [favourites, showToast, sounds],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() === "s" && !typesText(event.target)) {
        const id = layerOf(event.target);
        if (id !== undefined) {
          toggleFavourite(id);
        }
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
        setSheetOpen(true);
        setAddOpen(true);
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
      } else if (key === "d") {
        const backdrop = nextBackdrop(displayRef.current.backdrop);
        changeDisplay({ ...displayRef.current, backdrop });
        showToast(`Backdrop: ${backdropLabel(backdrop)}`);
      } else if (key === "t") {
        const minutes = nextCycleMinutes(sleepRef.current?.minutes);
        chooseSleep(minutes);
        showToast(`Sleep timer: ${minutes === undefined ? "Off" : timerLabel(minutes)}`);
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
    changeDisplay,
    chooseSleep,
    hover,
    onToggleSolo,
    setPanelHidden,
    showToast,
    toggleFavourite,
    toggleFullscreen,
    toggleMute,
    togglePlay,
  ]);

  // The panel fades with the cursor when idle, except on touch (there's no pointer
  // to bring it back) and while the pointer rests on it.
  const fade = idle && !touch && !overPanel;
  const { panelHidden } = state;

  return (
    <div
      className="app"
      data-idle={fade}
      data-backdrop={display.backdrop}
      data-layout={layout}
      data-sheet={
        layout === "sheet" ? (sheetOpen || addOpen ? "expanded" : "collapsed") : undefined
      }
    >
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
            edited={edited}
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
            favourites={starred}
            onToggleFavourite={toggleFavourite}
            onPrefetch={onPrefetch}
            levels={levels}
            levelsActive={!panelHidden && !fade && engineState === "playing"}
            sounds={sounds}
            display={display}
            onDisplayChange={changeDisplay}
            wakeLock={wakeLock !== undefined}
            layout={layout}
            sheetOpen={sheetOpen}
            onSheetOpenChange={setSheetOpen}
            sleep={{
              minutes: sleep?.minutes,
              remaining: sleepRemaining,
              settings: sleepSettings,
              onChoose: chooseSleep,
              onSettingsChange: changeSleepSettings,
            }}
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
