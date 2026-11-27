/** Small stroke icons for the panel's buttons. They inherit the text colour. */
import type { JSX } from "preact";

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export const LinkIcon = () => (
  <Icon d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
);
export const FullscreenIcon = () => <Icon d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />;
export const ClockIcon = () => (
  <Icon d="M12 7.5V12l3 2M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0z" />
);
export const HideIcon = () => <Icon d="M9 6l6 6-6 6" />;
export const SlidersIcon = () => (
  <Icon d="M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6" size={20} />
);
export const ResetIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path
      d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 2.5v2.6h2.6"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);
export const ChevronIcon = () => (
  <svg className="section-chevron" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
    <path
      d="M7.5 5l5 5-5 5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);
/** A filled icon, for the play and pause buttons. */
function FilledIcon({ d }: { d: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

export const PlayIcon = () => (
  <FilledIcon d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z" />
);
export const PauseIcon = () => <FilledIcon d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />;
export const CloseIcon = () => <Icon d="M6 6l12 12M18 6L6 18" size={16} />;
export const PlusIcon = () => <Icon d="M12 5v14M5 12h14" size={16} />;
export const SpeakerIcon = () => (
  <Icon d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
);
export const SpeakerMutedIcon = () => (
  <Icon d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5" />
);
/** A star, filled when the sound is starred. */
export const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
  </svg>
);
