import type { JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ControlPanel } from "./components/ControlPanel";
import { SlidersIcon } from "./components/icons";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { useIdle, useTouchPointer } from "./hooks/useIdle";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { copyText } from "./lib/clipboard";
import { createPreferences, type Preferences } from "./lib/preferences";
import { parseHash, serialiseHash, VOLUME_PARAM, type HashState, type Layer } from "./mixes/mix";
import type { SoundLoader } from "./sounds/loader";
import { defaults } from "./sounds/params";
import { getSound } from "./sounds/registry";
import type { ParamValue } from "./sounds/types";

/** The panel and cursor fade after this long without input. */
export const IDLE_MS = 3000;
/** Hash writes wait this long after the last change, so dragging a slider writes once. */
export const HASH_DEBOUNCE_MS = 250;
export const TOAST_MS = 2500;

interface Toast {
  id: number;
  message: string;
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

function fullscreenAvailable(): boolean {
  // Missing in some browsers (older iOS Safari), whatever the DOM types say.
  return (document.fullscreenEnabled as boolean | undefined) === true;
}

interface AppProps {
  /** The state read from the URL hash at start-up. */
  initial: HashState;
  loader: SoundLoader;
  preferences?: Preferences;
}

export function App({ initial, loader, preferences: givenPreferences }: AppProps): JSX.Element {
  const [state, setState] = useState(initial);
  const [preferences] = useState(() => givenPreferences ?? createPreferences());
  const [toast, setToast] = useState<Toast | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [overPanel, setOverPanel] = useState(false);
  const [canFullscreen] = useState(fullscreenAvailable);
  const hover = useMediaQuery("(hover: hover)");
  const idle = useIdle(IDLE_MS);
  const touch = useTouchPointer();

  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });

  // State → hash, debounced. replaceState keeps edits out of the back button's history.
  useEffect(() => {
    const timer = setTimeout(() => {
      const hash = serialiseHash(state);
      if (window.location.hash !== hash) {
        const url = new URL(window.location.href);
        url.hash = hash;
        window.history.replaceState(window.history.state, "", url.href);
      }
    }, HASH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);

  // Hash → state, for edited or pasted hashes. One that matches the state is skipped.
  useEffect(() => {
    const onHashChange = () => {
      const next = parseHash(window.location.hash);
      if (serialiseHash(next) !== serialiseHash(stateRef.current)) {
        setState(next);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setToast(null);
    }, TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  const showToast = useCallback((message: string) => {
    setToast((t) => ({ id: (t?.id ?? 0) + 1, message }));
  }, []);

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
    url.hash = serialiseHash({ ...stateRef.current, panelHidden: true }, { full: true });
    void copyText(url.href).then((ok) => {
      showToast(ok ? "Link copied" : "Couldn't copy the link");
      return undefined;
    });
  }, [showToast]);

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

  const onResetAll = useCallback(() => {
    setState((s) => ({
      ...s,
      mix: {
        ...s.mix,
        layers: s.mix.layers.map((l) => {
          const sound = getSound(l.id);
          return {
            ...l,
            volume: VOLUME_PARAM.default,
            params: sound ? defaults(sound.params) : l.params,
          };
        }),
      },
    }));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "h") {
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
  }, [canFullscreen, hover, setPanelHidden, toggleFullscreen]);

  // The panel fades with the cursor when idle, except on touch (there's no pointer
  // to bring it back) and while the pointer rests on it.
  const fade = idle && !touch && !overPanel;
  const { panelHidden } = state;

  return (
    <div className="app" data-idle={fade}>
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
            loader={loader}
            preferences={preferences}
            hover={hover}
            onLayerChange={onLayerChange}
            onParamChange={onParamChange}
            onResetAll={onResetAll}
            onCopyLink={copyLink}
            onFullscreen={canFullscreen ? toggleFullscreen : undefined}
            onHide={() => {
              setPanelHidden(true);
            }}
            shortcutsOpen={shortcutsOpen}
            onShortcutsOpenChange={setShortcutsOpen}
          />
        </div>
      </PanelErrorBoundary>
      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.message}
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
