import { render } from "preact";
import { App } from "./App";
import { createPreferences } from "./lib/preferences";
import { registerServiceWorker, type AppUpdates } from "./lib/service-worker";
import { parseHash } from "./mixes/mix";
import { createSoundLoader } from "./sounds/loader";
import { getSound } from "./sounds/registry";
import "./index.css";

// Read the hash before rendering and start loading its sounds now, so the
// downloads overlap the app's start-up.
const initial = parseHash(window.location.hash);
const loader = createSoundLoader();
for (const layer of initial.mix.layers) {
  const sound = getSound(layer.id);
  if (sound) {
    loader.prefetch(sound);
  }
}

/** Resolves once the page has loaded, so precaching doesn't compete with start-up. */
function loaded(): Promise<void> {
  return document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => {
        window.addEventListener(
          "load",
          () => {
            resolve();
          },
          { once: true },
        );
      });
}

// The service worker exists only in a build: `npm run dev` serves no sw.js.
const { serviceWorker } = navigator;
const updates: AppUpdates | undefined =
  import.meta.env.PROD && "serviceWorker" in navigator
    ? registerServiceWorker({
        container: serviceWorker,
        // Relative to the page, so the scope is the site's folder under a subpath.
        register: () => loaded().then(() => serviceWorker.register("sw.js")),
        reload: () => {
          window.location.reload();
        },
      })
    : undefined;

const root = document.getElementById("root");
if (root) {
  render(
    <App initial={initial} loader={loader} preferences={createPreferences()} updates={updates} />,
    root,
  );
}
