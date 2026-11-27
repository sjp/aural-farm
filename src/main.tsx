import { render } from "preact";
import { App } from "./App";
import { createPreferences } from "./lib/preferences";
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

const root = document.getElementById("root");
if (root) {
  render(<App initial={initial} loader={loader} preferences={createPreferences()} />, root);
}
