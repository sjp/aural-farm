/**
 * Where the engine's output goes: straight to the context's destination, or
 * through a hidden `<audio>` element playing a `MediaStreamAudioDestinationNode`'s
 * stream.
 */

/** "direct" connects to `ctx.destination`; "media" plays through an `<audio>` element. */
type OutputRoute = "direct" | "media";

/** The Audio output preference: "auto" lets `chooseOutputRoute` decide. */
export type OutputPreference = "auto" | OutputRoute;

/** What the browser and device offer, as far as the output route cares. */
export interface OutputFeatures {
  /** `AudioContext.prototype.createMediaStreamDestination` exists. */
  mediaStreamDestination: boolean;
  /** `navigator.mediaSession` exists. */
  mediaSession: boolean;
  /** The primary pointer is coarse: a phone or tablet. */
  coarsePointer: boolean;
}

/**
 * Picks the output route.
 *
 * Phones treat a bare Web Audio graph as a sound effect rather than as media:
 * iOS Safari mutes it with the ring/silent switch and may stop it when the screen
 * locks, and neither iOS nor Android Chrome shows lock-screen or notification
 * controls for it. Both treat a playing `<audio>` element as media, so on a touch
 * device with Media Session (which covers iOS and iPadOS Safari and Android
 * Chrome) the output goes through one.
 *
 * Elsewhere it goes straight to the destination: the element adds latency and a
 * little work, and desktop browsers keep Web Audio playing in a background tab
 * anyway. Without `createMediaStreamDestination` there is no element route to take,
 * whatever the preference says.
 */
export function chooseOutputRoute(
  preference: OutputPreference,
  features: OutputFeatures,
): OutputRoute {
  if (!features.mediaStreamDestination) {
    return "direct";
  }
  if (preference !== "auto") {
    return preference;
  }
  return features.mediaSession && features.coarsePointer ? "media" : "direct";
}

/** The parts of an `<audio>` element the engine uses; tests pass a fake. */
export interface MediaOutputElement {
  srcObject: MediaProvider | null;
  readonly paused: boolean;
  play: () => Promise<void>;
  pause: () => void;
  addEventListener: (type: "pause", listener: () => void) => void;
  removeEventListener: (type: "pause", listener: () => void) => void;
}
