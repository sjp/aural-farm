import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { clickScore, kWeightedLoudness } from "../src/audio/analysis";

const RATE = 48000;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}

/** A 16-bit WAV file's format and its samples, per channel. */
function parseWav(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  expect(bytes.toString("ascii", 36, 40)).toBe("data");
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  const size = bytes.readUInt32LE(40);
  expect(bytes.readUInt32LE(4)).toBe(36 + size);
  expect(bytes.length).toBe(44 + size);
  const frames = size / channels / 2;
  const samples = Array.from({ length: channels }, (_, c) =>
    Float32Array.from(
      { length: frames },
      (_value, i) => bytes.readInt16LE(44 + (i * channels + c) * 2) / 32768,
    ),
  );
  return { channels, sampleRate, bits, frames, samples };
}

/** Opens the default mix with the Export section open; WAVs download rather than go to a picker. */
async function openExport(page: Page) {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "showSaveFilePicker");
  });
  await page.goto("/#layers=engine-core");
  // Rest the pointer on the panel, so it doesn't fade while the export runs.
  await page.locator(".panel").hover();
  await page.locator(".export-section .section-header").click();
}

const group = (page: Page, name: string) =>
  page.locator(".export-section").getByRole("group", { name });

/** Exports with the section's current choices, and returns the downloaded file and how long it took. */
async function exportFile(page: Page) {
  const download = page.waitForEvent("download", { timeout: 120_000 });
  const began = Date.now();
  await page.locator(".export-button").click();
  await expect(page.getByRole("progressbar", { name: "Exporting" })).toBeVisible();
  const file = await download;
  const seconds = (Date.now() - began) / 1000;
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: await readFile(path), seconds };
}

test("exports a 1-minute WAV clip of the default mix", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await openExport(page);
  await group(page, "Type").getByRole("button", { name: "Clip" }).click();
  await page.getByLabel("Length").selectOption({ label: "1 min" });
  await group(page, "Format").getByRole("button", { name: "WAV" }).click();
  await expect(page.locator(".export-size")).toHaveText("Size≈ 12 MB");

  const file = await exportFile(page);
  // Before the checks of the file, which can outlast the toast on a busy machine.
  await expect(page.getByRole("status")).toHaveText("Exported aural-farm-engine-core-1min.wav");
  test.info().annotations.push({
    type: "export time",
    description: `1-minute WAV clip exported in ${file.seconds.toFixed(1)} s`,
  });
  expect(file.name).toBe("aural-farm-engine-core-1min.wav");
  const wav = parseWav(file.bytes);
  expect(wav).toMatchObject({ channels: 2, sampleRate: RATE, bits: 16, frames: 60 * RATE });
  const loudness = kWeightedLoudness(wav.samples, RATE, 1);
  expect(loudness).toBeGreaterThan(-40);
  expect(loudness).toBeLessThan(-10);
  // Each chunk join (every 30 s) is seamless.
  for (const channel of wav.samples) {
    expect(clickScore(channel, RATE, 30)).toBeLessThan(6);
  }
  await expect(page.locator(".export-button")).toBeVisible();
  expect(errors).toEqual([]);
});

test("exports a 30 s seamless loop of the default mix that wraps without a click", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await openExport(page);
  await group(page, "Type").getByRole("button", { name: "Seamless loop" }).click();
  await page.getByLabel("Length").selectOption({ label: "30 s" });
  await group(page, "Format").getByRole("button", { name: "WAV" }).click();

  const file = await exportFile(page);
  test.info().annotations.push({
    type: "export time",
    description: `30 s WAV loop exported in ${file.seconds.toFixed(1)} s`,
  });
  expect(file.name).toBe("aural-farm-engine-core-30s-loop.wav");
  const wav = parseWav(file.bytes);
  // Engine Core's throb (0.82 Hz) snaps the loop to 25 whole periods.
  expect(wav.frames).toBe(Math.round((25 / 0.82) * RATE));
  expect(kWeightedLoudness(wav.samples, RATE, 1)).toBeGreaterThan(-40);
  // Play the end into the start, as a player repeating it does, and look for a click there.
  const second = RATE;
  for (const channel of wav.samples) {
    const wrapped = new Float32Array(2 * second);
    wrapped.set(channel.subarray(channel.length - second));
    wrapped.set(channel.subarray(0, second), second);
    expect(clickScore(wrapped, RATE, 1)).toBeLessThan(6);
  }
  expect(errors).toEqual([]);
});

test("exports a compressed loop where the browser can encode one", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await openExport(page);
  const compressed = group(page, "Format").getByRole("button", { name: "Compressed" });
  // Compressed is enabled once the browser is found to encode a format, or says it can't.
  const unsupported = page.locator(".export-section").getByText(/not supported in this browser/);
  await expect(compressed.and(page.locator(":enabled")).or(unsupported)).toBeVisible();
  test.skip(await unsupported.isVisible(), "This browser can't encode Opus or AAC");
  await group(page, "Type").getByRole("button", { name: "Seamless loop" }).click();
  await page.getByLabel("Length").selectOption({ label: "30 s" });
  await compressed.click();
  await expect(page.locator(".export-section")).toContainText(/Opus in WebM|AAC in M4A/);

  const file = await exportFile(page);
  test.info().annotations.push({
    type: "export time",
    description: `30 s compressed loop exported in ${file.seconds.toFixed(1)} s`,
  });
  if (file.name.endsWith(".webm")) {
    expect(file.name).toBe("aural-farm-engine-core-30s-loop.webm");
    // The EBML header that starts every WebM file.
    expect([...file.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  } else {
    expect(file.name).toBe("aural-farm-engine-core-30s-loop.m4a");
    expect(file.bytes.toString("ascii", 4, 8)).toBe("ftyp");
  }
  // About 30 s at 128–160 kb/s.
  expect(file.bytes.length).toBeGreaterThan(300_000);
  expect(file.bytes.length).toBeLessThan(900_000);
  expect(errors).toEqual([]);
});

test("cancels an export", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectErrors(page);
  await openExport(page);
  await group(page, "Type").getByRole("button", { name: "Clip" }).click();
  await page.getByLabel("Length").selectOption({ label: "60 min" });
  await expect(page.locator(".export-warning")).toContainText("large file");
  await page.locator(".export-button").click();
  await expect(page.getByRole("progressbar", { name: "Exporting" })).toBeVisible();
  await page.locator(".export-progress").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("status")).toHaveText("Export cancelled");
  await expect(page.locator(".export-button")).toBeVisible();
  expect(errors).toEqual([]);
});
