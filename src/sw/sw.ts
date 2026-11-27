/**
 * The service worker: precaches the whole build, so the app installs and plays
 * offline (every sound is synthesised in the page, so the built files are all it
 * needs), and answers requests as `strategy.ts` describes.
 *
 * The build's Vite plugin (`plugins/service-worker.ts`) bundles this file into
 * `sw.js` at the site root, replacing `SW_PRECACHE` with every file the build
 * emitted and `SW_VERSION` with a hash of them, so any change to the build
 * changes this file and the browser installs the new worker.
 *
 * A new worker installs in the background and waits until the page asks it to take
 * over (the "skip-waiting" message, sent when the user presses Reload), so a page
 * never has its files swapped under it. A first install has no worker to wait for:
 * it activates at once and takes control of the open page, so it works offline
 * without a reload.
 */
import { cacheName, respond, staleCaches } from "./strategy";

declare const SW_PRECACHE: readonly string[];
declare const SW_VERSION: string;

/** The worker's global scope, typed as a service worker's. */
function serviceWorkerScope(): ServiceWorkerGlobalScope {
  if (self instanceof ServiceWorkerGlobalScope) {
    return self;
  }
  throw new Error("sw.js runs only as a service worker");
}

const worker = serviceWorkerScope();
const CACHE = cacheName(SW_VERSION);
const scope = () => worker.registration.scope;

worker.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Past the HTTP cache, so a file is never cached from an older deploy.
      await cache.addAll(
        SW_PRECACHE.map((path) => new Request(new URL(path, scope()), { cache: "reload" })),
      );
    })(),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(staleCaches(await caches.keys(), CACHE).map((name) => caches.delete(name)));
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") {
    void worker.skipWaiting();
  }
});

worker.addEventListener("fetch", (event) => {
  const response = respond(event.request, scope(), {
    fetch: (request) => fetch(request),
    match: (request) => caches.match(request, { cacheName: CACHE }),
    indexUrl: new URL("index.html", scope()).href,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
  });
  if (response) {
    event.respondWith(response);
  }
});
