import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ExportControls, ExportProgress } from "../components/ExportSection";
import { layerGain } from "../audio/mix-graph";
import type { ExportRequest } from "../export/export";
import {
  CODECS,
  detectCompressedCodec,
  exportFileName,
  exportFormat,
  exportSeconds,
  loadExportSettings,
  saveExportSettings,
  type CodecSupport,
  type CompressedCodec,
  type ExportSettings,
} from "../export/options";
import {
  canPickFile,
  createBlobSink,
  createFileSink,
  pickFile,
  type ExportSink,
} from "../export/sink";
import { downloadBlob } from "../lib/download";
import type { Preferences } from "../lib/preferences";
import type { Mix } from "../mixes/mix";

/** Runs an export: the renderer, loaded only when someone exports. */
type ExportRunner = (request: ExportRequest) => Promise<{ blob: Blob | undefined }>;

const loadAndRun: ExportRunner = (request) =>
  import("../export/export").then((m) => m.exportAudio(request));

interface ExportOptions {
  preferences: Preferences;
  /** The mix as it is now; an export takes it as it is when the export starts. */
  mix: Mix;
  /** Whether this is a touch-first device, where WAV is capped at 15 min. */
  coarse: boolean;
  /** Tells the user how an export went. */
  notify: (message: string) => void;
  /** Tests pass stand-ins for these. */
  run?: ExportRunner | undefined;
  detect?: (() => Promise<CompressedCodec | undefined>) | undefined;
  /** Whether a WAV can go straight to a file the user picks. */
  canPick?: (() => boolean) | undefined;
  /** Opens the file the user picks; undefined when they cancel. */
  pick?: typeof pickFile | undefined;
  download?: ((fileName: string, blob: Blob) => void) | undefined;
}

const WAV_TYPE = { description: "WAV audio", accept: { "audio/wav": [".wav"] } };

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * The Export section's state and actions: the choices (kept in the
 * preferences), which compressed format the browser supports, and the running
 * export, if any. A WAV goes straight to a file the user picks where the
 * browser can (`showSaveFilePicker`); anything else downloads through a
 * `blob:` link when it's done. Leaving the page cancels a running export.
 */
export function useAudioExport(options: ExportOptions): ExportControls {
  const { preferences, mix, coarse, notify } = options;
  const run = options.run ?? loadAndRun;
  const detect = options.detect ?? detectCompressedCodec;
  const canPick = options.canPick ?? canPickFile;
  const pick = options.pick ?? pickFile;
  const download = options.download ?? downloadBlob;

  const [settings, setSettings] = useState(() => loadExportSettings(preferences));
  const [codec, setCodec] = useState<CodecSupport>(undefined);
  const [progress, setProgress] = useState<ExportProgress | undefined>(undefined);
  const running = useRef<AbortController | undefined>(undefined);
  const mixRef = useRef(mix);
  useLayoutEffect(() => {
    mixRef.current = mix;
  });

  useEffect(() => {
    let live = true;
    const check = async () => {
      let found: CodecSupport = "none";
      try {
        found = (await detect()) ?? "none";
      } catch {
        // Treated as unsupported.
      }
      if (live) {
        setCodec(found);
      }
    };
    void check();
    return () => {
      live = false;
    };
  }, [detect]);

  // Leaving the page (or the app unmounting) cancels a running export.
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  const onSettingsChange = useCallback(
    (next: ExportSettings) => {
      setSettings(next);
      saveExportSettings(preferences, next);
    },
    [preferences],
  );

  const onExport = () => {
    if (running.current) {
      return;
    }
    const captured = mixRef.current;
    const format = exportFormat(settings, codec);
    const seconds = exportSeconds(settings);
    const extension = format === "wav" ? "wav" : CODECS[format].extension;
    const mimeType = format === "wav" ? "audio/wav" : CODECS[format].mimeType;
    const fileName = exportFileName(captured, settings.type, seconds, extension);
    const controller = new AbortController();
    running.current = controller;
    setProgress({ fraction: 0, remaining: undefined });

    const start = async () => {
      try {
        // The picker has to open straight from the click, before anything else is awaited.
        let sink: ExportSink;
        if (format === "wav" && canPick()) {
          const stream = await pick(fileName, WAV_TYPE);
          if (!stream) {
            return; // The user closed the picker.
          }
          sink = createFileSink(stream);
        } else {
          sink = createBlobSink(mimeType);
        }
        const began = Date.now();
        const result = await run({
          mix: captured,
          type: settings.type,
          seconds,
          format,
          sink,
          signal: controller.signal,
          onProgress: (fraction) => {
            const elapsed = (Date.now() - began) / 1000;
            setProgress({
              fraction,
              remaining:
                fraction > 0 && fraction < 1 ? (elapsed * (1 - fraction)) / fraction : undefined,
            });
          },
        });
        if (result.blob) {
          download(fileName, result.blob);
          notify(`Exported ${fileName}`);
        } else {
          notify(`Saved ${fileName}`);
        }
      } catch (error) {
        if (isAbort(error)) {
          notify("Export cancelled");
        } else {
          console.error(error);
          notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (running.current === controller) {
          running.current = undefined;
          setProgress(undefined);
        }
      }
    };
    void start();
  };

  return {
    settings,
    onSettingsChange,
    codec,
    coarse,
    canExport: mix.layers.some((layer) => layerGain(layer) > 0),
    progress,
    onExport,
    onCancel: () => {
      running.current?.abort();
    },
  };
}
