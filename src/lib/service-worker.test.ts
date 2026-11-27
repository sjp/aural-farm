import { describe, expect, it, vi } from "vitest";
import { SKIP_WAITING } from "../sw/strategy";
import {
  registerServiceWorker,
  UPDATE_CHECK_MS,
  type ContainerLike,
  type RegistrationLike,
  type WorkerLike,
} from "./service-worker";

class FakeWorker extends EventTarget implements WorkerLike {
  state: ServiceWorkerState = "installing";
  readonly messages: unknown[] = [];

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  moveTo(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn<() => Promise<unknown>>(() => Promise.resolve(undefined));

  /** A new worker starts installing, as after an update check finds a new sw.js. */
  find(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
    return worker;
  }
}

class FakeContainer extends EventTarget implements ContainerLike {
  controller: unknown = null;

  /** The page's controller changes, as when a waiting worker takes over. */
  takeOver(worker: unknown) {
    this.controller = worker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

/** A page whose worker registers with `registration`, controlled already unless `first`. */
async function setUp({ first = false, registration = new FakeRegistration() } = {}) {
  const container = new FakeContainer();
  container.controller = first ? null : new FakeWorker();
  const reload = vi.fn<() => void>();
  const updates = registerServiceWorker({
    container,
    register: () => Promise.resolve(registration),
    reload,
  });
  await vi.advanceTimersByTimeAsync(0);
  const changes = vi.fn<() => void>();
  updates.subscribe(changes);
  return { container, registration, reload, updates, changes };
}

describe("registerServiceWorker", () => {
  it("offers nothing while no new version is waiting", async () => {
    const { updates } = await setUp();
    expect(updates.ready()).toBe(false);
  });

  it("offers a new version once it has installed in the background", async () => {
    const { registration, updates, changes } = await setUp();
    const worker = registration.find();
    expect(updates.ready()).toBe(false);
    worker.moveTo("installed");
    expect(updates.ready()).toBe(true);
    expect(changes).toHaveBeenCalledOnce();
  });

  it("offers a version that was already waiting when the page loaded", async () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();
    registration.waiting.state = "installed";
    const { updates } = await setUp({ registration });
    expect(updates.ready()).toBe(true);
  });

  it("offers nothing for the first install, which activates by itself", async () => {
    const { registration, updates } = await setUp({ first: true });
    registration.find().moveTo("installed");
    expect(updates.ready()).toBe(false);
  });

  it("never reloads by itself, even when another tab hands over to the new version", async () => {
    const { container, registration, reload } = await setUp();
    const worker = registration.find();
    worker.moveTo("installed");
    worker.moveTo("activated");
    container.takeOver(worker);
    expect(reload).not.toHaveBeenCalled();
  });

  it("asks the waiting worker to take over on apply, then reloads once it has", async () => {
    const { container, registration, reload, updates } = await setUp();
    const worker = registration.find();
    worker.moveTo("installed");
    updates.apply();
    expect(worker.messages).toEqual([SKIP_WAITING]);
    expect(reload).not.toHaveBeenCalled();
    worker.moveTo("activated");
    container.takeOver(worker);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("asks only once when apply is pressed twice", async () => {
    const { registration, updates } = await setUp();
    const worker = registration.find();
    worker.moveTo("installed");
    updates.apply();
    updates.apply();
    expect(worker.messages).toEqual([SKIP_WAITING]);
  });

  it("reloads at once on apply when another tab has already handed over", async () => {
    const { registration, reload, updates } = await setUp();
    const worker = registration.find();
    worker.moveTo("installed");
    worker.moveTo("activated");
    updates.apply();
    expect(worker.messages).toEqual([]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does nothing on apply with no new version", async () => {
    const { reload, updates } = await setUp();
    updates.apply();
    expect(reload).not.toHaveBeenCalled();
  });

  it("checks for a new version at most once an hour", async () => {
    const { registration, updates } = await setUp();
    updates.check();
    expect(registration.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    updates.check();
    updates.check();
    expect(registration.update).toHaveBeenCalledOnce();
  });

  it("keeps working as a plain page when registering fails", async () => {
    const container = new FakeContainer();
    const updates = registerServiceWorker({
      container,
      register: () => Promise.reject(new DOMException("Blocked", "SecurityError")),
      reload: vi.fn<() => void>(),
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    updates.check();
    updates.apply();
    expect(updates.ready()).toBe(false);
  });

  it("ignores a failed update check", async () => {
    const registration = new FakeRegistration();
    registration.update.mockRejectedValue(new TypeError("Failed to fetch"));
    const { updates } = await setUp({ registration });
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    updates.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(registration.update).toHaveBeenCalledOnce();
  });
});
