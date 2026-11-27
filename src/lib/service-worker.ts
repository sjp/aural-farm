/**
 * Registers the service worker (production builds only) and tells the app when a
 * new version has installed and is waiting.
 *
 * The worker never takes over by itself: a page keeps the files it loaded until
 * the user presses Reload, which asks the waiting worker to take over and reloads
 * once it has. Nothing here reloads the page otherwise, so playback is never cut
 * short without the user asking.
 */
import { SKIP_WAITING } from "../sw/strategy";
import { createStore } from "./store";

/** The parts of a `ServiceWorker` used here; tests pass a fake. */
export interface WorkerLike {
  readonly state: ServiceWorkerState;
  postMessage: (message: unknown) => void;
  addEventListener: (type: "statechange", listener: () => void) => void;
}

/** The parts of a `ServiceWorkerRegistration` used here. */
export interface RegistrationLike {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  update: () => Promise<unknown>;
  addEventListener: (type: "updatefound", listener: () => void) => void;
}

/** The parts of a `ServiceWorkerContainer` used here. */
export interface ContainerLike {
  readonly controller: unknown;
  addEventListener: (type: "controllerchange", listener: () => void) => void;
}

/** Checks for a new version at most this often, when the page is shown again. */
export const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** A new version of the app, as the page sees it. */
export interface AppUpdates {
  /** Calls `listener` when `ready` changes; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Whether a new version has installed and waits for this page to reload. */
  ready: () => boolean;
  /** Hands over to the new version, and reloads the page once it has taken over. */
  apply: () => void;
  /** Asks the server for a new version, unless it was asked in the last hour. */
  check: () => void;
}

interface ServiceWorkerOptions {
  container: ContainerLike;
  /** Registers the worker; may wait for the page to finish loading first. */
  register: () => Promise<RegistrationLike>;
  reload: () => void;
}

/** Registers the service worker and watches for new versions of it. */
export function registerServiceWorker({
  container,
  register,
  reload,
}: ServiceWorkerOptions): AppUpdates {
  const ready = createStore(false);
  let registration: RegistrationLike | undefined;
  let waiting: WorkerLike | undefined;
  let reloading = false;
  let lastCheck = Date.now();

  // A worker installed while no worker controls the page is the first install,
  // which nothing has to reload for.
  const offer = (worker: WorkerLike) => {
    if (container.controller !== null) {
      waiting = worker;
      ready.set(true);
    }
  };
  const track = (worker: WorkerLike) => {
    if (worker.state === "installed") {
      offer(worker);
      return;
    }
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") {
        offer(worker);
      }
    });
  };

  container.addEventListener("controllerchange", () => {
    // Another tab's Reload hands over too: this page reloads only when asked to.
    if (reloading) {
      reload();
    }
  });

  register()
    .then((reg) => {
      registration = reg;
      if (reg.waiting) {
        offer(reg.waiting);
      }
      if (reg.installing) {
        track(reg.installing);
      }
      reg.addEventListener("updatefound", () => {
        if (reg.installing) {
          track(reg.installing);
        }
      });
      return undefined;
    })
    .catch(() => {
      // No worker (a private window, storage blocked): the app works as a plain page.
    });

  return {
    subscribe: ready.subscribe,
    ready: ready.get,
    apply() {
      if (!waiting || reloading) {
        return;
      }
      if (waiting.state !== "installed") {
        // Already taken over (from another tab) or replaced: a reload picks up what's current.
        reload();
        return;
      }
      reloading = true;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage takes no origin
      waiting.postMessage(SKIP_WAITING);
    },
    check() {
      if (!registration || Date.now() - lastCheck < UPDATE_CHECK_MS) {
        return;
      }
      lastCheck = Date.now();
      registration.update().catch(() => {
        // Offline, or the server is down: try again next time.
      });
    },
  };
}
