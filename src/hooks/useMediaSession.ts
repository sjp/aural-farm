import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { EngineState } from "../audio/engine";
import {
  bindMediaSession,
  sessionPlaybackState,
  setMediaMetadata,
  type MediaSessionActions,
  type MediaSessionLike,
  type MetadataFactory,
} from "../lib/media-session";

/**
 * Keeps the Media Session in step with the app: its buttons call `actions`, it
 * shows `title`, and its playback state mirrors `state`. With no session (or no
 * `MediaMetadata`) it does nothing.
 */
export function useMediaSession(
  title: string,
  state: EngineState,
  actions: MediaSessionActions,
  session: MediaSessionLike | undefined,
  makeMetadata: MetadataFactory | undefined,
): void {
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  useEffect(() => {
    if (!session) {
      return undefined;
    }
    const unbind = bindMediaSession(session, {
      play: () => {
        actionsRef.current.play();
      },
      pause: () => {
        actionsRef.current.pause();
      },
      stop: () => {
        actionsRef.current.stop();
      },
    });
    return () => {
      unbind();
      session.metadata = null;
      session.playbackState = "none";
    };
  }, [session]);

  useEffect(() => {
    if (session && makeMetadata) {
      setMediaMetadata(session, title, makeMetadata);
    }
  }, [session, title, makeMetadata]);

  useEffect(() => {
    if (session) {
      session.playbackState = sessionPlaybackState(state);
    }
  }, [session, state]);
}
