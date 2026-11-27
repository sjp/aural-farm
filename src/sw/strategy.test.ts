import { describe, expect, it, vi } from "vitest";
import {
  cacheName,
  NAVIGATION_TIMEOUT_MS,
  respond,
  routeFor,
  staleCaches,
  type RequestLike,
  type StrategyDeps,
} from "./strategy";

const SCOPE = "https://example.test/aural-farm/";
const INDEX = `${SCOPE}index.html`;

function request(path: string, mode: RequestMode = "cors", method = "GET"): RequestLike {
  return { url: new URL(path, SCOPE).href, mode, method };
}

const page = () => request("./", "navigate");

/** A fake worker: a cache of URL → body, and a network that can answer, fail or hang. */
function fakeWorker(network: "online" | "offline" | "hanging", cached: Record<string, string>) {
  const fetch = vi.fn<(r: RequestLike) => Promise<Response>>((r) => {
    if (network === "online") {
      return Promise.resolve(new Response(`network ${r.url}`));
    }
    if (network === "offline") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return new Promise<Response>(() => {
      // Never settles.
    });
  });
  const cache = new Map(Object.entries(cached));
  const match = vi.fn<(r: RequestLike | string) => Promise<Response | undefined>>((r) => {
    const body = cache.get(typeof r === "string" ? r : r.url);
    return Promise.resolve(body === undefined ? undefined : new Response(body));
  });
  const deps: StrategyDeps<RequestLike> = {
    fetch,
    match,
    indexUrl: INDEX,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
  };
  return { deps, fetch, match };
}

async function text(response: Promise<Response> | undefined): Promise<string> {
  if (!response) {
    throw new Error("The worker left the request to the browser");
  }
  return (await response).text();
}

describe("routeFor", () => {
  it.each([
    { what: "a navigation in scope", r: request("./", "navigate"), route: "navigation" },
    { what: "a navigation with a query", r: request("./?a=1", "navigate"), route: "navigation" },
    { what: "a script", r: request("assets/index-abc.js"), route: "asset" },
    { what: "a worklet", r: request("assets/audio.worklet-x.js", "same-origin"), route: "asset" },
    { what: "the manifest", r: request("manifest.webmanifest", "no-cors"), route: "asset" },
    { what: "a POST", r: request("x", "cors", "POST"), route: undefined },
    { what: "a cross-origin script", r: request("https://cdn.test/x.js"), route: undefined },
    {
      what: "a cross-origin navigation",
      r: request("https://other.test/aural-farm/", "navigate"),
      route: undefined,
    },
    { what: "a same-origin URL outside the scope", r: request("/other/x.js"), route: undefined },
  ])("routes $what to $route", ({ r, route }) => {
    expect(routeFor(r, SCOPE)).toBe(route);
  });
});

describe("respond", () => {
  it("serves a navigation from the network when online, without caching it", async () => {
    const { deps, match } = fakeWorker("online", { [INDEX]: "cached page" });
    expect(await text(respond(page(), SCOPE, deps))).toBe(`network ${SCOPE}`);
    expect(match).not.toHaveBeenCalled();
  });

  it("serves the cached page for a navigation when offline", async () => {
    const { deps } = fakeWorker("offline", { [INDEX]: "cached page" });
    expect(await text(respond(page(), SCOPE, deps))).toBe("cached page");
  });

  it("serves the cached page once the network has taken the timeout to answer", async () => {
    const { deps } = fakeWorker("hanging", { [INDEX]: "cached page" });
    let settled = false;
    const response = respond(page(), SCOPE, deps)?.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await text(response)).toBe("cached page");
  });

  it("fails a navigation offline as the browser would when nothing is cached yet", async () => {
    const { deps } = fakeWorker("offline", {});
    await expect(respond(page(), SCOPE, deps)).rejects.toThrow(TypeError);
  });

  it("serves a cached asset without touching the network", async () => {
    const asset = request("assets/rain-abc.js");
    const { deps, fetch } = fakeWorker("online", { [asset.url]: "cached rain" });
    expect(await text(respond(asset, SCOPE, deps))).toBe("cached rain");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches an asset that isn't cached", async () => {
    const asset = request("assets/new-abc.js");
    const { deps } = fakeWorker("online", {});
    expect(await text(respond(asset, SCOPE, deps))).toBe(`network ${asset.url}`);
  });

  it("fails an uncached asset offline", async () => {
    const { deps } = fakeWorker("offline", {});
    await expect(respond(request("assets/new-abc.js"), SCOPE, deps)).rejects.toThrow(TypeError);
  });

  it("leaves cross-origin requests to the browser, reading neither cache nor network", () => {
    const { deps, fetch, match } = fakeWorker("online", {});
    expect(respond(request("https://cdn.test/font.woff2"), SCOPE, deps)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
  });
});

describe("caches", () => {
  it("names a build's cache after its version", () => {
    expect(cacheName("0123abcd")).toBe("aural-farm-0123abcd");
  });

  it("finds the worker's caches from other builds, and leaves other caches alone", () => {
    const current = cacheName("new");
    expect(
      staleCaches([cacheName("old"), current, "someone-else", cacheName("older")], current),
    ).toEqual([cacheName("old"), cacheName("older")]);
  });
});
