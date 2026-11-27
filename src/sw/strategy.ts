/**
 * How the service worker answers requests, kept free of the worker's globals so it
 * can be tested with fake requests, caches and timers.
 *
 * - Navigations go to the network first, so a deployed update is seen at once.
 *   When the network fails, or hasn't answered in `NAVIGATION_TIMEOUT_MS`, the
 *   cached `index.html` is served instead. A fresh page from the network is never
 *   cached: its hashed assets may not be cached yet, so the cached page always
 *   stays the one that belongs with the cached assets.
 * - Everything else in scope comes from the cache first, and from the network only
 *   when it isn't cached. The build's files are hashed or precached, so a cached
 *   copy is never stale for the worker that cached it.
 * - Anything cross-origin, outside the scope, or not a GET is left to the browser.
 *   The app makes no cross-origin requests, so nothing of that kind is cached.
 */

/** How long a navigation waits for the network before serving the cached page. */
export const NAVIGATION_TIMEOUT_MS = 3000;

/** The prefix of every cache the worker makes; the rest is the build's version. */
const CACHE_PREFIX = "aural-farm-";

/** The cache for a build. */
export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** The worker's caches from builds other than `current`, which activating deletes. */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}

/** The parts of a request the routing reads. */
export type RequestLike = Pick<Request, "url" | "method" | "mode">;

/** What the worker does with a request. */
type Route = "navigation" | "asset";

/** How the worker handles `request` under `scope`, or undefined to leave it to the browser. */
export function routeFor(request: RequestLike, scope: string): Route | undefined {
  if (request.method !== "GET" || !request.url.startsWith(scope)) {
    return undefined;
  }
  // A scope always ends in a path, so a URL starting with it is on the same origin.
  return request.mode === "navigate" ? "navigation" : "asset";
}

/** What the strategies need from the worker; tests pass fakes. */
export interface StrategyDeps<R extends RequestLike> {
  /** The network. */
  fetch: (request: R) => Promise<Response>;
  /** The current build's cache, by request or URL. */
  match: (request: R | string) => Promise<Response | undefined>;
  /** The cached page, as a URL: `index.html` under the scope. */
  indexUrl: string;
  setTimeout: (callback: () => void, ms: number) => unknown;
}

/** Waits up to `ms` for `promise`; undefined if it rejects or takes longer. */
function within<T>(
  promise: Promise<T>,
  ms: number,
  setTimer: StrategyDeps<RequestLike>["setTimeout"],
): Promise<T | undefined> {
  return new Promise((resolve) => {
    setTimer(() => {
      resolve(undefined);
    }, ms);
    promise.then(resolve).catch(() => {
      resolve(undefined);
    });
  });
}

/** Network first, with a timeout, falling back to the cached page. */
async function navigation<R extends RequestLike>(
  request: R,
  deps: StrategyDeps<R>,
): Promise<Response> {
  const network = deps.fetch(request);
  const response = await within(network, NAVIGATION_TIMEOUT_MS, deps.setTimeout);
  if (response) {
    return response;
  }
  const cached = await deps.match(deps.indexUrl);
  // Nothing cached (the worker is still installing): wait for the network after all.
  return cached ?? network;
}

/** Cache first, falling back to the network. */
async function asset<R extends RequestLike>(request: R, deps: StrategyDeps<R>): Promise<Response> {
  return (await deps.match(request)) ?? deps.fetch(request);
}

/**
 * The response the worker gives `request`, or undefined when the browser should
 * handle it as if there were no worker.
 */
export function respond<R extends RequestLike>(
  request: R,
  scope: string,
  deps: StrategyDeps<R>,
): Promise<Response> | undefined {
  const route = routeFor(request, scope);
  if (route === "navigation") {
    return navigation(request, deps);
  }
  if (route === "asset") {
    return asset(request, deps);
  }
  return undefined;
}
