import { describe, expect, it, vi } from "vitest";
import { createInstallPrompt } from "./install-prompt";

/** A `beforeinstallprompt` event whose dialog `prompt` opens. */
function offerEvent(prompt = vi.fn<() => Promise<unknown>>(() => Promise.resolve(undefined))) {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt });
  return { event, prompt };
}

describe("createInstallPrompt", () => {
  it("isn't available until the browser offers to install", () => {
    expect(createInstallPrompt(new EventTarget()).available()).toBe(false);
  });

  it("keeps the browser's offer, holding back its own banner", () => {
    const target = new EventTarget();
    const install = createInstallPrompt(target);
    const changes = vi.fn<() => void>();
    install.subscribe(changes);
    const { event } = offerEvent();
    target.dispatchEvent(event);
    expect(install.available()).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(changes).toHaveBeenCalledOnce();
  });

  it("shows the browser's dialog once, then waits for a new offer", () => {
    const target = new EventTarget();
    const install = createInstallPrompt(target);
    const { event, prompt } = offerEvent();
    target.dispatchEvent(event);
    install.prompt();
    install.prompt();
    expect(prompt).toHaveBeenCalledOnce();
    expect(install.available()).toBe(false);
  });

  it("isn't available once the app is installed", () => {
    const target = new EventTarget();
    const install = createInstallPrompt(target);
    target.dispatchEvent(offerEvent().event);
    target.dispatchEvent(new Event("appinstalled"));
    expect(install.available()).toBe(false);
  });

  it("ignores an event that can't prompt", () => {
    const target = new EventTarget();
    const install = createInstallPrompt(target);
    target.dispatchEvent(new Event("beforeinstallprompt"));
    expect(install.available()).toBe(false);
  });

  it("ignores a dialog that fails to open", async () => {
    const target = new EventTarget();
    const install = createInstallPrompt(target);
    const prompt = vi.fn<() => Promise<unknown>>(() =>
      Promise.reject(new DOMException("No gesture", "NotAllowedError")),
    );
    target.dispatchEvent(offerEvent(prompt).event);
    install.prompt();
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).toHaveBeenCalledOnce();
  });
});
