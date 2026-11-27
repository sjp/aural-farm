/**
 * The Media Session: what the lock screen, the notification shade and media keys
 * show and do. The mix plays as a live stream, so there is no position, seeking
 * or track skipping, only play, pause and stop.
 */
import { isPlaying, type EngineState } from "../audio/engine";

/** What the session's buttons do. */
export interface MediaSessionActions {
  play: () => void;
  pause: () => void;
  /** Pauses, and also ends anything that would start or stop playback later. */
  stop: () => void;
}

/** The parts of `navigator.mediaSession` used here; tests pass a fake. */
export type MediaSessionLike = Pick<
  MediaSession,
  "metadata" | "playbackState" | "setActionHandler"
>;

/** Makes the session's metadata: `MediaMetadata`, injected so tests can pass a stand-in. */
export type MetadataFactory = (init: MediaMetadataInit) => MediaMetadata;

const ARTIST = "Aural Farm";

/** The app's icon, relative to the page so it works under a subpath. */
const ARTWORK: MediaImage[] = [
  { src: "icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "icon-512.png", sizes: "512x512", type: "image/png" },
  { src: "favicon.svg", sizes: "any", type: "image/svg+xml" },
];

/** Actions a live stream has no use for, which the session should show no button for. */
const UNUSED_ACTIONS: readonly MediaSessionAction[] = [
  "seekbackward",
  "seekforward",
  "seekto",
  "previoustrack",
  "nexttrack",
];

/** The title the session shows: the mix's name, or else its sounds joined with " + ". */
export function mediaTitle(names: readonly string[], mixName?: string): string {
  if (mixName !== undefined) {
    return mixName;
  }
  return names.length === 0 ? ARTIST : names.join(" + ");
}

/** The session's playback state for an engine state. */
export function sessionPlaybackState(state: EngineState): MediaSessionPlaybackState {
  if (state === "idle" || state === "failed") {
    return "none";
  }
  return isPlaying(state) ? "playing" : "paused";
}

/** Sets or clears one action's handler; browsers throw for actions they don't know. */
function setHandler(
  session: MediaSessionLike,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // Not supported here: there's no button to set up.
  }
}

/** Points the session's play, pause and stop at `actions`; returns a function that unbinds them. */
export function bindMediaSession(
  session: MediaSessionLike,
  actions: MediaSessionActions,
): () => void {
  setHandler(session, "play", actions.play);
  setHandler(session, "pause", actions.pause);
  setHandler(session, "stop", actions.stop);
  for (const action of UNUSED_ACTIONS) {
    setHandler(session, action, null);
  }
  return () => {
    for (const action of ["play", "pause", "stop"] as const) {
      setHandler(session, action, null);
    }
  };
}

/** Shows `title` (by Aural Farm, with the app's icon) as what's playing. */
export function setMediaMetadata(
  session: MediaSessionLike,
  title: string,
  makeMetadata: MetadataFactory,
): void {
  session.metadata = makeMetadata({ title, artist: ARTIST, artwork: ARTWORK });
}
