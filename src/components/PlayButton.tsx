import type { JSX } from "preact";
import { isPlaying, type EngineState } from "../audio/engine";
import { PauseIcon, PlayIcon } from "./icons";

/** Marks the controls that toggle playback themselves, so "play on first input" skips them. */
export const PLAY_TOGGLE_ATTRIBUTE = "data-play-toggle";

interface PlayButtonProps {
  state: EngineState;
  /** Whether to add the shortcut to the tooltip. */
  hover: boolean;
  onToggle: () => void;
}

/**
 * Play/Pause, with a spinner while the audio starts. When the browser blocked
 * autoplay it becomes a prominent "Tap to play".
 */
export function PlayButton({ state, hover, onToggle }: PlayButtonProps): JSX.Element {
  const toggle = { [PLAY_TOGGLE_ATTRIBUTE]: true };
  if (state === "blocked") {
    return (
      <button type="button" className="play-blocked" onClick={onToggle} {...toggle}>
        <PlayIcon />
        Tap to play
      </button>
    );
  }
  const playing = isPlaying(state);
  const label = playing ? "Pause" : "Play";
  return (
    <button
      type="button"
      className="icon-button play-button"
      aria-label={label}
      title={hover ? `${label} (Space)` : label}
      aria-busy={state === "starting"}
      disabled={state === "failed"}
      onClick={onToggle}
      {...toggle}
    >
      {state === "starting" ? <span className="spinner" /> : playing ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
}
