import type { JSX } from "preact";
import { useId, useState } from "preact/hooks";
import type { Preferences } from "../lib/preferences";
import {
  CLIP_MINUTES,
  CODECS,
  estimateBytes,
  exportSeconds,
  formatSize,
  isLargeWav,
  lengthLabel,
  LOOP_SECONDS,
  wavAllowed,
  type CodecSupport,
  type ExportFormat,
  type ExportSettings,
  type ExportType,
  exportFormat,
  remainingText,
} from "../export/options";
import { Section } from "./Section";

/** The preference that is "1" while the Export section is open; it starts closed. */
const EXPORT_OPEN_KEY = "exportOpen";

export interface ExportProgress {
  /** How much is done, 0–1. */
  fraction: number;
  /** About how long is left, in seconds, once that can be told. */
  remaining: number | undefined;
}

/** What the Export section shows and does; the app runs the export itself. */
export interface ExportControls {
  settings: ExportSettings;
  onSettingsChange: (settings: ExportSettings) => void;
  /** The compressed format this browser can encode: undefined while checking, "none" for none. */
  codec: CodecSupport;
  /** Whether this is a touch-first device, where WAV is capped at 15 min. */
  coarse: boolean;
  /** Whether the mix has a layer to hear. */
  canExport: boolean;
  /** Set while an export runs. */
  progress: ExportProgress | undefined;
  onExport: () => void;
  onCancel: () => void;
}

/** A labelled row of choices, one of them pressed. */
function Segments<T extends string>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="control">
      <div className="control-label">
        <span id={id}>{label}</span>
      </div>
      <div className="segmented" role="group" aria-labelledby={id}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={choice.value === value}
            disabled={choice.disabled === true}
            onClick={() => {
              onChange(choice.value);
            }}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Progress({
  progress,
  onCancel,
}: {
  progress: ExportProgress;
  onCancel: () => void;
}): JSX.Element {
  const percent = Math.floor(progress.fraction * 100);
  const text = `${String(percent)} %${
    progress.remaining === undefined ? "" : `, ${remainingText(progress.remaining)}`
  }`;
  return (
    <div className="export-progress">
      <div
        className="export-bar"
        role="progressbar"
        aria-label="Exporting"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
      >
        <span className="export-bar-fill" style={{ width: `${String(percent)}%` }} />
        <span className="export-bar-text">{text}</span>
      </div>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/**
 * The Export section: a clip or a seamless loop of the mix, as WAV or a
 * compressed format, with its size, and a progress bar while it renders.
 * Starts collapsed.
 */
export function ExportSection({
  controls,
  preferences,
}: {
  controls: ExportControls;
  preferences: Preferences;
}): JSX.Element {
  const [open, setOpen] = useState(() => preferences.get(EXPORT_OPEN_KEY) === "1");
  const lengthId = useId();
  const { settings, codec, onSettingsChange } = controls;
  const change = (next: Partial<ExportSettings>) => {
    onSettingsChange({ ...settings, ...next });
  };
  const seconds = exportSeconds(settings);
  const format = exportFormat(settings, codec);
  const bytes = estimateBytes(seconds, format);
  const wav = format === "wav";
  const tooLong = wav && !wavAllowed(seconds, controls.coarse);
  const compressedCodec = codec === undefined || codec === "none" ? undefined : codec;
  const lengths: readonly number[] =
    settings.type === "clip" ? CLIP_MINUTES.map((m) => m * 60) : LOOP_SECONDS;

  const formatNote = wav
    ? "16-bit, 48 kHz stereo."
    : `${CODECS[format].label} in ${CODECS[format].container}, ${String(CODECS[format].bitrate / 1000)} kb/s.`;
  let warning: string | undefined;
  if (tooLong) {
    warning = `WAV is limited to 15 min on this device. Choose ${
      compressedCodec !== undefined ? "Compressed or " : ""
    }a shorter length.`;
  } else if (wav && isLargeWav(bytes)) {
    warning =
      compressedCodec !== undefined
        ? `That's a large file. Compressed would be ${formatSize(estimateBytes(seconds, compressedCodec))}.`
        : "That's a large file.";
  }

  return (
    <Section
      title="Export"
      className="export-section"
      open={open}
      onToggle={() => {
        setOpen(!open);
        preferences.set(EXPORT_OPEN_KEY, open ? "0" : "1");
      }}
    >
      <div className="controls">
        <Segments<ExportType>
          label="Type"
          choices={[
            { value: "clip", label: "Clip" },
            { value: "loop", label: "Seamless loop" },
          ]}
          value={settings.type}
          onChange={(type) => {
            change({ type });
          }}
        />
        <div className="control control-inline">
          <div className="control-label">
            <label htmlFor={lengthId}>Length</label>
          </div>
          <select
            id={lengthId}
            value={String(seconds)}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              change(
                settings.type === "clip" ? { clipMinutes: value / 60 } : { loopSeconds: value },
              );
            }}
          >
            {lengths.map((length) => (
              <option key={length} value={String(length)}>
                {lengthLabel(length)}
              </option>
            ))}
          </select>
        </div>
        <Segments<ExportFormat>
          label="Format"
          choices={[
            { value: "wav", label: "WAV" },
            { value: "compressed", label: "Compressed", disabled: compressedCodec === undefined },
          ]}
          value={wav ? "wav" : "compressed"}
          onChange={(next) => {
            change({ format: next });
          }}
        />
        <p className="display-note">
          {formatNote}
          {codec === "none" && " Compressed: not supported in this browser."}
        </p>
        <p className="export-size">
          <span>Size</span>
          <span className="control-value">{formatSize(bytes)}</span>
        </p>
        {warning !== undefined && <p className="export-warning">{warning}</p>}
        {controls.progress ? (
          <Progress progress={controls.progress} onCancel={controls.onCancel} />
        ) : (
          <button
            type="button"
            className="primary export-button"
            disabled={!controls.canExport || tooLong}
            onClick={controls.onExport}
          >
            Export
          </button>
        )}
        {!controls.canExport && <p className="display-note">Add a sound to export it.</p>}
      </div>
    </Section>
  );
}
