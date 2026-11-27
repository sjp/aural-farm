import { describe, expect, it } from "vitest";
import { precacheManifest, SW_FILE, type BuildFile } from "./service-worker.ts";

/** A build's output as Vite writes it: entry, lazily loaded chunks, a worklet, CSS and public files. */
const BUILD: readonly BuildFile[] = [
  { fileName: "index.html", source: "<!doctype html><script src=./assets/index-a1.js></script>" },
  { fileName: "assets/index-a1.js", source: "console.log('app')" },
  { fileName: "assets/index-b2.css", source: "body{}" },
  { fileName: "assets/engine-core-c3.js", source: "export const engine = 1" },
  { fileName: "assets/white-noise-d4.js", source: "export const white = 1" },
  { fileName: "assets/audio.worklet-e5.js", source: "registerProcessor('noise', class {})" },
  { fileName: "assets/compressed-f6.js", source: "export const encoder = 1" },
  { fileName: "favicon.svg", source: "<svg/>" },
  { fileName: "icon-192.png", source: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]) },
  { fileName: "icon-512.png", source: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]) },
  { fileName: "icon-maskable-512.png", source: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3]) },
  { fileName: "apple-touch-icon.png", source: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4]) },
  { fileName: "manifest.webmanifest", source: '{"name":"Aural Farm"}' },
];

const withFile = (fileName: string, source: BuildFile["source"]) =>
  BUILD.map((file) => (file.fileName === fileName ? { fileName, source } : file));

describe("precacheManifest", () => {
  it("lists every file in the build, sorted, as paths relative to the scope", () => {
    const { urls } = precacheManifest(BUILD);
    expect(urls).toEqual(BUILD.map((file) => file.fileName).toSorted());
    expect(urls.every((url) => !url.startsWith("/") && !url.startsWith("."))).toBe(true);
  });

  it("leaves out the worker itself", () => {
    const { urls } = precacheManifest([...BUILD, { fileName: SW_FILE, source: "old worker" }]);
    expect(urls).not.toContain(SW_FILE);
    expect(urls).toHaveLength(BUILD.length);
  });

  it("gives the same version for the same files in any order", () => {
    expect(precacheManifest(BUILD.toReversed()).version).toBe(precacheManifest(BUILD).version);
  });

  it("doesn't change the version for a different old worker", () => {
    expect(precacheManifest([...BUILD, { fileName: SW_FILE, source: "a" }]).version).toBe(
      precacheManifest(BUILD).version,
    );
  });

  it.each(BUILD.map((file) => file.fileName))("changes the version when %s changes", (name) => {
    expect(precacheManifest(withFile(name, "changed")).version).not.toBe(
      precacheManifest(BUILD).version,
    );
  });

  it("changes the version when a file is added", () => {
    const added = [...BUILD, { fileName: "assets/rain-g7.js", source: "export const rain = 1" }];
    expect(precacheManifest(added).version).not.toBe(precacheManifest(BUILD).version);
  });

  it("changes the version when a file is renamed", () => {
    const renamed = BUILD.map((file) =>
      file.fileName === "assets/index-a1.js" ? { ...file, fileName: "assets/index-z9.js" } : file,
    );
    expect(precacheManifest(renamed).version).not.toBe(precacheManifest(BUILD).version);
  });

  it("treats text and its bytes alike", () => {
    const bytes = withFile("favicon.svg", new TextEncoder().encode("<svg/>"));
    expect(precacheManifest(bytes).version).toBe(precacheManifest(BUILD).version);
  });
});
