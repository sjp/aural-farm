// @vitest-environment happy-dom
import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "../audio/engine";
import { act } from "../test/act";
import { fakeMediaSession } from "../test/fake-media";
import { useMediaSession } from "./useMediaSession";

const metadata = (init: MediaMetadataInit) => ({ ...init }) as unknown as MediaMetadata;

function setup() {
  const { session, handlers } = fakeMediaSession();
  const actions = {
    play: vi.fn<() => void>(),
    pause: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
  };
  const hook = renderHook(
    ({ title, state }: { title: string; state: EngineState }) => {
      useMediaSession(title, state, actions, session, metadata);
    },
    { initialProps: { title: "Rain", state: "idle" } },
  );
  return { session, handlers, actions, ...hook };
}

describe("useMediaSession", () => {
  it("points the session's buttons at the actions", () => {
    const { handlers, actions } = setup();
    handlers.get("play")?.({ action: "play" });
    handlers.get("pause")?.({ action: "pause" });
    handlers.get("stop")?.({ action: "stop" });
    expect(actions.play).toHaveBeenCalledOnce();
    expect(actions.pause).toHaveBeenCalledOnce();
    expect(actions.stop).toHaveBeenCalledOnce();
  });

  it("updates the metadata when the mix changes", () => {
    const { session, rerender } = setup();
    expect(session.metadata?.title).toBe("Rain");
    rerender({ title: "Rain + Fan", state: "idle" });
    expect(session.metadata?.title).toBe("Rain + Fan");
  });

  it("mirrors the engine's state", () => {
    const { session, rerender } = setup();
    expect(session.playbackState).toBe("none");
    rerender({ title: "Rain", state: "playing" });
    expect(session.playbackState).toBe("playing");
    rerender({ title: "Rain", state: "interrupted" });
    expect(session.playbackState).toBe("paused");
  });

  it("removes its handlers and metadata on unmount", () => {
    const { session, handlers, unmount } = setup();
    act(() => {
      unmount();
    });
    expect(handlers.get("play")).toBeNull();
    expect(handlers.get("pause")).toBeNull();
    expect(handlers.get("stop")).toBeNull();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });

  it("does nothing without a session", () => {
    expect(() =>
      renderHook(() => {
        useMediaSession(
          "Rain",
          "playing",
          { play: vi.fn<() => void>(), pause: vi.fn<() => void>(), stop: vi.fn<() => void>() },
          undefined,
          metadata,
        );
      }),
    ).not.toThrow();
  });
});
