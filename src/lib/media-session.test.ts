import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "../audio/engine";
import {
  bindMediaSession,
  mediaTitle,
  sessionPlaybackState,
  setMediaMetadata,
} from "./media-session";
import { fakeMediaSession } from "../test/fake-media";

const metadata = (init: MediaMetadataInit) => init as unknown as MediaMetadata;

describe("mediaTitle", () => {
  it("joins the sounds' names", () => {
    expect(mediaTitle(["Rain", "Brown Noise"])).toBe("Rain + Brown Noise");
  });

  it("falls back to the app's name for an empty mix", () => {
    expect(mediaTitle([])).toBe("Aural Farm");
  });

  it("shows a named mix's name instead", () => {
    expect(mediaTitle(["Rain", "Fireplace"], "Rainy Cabin")).toBe("Rainy Cabin");
    expect(mediaTitle([], "Empty")).toBe("Empty");
  });
});

describe("sessionPlaybackState", () => {
  it.each<[EngineState, MediaSessionPlaybackState]>([
    ["idle", "none"],
    ["failed", "none"],
    ["starting", "playing"],
    ["playing", "playing"],
    ["pausing", "paused"],
    ["paused", "paused"],
    ["blocked", "paused"],
    ["interrupted", "paused"],
  ])("%s is %s", (state, expected) => {
    expect(sessionPlaybackState(state)).toBe(expected);
  });
});

describe("bindMediaSession", () => {
  it("sets play, pause and stop, and clears the actions a live stream can't do", () => {
    const { session, handlers } = fakeMediaSession();
    const actions = {
      play: vi.fn<() => void>(),
      pause: vi.fn<() => void>(),
      stop: vi.fn<() => void>(),
    };
    bindMediaSession(session, actions);
    handlers.get("play")?.({ action: "play" });
    handlers.get("pause")?.({ action: "pause" });
    handlers.get("stop")?.({ action: "stop" });
    expect(actions.play).toHaveBeenCalledOnce();
    expect(actions.pause).toHaveBeenCalledOnce();
    expect(actions.stop).toHaveBeenCalledOnce();
    for (const action of ["seekbackward", "seekforward", "previoustrack", "nexttrack"] as const) {
      expect(handlers.has(action)).toBe(true);
      expect(handlers.get(action)).toBeNull();
    }
  });

  it("removes its handlers when unbound", () => {
    const { session, handlers } = fakeMediaSession();
    const unbind = bindMediaSession(session, {
      play: vi.fn<() => void>(),
      pause: vi.fn<() => void>(),
      stop: vi.fn<() => void>(),
    });
    unbind();
    expect(handlers.get("play")).toBeNull();
    expect(handlers.get("pause")).toBeNull();
    expect(handlers.get("stop")).toBeNull();
  });
});

describe("setMediaMetadata", () => {
  it("shows the title by Aural Farm with the app's icon", () => {
    const { session } = fakeMediaSession();
    setMediaMetadata(session, "Rain + Fan", metadata);
    expect(session.metadata).toMatchObject({
      title: "Rain + Fan",
      artist: "Aural Farm",
      artwork: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "favicon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    });
  });
});
