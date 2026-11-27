/**
 * A build-only Vite plugin that writes the service worker, `sw.js`, at the root of
 * the build. Once the build is written it lists every file in the output (the
 * entry, every lazily loaded chunk, worklet modules, CSS, the public files and
 * `index.html`), hashes their names and contents into a version, and bundles
 * `src/sw/sw.ts` with both baked in as one classic script.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { build, type Plugin } from "vite";

/** The worker's own file name, at the root of the build. */
export const SW_FILE = "sw.js";

/** One file of the build: its path relative to the output folder, with `/` separators. */
export interface BuildFile {
  fileName: string;
  source: Uint8Array | string;
}

/** What the worker precaches: every file but itself, and a version that changes with any of them. */
interface Precache {
  /** Paths relative to the worker's scope, sorted. */
  urls: string[];
  /** A short hash of every file's name and contents. */
  version: string;
}

/** The precache list and version for a build's files. */
export function precacheManifest(files: readonly BuildFile[]): Precache {
  const kept = files
    .filter((file) => file.fileName !== SW_FILE)
    .toSorted((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of kept) {
    const contents = createHash("sha256").update(file.source).digest("hex");
    hash.update(`${file.fileName}\0${contents}\n`);
  }
  return { urls: kept.map((file) => file.fileName), version: hash.digest("hex").slice(0, 16) };
}

/** Every file under `dir`, as build files. */
function readBuild(dir: string): BuildFile[] {
  const out: BuildFile[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name !== ".DS_Store") {
        out.push({
          fileName: relative(dir, path).split(sep).join("/"),
          source: readFileSync(path),
        });
      }
    }
  };
  walk(dir);
  return out;
}

/** Bundles the worker's source into one minified classic script, with `define`d constants. */
async function bundleWorker(root: string, entry: string, define: Record<string, string>) {
  const result = await build({
    configFile: false,
    root,
    logLevel: "warn",
    publicDir: false,
    define,
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      lib: { entry, formats: ["iife"], name: "auralFarmServiceWorker", fileName: () => SW_FILE },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if ("output" in output) {
      for (const item of output.output) {
        if (item.type === "chunk" && item.isEntry) {
          return item.code;
        }
      }
    }
  }
  throw new Error("The service worker's bundle has no entry chunk");
}

/**
 * Writes `sw.js` into the build, precaching every other file the build wrote.
 * `entry` is the worker's source, relative to the project root.
 */
export function serviceWorker(entry: string): Plugin {
  let root = "";
  let outDir = "";
  return {
    name: "service-worker",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const { urls, version } = precacheManifest(readBuild(outDir));
      const code = await bundleWorker(root, resolve(root, entry), {
        SW_PRECACHE: JSON.stringify(urls),
        SW_VERSION: JSON.stringify(version),
      });
      writeFileSync(join(outDir, SW_FILE), code);
    },
  };
}
