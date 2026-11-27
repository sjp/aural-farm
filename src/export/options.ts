/**
 * The Export section's choices, what they make (a length, a size, a file
 * name), the limits on them, and the choices kept between visits. Small and
 * free of audio code, so it can ship in the entry chunk; the renderer and the
 * encoders load only when someone exports.
 */
import { layerGain } from "../audio/mix-graph";
import type { Preferences } from "../lib/preferences";
import type { Mix } from "../mixes/mix";
import { EXPORT_CHANNELS, EXPORT_RATE } from "./plan";
import { wavBytes } from "./wav";

export type ExportType = "clip" | "loop";
type ExportFormat = "wav" | "compressed";
export type CompressedCodec = "opus" | "aac";

/** Clip lengths, in minutes. */
const CLIP_MINUTES = [1, 5, 10, 15, 30, 45, 60] as const;
const DEFAULT_CLIP_MINUTES = 10;
/** Loop lengths, in seconds. */
const LOOP_SECONDS = [30, 60, 120, 300, 600] as const;
const DEFAULT_LOOP_SECONDS = 120;

/** A WAV larger than this gets a warning that suggests the compressed format. */
const LARGE_WAV_BYTES = 500_000_000;
/** The longest WAV on a touch-first device, whose memory and storage are tighter. */
const COARSE_WAV_MAX_SECONDS = 15 * 60;
/** Container overhead on top of a compressed format's bitrate, roughly. */
const COMPRESSED_OVERHEAD = 1.02;

interface CodecInfo {
  /** The codec's name, as shown. */
  label: string;
  /** The container's name, as shown. */
  container: string;
  /** In bits per second. */
  bitrate: number;
  extension: string;
  mimeType: string;
  /** The codec string WebCodecs knows it by. */
  webCodec: string;
}

/** The compressed formats, best first: Opus in WebM, else AAC in M4A. */
export const CODECS: Readonly<Record<CompressedCodec, CodecInfo>> = {
  opus: {
    label: "Opus",
    container: "WebM",
    bitrate: 128_000,
    extension: "webm",
    mimeType: "audio/webm",
    webCodec: "opus",
  },
  aac: {
    label: "AAC",
    container: "M4A",
    bitrate: 160_000,
    extension: "m4a",
    mimeType: "audio/mp4",
    webCodec: "mp4a.40.2",
  },
};
const CODEC_ORDER: readonly CompressedCodec[] = ["opus", "aac"];

export interface ExportSettings {
  type: ExportType;
  clipMinutes: number;
  loopSeconds: number;
  format: ExportFormat;
}

const KEYS = {
  type: "export.type",
  clipMinutes: "export.clipMinutes",
  loopSeconds: "export.loopSeconds",
  format: "export.format",
} as const;

const pick = <T extends string | number>(choices: readonly T[], raw: string | null, fallback: T) =>
  choices.find((c) => String(c) === raw) ?? fallback;

/** The stored choices; anything missing or unreadable takes its default. */
export function loadExportSettings(preferences: Preferences): ExportSettings {
  return {
    type: pick<ExportType>(["clip", "loop"], preferences.get(KEYS.type), "clip"),
    clipMinutes: pick<number>(
      CLIP_MINUTES,
      preferences.get(KEYS.clipMinutes),
      DEFAULT_CLIP_MINUTES,
    ),
    loopSeconds: pick<number>(
      LOOP_SECONDS,
      preferences.get(KEYS.loopSeconds),
      DEFAULT_LOOP_SECONDS,
    ),
    format: pick<ExportFormat>(["wav", "compressed"], preferences.get(KEYS.format), "wav"),
  };
}

export function saveExportSettings(preferences: Preferences, settings: ExportSettings): void {
  preferences.set(KEYS.type, settings.type);
  preferences.set(KEYS.clipMinutes, String(settings.clipMinutes));
  preferences.set(KEYS.loopSeconds, String(settings.loopSeconds));
  preferences.set(KEYS.format, settings.format);
}

/** The length the settings ask for, in seconds (a loop may snap to its rhythm). */
export function exportSeconds(settings: ExportSettings): number {
  return settings.type === "clip" ? settings.clipMinutes * 60 : settings.loopSeconds;
}

/** A length as the panel names it: "30 s", "1 min", "10 min". */
export function lengthLabel(seconds: number): string {
  return seconds < 60 ? `${String(seconds)} s` : `${String(seconds / 60)} min`;
}

/** The file's size in bytes: exact for WAV, from the bitrate for a compressed format. */
export function estimateBytes(seconds: number, format: "wav" | CompressedCodec): number {
  if (format === "wav") {
    return wavBytes(Math.round(seconds * EXPORT_RATE), EXPORT_CHANNELS);
  }
  return Math.round(((CODECS[format].bitrate * seconds) / 8) * COMPRESSED_OVERHEAD);
}

/** A size as the panel shows it: "≈ 115 MB", "≈ 2.4 MB", "≈ 490 kB" (decimal units). */
export function formatSize(bytes: number): string {
  if (bytes < 1e6) {
    return `≈ ${String(Math.max(1, Math.round(bytes / 1e3)))} kB`;
  }
  const mb = bytes / 1e6;
  return `≈ ${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}

/** Whether a WAV this big gets the warning that suggests the compressed format. */
export function isLargeWav(bytes: number): boolean {
  return bytes > LARGE_WAV_BYTES;
}

/** Whether a WAV of `seconds` is allowed: on a touch-first (`coarse`) device, 15 min at most. */
export function wavAllowed(seconds: number, coarse: boolean): boolean {
  return !coarse || seconds <= COARSE_WAV_MAX_SECONDS;
}

/** Lowercase ASCII letters and digits joined by dashes, accents dropped; "" if nothing is left. */
function slugify(text: string, max = 40): string {
  return text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** How many layer ids name an unnamed mix's file. */
const NAME_LAYERS = 3;

/**
 * The file's name: `aural-farm-<mix name, or its first layers' ids>-<length>.<ext>`,
 * such as `aural-farm-night-drive-10min.wav` or `aural-farm-engine-core-2min-loop.webm`.
 */
export function exportFileName(
  mix: Mix,
  type: ExportType,
  seconds: number,
  extension: string,
): string {
  const named = slugify(mix.name ?? "");
  const layers = mix.layers
    .filter((l) => layerGain(l) > 0)
    .slice(0, NAME_LAYERS)
    .map((l) => l.id);
  const fallback = slugify(layers.join("-"), 60);
  const name = named !== "" ? named : fallback !== "" ? fallback : "mix";
  const length = seconds < 60 ? `${String(seconds)}s` : `${String(seconds / 60)}min`;
  return `aural-farm-${name}-${length}${type === "loop" ? "-loop" : ""}.${extension}`;
}

/** The part of WebCodecs' `AudioEncoder` that support detection uses. */
interface EncoderSupport {
  isConfigSupported: (config: AudioEncoderConfig) => Promise<{ supported?: boolean }>;
}

function browserEncoder(): EncoderSupport | undefined {
  return typeof AudioEncoder === "undefined" ? undefined : AudioEncoder;
}

/**
 * The best compressed format this browser's WebCodecs can encode at 48 kHz
 * stereo, or undefined for none.
 */
export async function detectCompressedCodec(
  encoder: EncoderSupport | undefined = browserEncoder(),
): Promise<CompressedCodec | undefined> {
  if (!encoder) {
    return undefined;
  }
  for (const codec of CODEC_ORDER) {
    const { webCodec, bitrate } = CODECS[codec];
    try {
      const result = await encoder.isConfigSupported({
        codec: webCodec,
        sampleRate: EXPORT_RATE,
        numberOfChannels: EXPORT_CHANNELS,
        bitrate,
      });
      if (result.supported === true) {
        return codec;
      }
    } catch {
      // Unsupported; try the next.
    }
  }
  return undefined;
}
