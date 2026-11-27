import { preact } from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import { serviceWorker } from "./plugins/service-worker.ts";

/**
 * Content-Security-Policy for the built site. GitHub Pages can't send headers, so it
 * goes in a <meta> tag (which can't express frame-ancestors, report-uri or sandbox).
 * The build has no inline scripts and no data: or blob: subresources. style-src needs
 * no 'unsafe-inline': the UI's inline styles (the slider fill) are set through the
 * DOM's style object, which the policy doesn't restrict.
 *
 * AudioWorklet modules need no extra directive: `audioWorklet.addModule` fetches them
 * under script-src, and each one is bundled (through a `?worker&url` import) into a
 * self-contained file in assets/, so 'self' covers it. Loading one from a blob: or
 * data: URL would need those schemes added, so don't.
 *
 * Playing the output through an <audio> element needs no media-src either: its
 * srcObject is a MediaStream from the audio graph, not a URL, so nothing is
 * fetched. (Were it fetched, default-src 'self' would cover it.) The Media
 * Session's artwork is the site's own icon, under 'self'.
 *
 * Exporting audio needs nothing more either. The finished file downloads through
 * a blob: link, a navigation, which CSP doesn't govern; writing to a file picked
 * with showSaveFilePicker isn't governed either. The renderer and the encoder
 * (mediabunny) are lazily loaded chunks under 'self'. WebCodecs encodes in the
 * page and fetches nothing. Mediabunny starts blob: workers only for video
 * features (alpha channels, camera tracks) the export never uses; were they
 * needed, they'd need worker-src blob:.
 *
 * The web app manifest is fetched under manifest-src, named explicitly ('self',
 * the same as default-src) so the policy reads as a list of what the page loads;
 * its icons are images under img-src.
 *
 * The service worker, sw.js, is registered under worker-src: 'self' allows it,
 * from the site's own origin, and nothing else (no blob: or data: workers). The
 * worker itself isn't governed by this policy, which applies to the page; the
 * files it fetches and caches are the page's own.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

/**
 * Injects the CSP at build time only. The dev server needs a websocket for HMR
 * (Prefresh), which the production policy forbids.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
        injectTo: "head-prepend",
      },
    ],
  };
}

/**
 * Vite's and Vitest's caches, pinned to the project root. The default is relative to
 * the working directory, so Vitest run from a subfolder with `--config` pointing here
 * would otherwise scatter `node_modules/.vite` folders through `src/`. (Run from a
 * subfolder without `--config`, Vitest finds no config at all; run it from the root.)
 */
export const CACHE_DIR = fileURLToPath(new URL("node_modules/.vite", import.meta.url));

/**
 * The instant every unit test's fake clock starts at (2026-03-14 15:09:26 UTC), so no
 * test depends on when it runs.
 */
const TEST_TIME = Date.UTC(2026, 2, 14, 15, 9, 26);

/** Kept out of every Vitest run. */
export const TEST_EXCLUDE = ["**/.claude/**", "e2e/**"];

/**
 * Kept out of the Preact plugin's transform. In dev it adds Prefresh's HMR code to
 * every module, and that code imports Vite's client, which needs the DOM: a
 * module loaded into an AudioWorklet that imports it fails to evaluate, so its
 * processors never register. The audio code is framework-free (lint enforces
 * it), so it loses nothing but hot reloading. Sound folders hold `*-dsp.ts`
 * kernels and `*.worklet.ts` modules too.
 */
const PREACT_EXCLUDE = [/node_modules/, /\/src\/audio\//, /-dsp\.ts$/, /\.worklet\.ts$/];

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the build works when served from a GitHub Pages
  // project subpath (https://<user>.github.io/<repo>/).
  base: "./",
  cacheDir: CACHE_DIR,
  // No react -> preact/compat aliases: the app imports preact directly, and an alias
  // would hide a stray react import instead of failing the build.
  plugins: [
    preact({ reactAliasesEnabled: false, exclude: PREACT_EXCLUDE }),
    contentSecurityPolicy(),
    serviceWorker("src/sw/sw.ts"),
  ],
  // The dev server finds a dependency imported only lazily (the export encoder's
  // mediabunny) when it is first imported, pre-bundles it then and reloads the
  // page, which would cut short the export that loaded it. Pre-bundle it up front.
  optimizeDeps: { include: ["mediabunny"] },
  // Agent worktrees live under .claude/; keep their copies of the tests out of the run.
  // e2e/ holds the Playwright browser tests, run by `npm run test:browser`, and
  // *.perf.test.ts the timing tests, run one file at a time by `npm run test:perf`.
  // src/test/setup.ts puts every test on fake timers starting at TEST_TIME.
  test: {
    exclude: [...configDefaults.exclude, ...TEST_EXCLUDE, "**/*.perf.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    fakeTimers: { now: TEST_TIME },
  },
});
