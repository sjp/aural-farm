/**
 * Installing the app from the page. Where the browser offers to install it, it
 * fires `beforeinstallprompt`; the app keeps that event, so an "Install app"
 * button can show the browser's install dialog later, and forgets it once the app
 * is installed. Browsers without the event (Safari, Firefox) install from their own
 * menus, and the button doesn't show.
 */
import { createStore } from "./store";

/** The `beforeinstallprompt` event (not in TypeScript's DOM types). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
}

function isInstallPrompt(event: Event): event is BeforeInstallPromptEvent {
  return "prompt" in event && typeof event.prompt === "function";
}

/** Whether the app can be installed from the page, and the button that does it. */
export interface InstallPrompt {
  /** Calls `listener` when `available` changes; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Whether the browser has offered to install the app. */
  available: () => boolean;
  /** Shows the browser's install dialog. The offer is used up either way. */
  prompt: () => void;
}

/** Listens on `target` (the window) for the browser's offer to install the app. */
export function createInstallPrompt(target: Pick<EventTarget, "addEventListener">): InstallPrompt {
  const offer = createStore<BeforeInstallPromptEvent | undefined>(undefined);
  target.addEventListener("beforeinstallprompt", (event) => {
    if (isInstallPrompt(event)) {
      // Keeps the browser's own banner away: the Display section offers it instead.
      event.preventDefault();
      offer.set(event);
    }
  });
  target.addEventListener("appinstalled", () => {
    offer.set(undefined);
  });
  return {
    subscribe: offer.subscribe,
    available: () => offer.get() !== undefined,
    prompt() {
      const event = offer.get();
      if (!event) {
        return;
      }
      // An event can prompt once; the browser fires a new one if it offers again.
      offer.set(undefined);
      event.prompt().catch(() => {
        // Already shown, or the page lost the user's gesture: nothing to do.
      });
    },
  };
}
