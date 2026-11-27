import { describe, expect, it } from "vitest";
import { createPreferences, type PreferenceStorage } from "../lib/preferences";
import type { Layer, Mix } from "../mixes/mix";
import {
  CODECS,
  detectCompressedCodec,
  estimateBytes,
  exportFileName,
  exportSeconds,
  formatSize,
  isLargeWav,
  lengthLabel,
  loadExportSettings,
  saveExportSettings,
  wavAllowed,
  type ExportSettings,
} from "./options";

function memoryStorage(): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const layer = (id: string, change: Partial<Layer> = {}): Layer => ({
  id,
  volume: 80,
  muted: false,
  params: {},
  ...change,
});

describe("export settings", () => {
  it("defaults to a 10-minute WAV clip and a 2-minute loop", () => {
    expect(loadExportSettings(createPreferences(() => undefined))).toEqual({
      type: "clip",
      clipMinutes: 10,
      loopSeconds: 120,
      format: "wav",
    });
  });

  it("round-trips through the preferences", () => {
    const storage = memoryStorage();
    const settings: ExportSettings = {
      type: "loop",
      clipMinutes: 45,
      loopSeconds: 30,
      format: "compressed",
    };
    saveExportSettings(
      createPreferences(() => storage),
      settings,
    );
    expect(loadExportSettings(createPreferences(() => storage))).toEqual(settings);
  });

  it("falls back to the defaults for values it doesn't offer", () => {
    const storage = memoryStorage();
    storage.data.set("aural-farm.export.type", "song");
    storage.data.set("aural-farm.export.clipMinutes", "7");
    storage.data.set("aural-farm.export.loopSeconds", "abc");
    storage.data.set("aural-farm.export.format", "mp3");
    expect(loadExportSettings(createPreferences(() => storage))).toEqual({
      type: "clip",
      clipMinutes: 10,
      loopSeconds: 120,
      format: "wav",
    });
  });

  it("gives the length in seconds for each type", () => {
    const settings: ExportSettings = {
      type: "clip",
      clipMinutes: 5,
      loopSeconds: 30,
      format: "wav",
    };
    expect(exportSeconds(settings)).toBe(300);
    expect(exportSeconds({ ...settings, type: "loop" })).toBe(30);
  });

  it.each([
    [30, "30 s"],
    [60, "1 min"],
    [600, "10 min"],
  ])("labels %d s as %s", (seconds, label) => {
    expect(lengthLabel(seconds)).toBe(label);
  });
});

describe("size estimates and limits", () => {
  it("gives a WAV's exact size", () => {
    expect(estimateBytes(600, "wav")).toBe(115_200_044);
    expect(estimateBytes(3600, "wav")).toBe(691_200_044);
  });

  it("estimates a compressed file from its bitrate", () => {
    expect(estimateBytes(600, "opus")).toBeCloseTo((128_000 * 600) / 8, -6);
    expect(estimateBytes(600, "aac")).toBeCloseTo((160_000 * 600) / 8, -6);
    expect(estimateBytes(600, "opus")).toBeLessThan(estimateBytes(600, "wav") / 10);
  });

  it.each([
    [115_200_044, "≈ 115 MB"],
    [691_200_044, "≈ 691 MB"],
    [5_760_044, "≈ 5.8 MB"],
    [489_600, "≈ 490 kB"],
    [12, "≈ 1 kB"],
  ])("shows %d bytes as %s", (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });

  it("warns above 500 MB, so a 45-minute WAV but not a 30-minute one", () => {
    expect(isLargeWav(estimateBytes(30 * 60, "wav"))).toBe(false);
    expect(isLargeWav(estimateBytes(45 * 60, "wav"))).toBe(true);
  });

  it("caps a WAV at 15 minutes on touch-first devices only", () => {
    expect(wavAllowed(15 * 60, true)).toBe(true);
    expect(wavAllowed(30 * 60, true)).toBe(false);
    expect(wavAllowed(60 * 60, false)).toBe(true);
  });
});

describe("exportFileName", () => {
  const mix = (change: Partial<Mix> = {}): Mix => ({
    master: 70,
    layers: [layer("engine-core"), layer("brown-noise")],
    ...change,
  });

  it("names the file after the mix's name", () => {
    expect(exportFileName(mix({ name: "Night Drive" }), "clip", 600, "wav")).toBe(
      "aural-farm-night-drive-10min.wav",
    );
  });

  it("drops accents and anything outside a–z and 0–9", () => {
    expect(exportFileName(mix({ name: "Café — Ünder 2 Stars!" }), "clip", 60, "wav")).toBe(
      "aural-farm-cafe-under-2-stars-1min.wav",
    );
  });

  it("falls back to the first audible layers' ids for an unnamed mix", () => {
    const layers = [
      layer("engine-core"),
      layer("pink-noise", { muted: true }),
      layer("brown-noise"),
      layer("white-noise", { volume: 0 }),
      layer("grey-noise"),
      layer("rain"),
    ];
    expect(exportFileName(mix({ layers }), "loop", 120, "webm")).toBe(
      "aural-farm-engine-core-brown-noise-grey-noise-2min-loop.webm",
    );
  });

  it("falls back to the layers when the name slugifies to nothing", () => {
    expect(exportFileName(mix({ name: "🌙 夜" }), "loop", 30, "m4a")).toBe(
      "aural-farm-engine-core-brown-noise-30s-loop.m4a",
    );
  });

  it("keeps a long name to 40 characters, without a trailing dash", () => {
    const name = "Aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii";
    const file = exportFileName(mix({ name }), "clip", 300, "wav");
    expect(file).toBe("aural-farm-aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh-5min.wav");
  });
});

describe("detectCompressedCodec", () => {
  const encoder = (supported: readonly string[]) => ({
    configs: [] as AudioEncoderConfig[],
    isConfigSupported(config: AudioEncoderConfig) {
      this.configs.push(config);
      return Promise.resolve({ supported: supported.includes(config.codec) });
    },
  });

  it("prefers Opus at 128 kb/s", async () => {
    const fake = encoder(["opus", "mp4a.40.2"]);
    await expect(detectCompressedCodec(fake)).resolves.toBe("opus");
    expect(fake.configs).toEqual([
      { codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
    ]);
  });

  it("falls back to AAC at 160 kb/s", async () => {
    const fake = encoder(["mp4a.40.2"]);
    await expect(detectCompressedCodec(fake)).resolves.toBe("aac");
    expect(fake.configs.at(-1)?.bitrate).toBe(CODECS.aac.bitrate);
  });

  it("finds none without WebCodecs, or when it supports neither or throws", async () => {
    await expect(detectCompressedCodec(undefined)).resolves.toBeUndefined();
    await expect(detectCompressedCodec(encoder([]))).resolves.toBeUndefined();
    const throwing = { isConfigSupported: () => Promise.reject(new TypeError("bad config")) };
    await expect(detectCompressedCodec(throwing)).resolves.toBeUndefined();
  });
});
