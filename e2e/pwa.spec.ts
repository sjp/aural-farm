import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { build, preview, type PreviewServer } from "vite";

/**
 * The installable app, against a production build served by `vite preview`: the
 * service worker only exists in a build. The build goes to a temporary folder, so
 * `dist/` is left alone. A middleware can serve a changed `sw.js`, as a new deploy
 * would, to see the update toast.
 */

/** Where the preview server serves the build, on a port of its own. */
let BASE = "";
let outDir = "";
let server: PreviewServer | undefined;
/** When set, sw.js is served with its version replaced, as after a new deploy. */
let newVersion: string | undefined;

// One build and server for the file: its tests run in order, in one worker.
test.describe.configure({ mode: "default" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  outDir = mkdtempSync(join(tmpdir(), "aural-farm-pwa-"));
  await build({ logLevel: "warn", build: { outDir, emptyOutDir: true } });
  server = await preview({
    logLevel: "warn",
    build: { outDir },
    // Any free port: each worker running this file starts its own server.
    preview: { port: 0, host: "localhost" },
    plugins: [
      {
        name: "new-deploy",
        configurePreviewServer(previewServer) {
          previewServer.middlewares.use((req, res, next) => {
            if (newVersion === undefined || req.url?.split("?")[0] !== "/sw.js") {
              next();
              return;
            }
            const code = readFileSync(join(outDir, "sw.js"), "utf8");
            res.setHeader("Content-Type", "text/javascript");
            res.setHeader("Cache-Control", "no-cache");
            res.end(code.replace(currentVersion(), newVersion));
          });
        },
      },
    ],
  });
  const address = server.httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("The preview server has no port");
  }
  BASE = `http://localhost:${String(address.port)}/`;
});

test.afterAll(async () => {
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  newVersion = undefined;
});

/** The build's version, as baked into sw.js: the only 16-digit hex string in it. */
function currentVersion(): string {
  const match = /\b[0-9a-f]{16}\b/.exec(readFileSync(join(outDir, "sw.js"), "utf8"));
  if (!match) {
    throw new Error("No version in sw.js");
  }
  return match[0];
}

/** Every file of the build, as paths relative to its root. */
function buildFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        out.push(relative(outDir, path).split(sep).join("/"));
      }
    }
  };
  walk(outDir);
  return out.toSorted();
}

/** Collects page errors and console errors, and every request that leaves the site. */
function watch(page: Page) {
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(BASE)) {
      foreign.push(request.url());
    }
  });
  return { errors, foreign };
}

/** Opens the app and waits for the service worker to install and control the page. */
async function openControlled(page: Page, hash = "") {
  await page.goto(`${BASE}${hash}`);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
      timeout: 20_000,
    })
    .toBe(true);
}

/** Starts playback, clicking Tap to play where the browser blocks autoplay. */
async function startPlaying(page: Page) {
  const playing = page.locator('button[aria-label="Pause"]:not([aria-busy="true"])');
  const tap = page.getByRole("button", { name: "Tap to play" });
  await expect(playing.or(tap)).toBeVisible();
  if (await tap.isVisible()) {
    await tap.click();
  }
  await expect(playing).toBeVisible();
}

/** The worker's caches, and the paths each holds relative to the site. */
const cached = (page: Page) =>
  page.evaluate(async (base) => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((request) => request.url.slice(base.length)).toSorted();
    }
    return out;
  }, BASE);

test("installs a service worker that precaches every file of the build", async ({ page }) => {
  const { errors, foreign } = watch(page);
  await openControlled(page);
  const files = buildFiles().filter((file) => file !== "sw.js");
  expect(files).toContain("index.html");
  expect(files.some((file) => file.startsWith("assets/compressed-"))).toBe(true);
  await expect.poll(() => cached(page)).toEqual({ [`aural-farm-${currentVersion()}`]: files });

  // Chromium's own installability checks: manifest, icons, worker, secure origin.
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  expect(installabilityErrors).toEqual([]);

  // The app fetches nothing from another origin.
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test("works offline: reloads, plays the default mix and loads a sound it hadn't used", async ({
  page,
  context,
}) => {
  const { errors, foreign } = watch(page);
  await openControlled(page);
  await context.setOffline(true);
  // Offline navigations fail at once, so the cached page is served without the timeout.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Starship Engine Core" })).toBeVisible();
  await startPlaying(page);

  // A sound this page hasn't loaded yet comes from the cache.
  const chunk = page.waitForResponse((response) => /\/pink-noise-[\w-]+\.js$/.test(response.url()));
  await page.locator(".panel").hover();
  await page.keyboard.press("/");
  const search = page.getByRole("combobox", { name: "Search sounds" });
  await search.fill("pink");
  await search.press("Enter");
  const response = await chunk;
  expect(response.fromServiceWorker()).toBe(true);
  expect(response.status()).toBe(200);

  // It plays: its row's tint dot follows its level.
  const row = page.locator('.layer[data-layer-id="pink-noise"]');
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.locator(".panel").hover();
  await expect
    .poll(async () =>
      Number(
        await row.locator(".layer-dot").evaluate((el) => el.style.getPropertyValue("--level")),
      ),
    )
    .toBeGreaterThan(0.1);
  await expect(page.locator('button[aria-label="Pause"]')).toBeVisible();

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test("offers a new deploy in a toast, and switches to it only on Reload", async ({ page }) => {
  const { errors } = watch(page);
  await openControlled(page);
  const oldCache = `aural-farm-${currentVersion()}`;
  newVersion = "0123456789abcdef";

  // A navigation checks for a new worker, which installs and waits.
  await page.reload();
  await startPlaying(page);
  await page.evaluate(() => {
    Object.assign(window, { sameDocument: true });
  });
  const toast = page.getByRole("status").filter({ hasText: "A new version is ready" });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await expect(toast).toContainText("Reloading keeps your mix but stops the sound.");
  expect(Object.keys(await cached(page)).toSorted()).toEqual(
    [oldCache, "aural-farm-0123456789abcdef"].toSorted(),
  );

  // It never reloads by itself.
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => "sameDocument" in window)).toBe(true);

  await toast.getByRole("button", { name: "Reload" }).click();
  await page.waitForFunction(() => !("sameDocument" in window));
  await expect(page.getByRole("heading", { name: "Starship Engine Core" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "A new version" })).toHaveCount(0);
  // The new worker took over and cleared the old build's cache.
  await expect
    .poll(async () => Object.keys(await cached(page)))
    .toEqual(["aural-farm-0123456789abcdef"]);
  expect(errors).toEqual([]);
});
