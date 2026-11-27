/**
 * Every pass mark the browser sound checks use, in one place, and the sounds
 * that are allowed to miss one, each with its reason. A sound that needs an
 * exception gets it here, never in the spec.
 */
import type { SoundMeta } from "../src/sounds/types";

const CI = (process.env.CI ?? "") !== "";

export const THRESHOLDS = {
  /** Not silent: 10 s at defaults reads above this, in LUFS. */
  audibleLufs: -50,
  /** Long-term loudness at defaults and layer volume 1, in LUFS: about −23 (EBU R 128's target). */
  targetLufs: -23,
  /** How far each seed's 30 s loudness may stray from the target, in dB. */
  levelToleranceDb: 3,
  /** No param set may peak above this, in dBFS: headroom for several layers before the limiter. */
  peakDbfs: -3,
  /**
   * Every param set reads above this, in LUFS, unless it is meant to be silent
   * (see `silentSets`): a param alone shouldn't make a sound vanish.
   */
  paramSetMinLufs: -60,
  /** And below this: a param alone shouldn't make a layer dominate a mix (8 dB over the target). */
  paramSetMaxLufs: -15,
  /** The largest mean sample value: anything more is wasted headroom and a thump on start. */
  dcOffset: 0.002,
  /** Energy below 25 Hz against the whole, in dB: the master cuts it, so it only costs headroom. */
  subBassDb: -20,
  /** How much quieter the mono sum may be than the stereo signal, in dB (unrelated channels: 3). */
  monoLossDb: 4,
  /**
   * Energy at 150 Hz–4 kHz against the whole, in dB: what a laptop or phone speaker
   * can play. Below this the sound all but disappears on small speakers.
   */
  speakersDb: -25,
  /**
   * Two renders with the same seed differ by at most this, in dB against the
   * signal: identical but for float rounding. Chromium's native nodes don't
   * always round the same way twice (seen with audio-rate modulated params), so
   * this allows differences in the last bits, about −127 dB, and nothing more.
   */
  determinismDb: -120,
  /**
   * Rendered from absolute time 10 s, a sound matches a render from 0 after a 2 s
   * settle: the difference is at least this far below the signal, in dB.
   */
  timeAddressableDb: -30,
  /** The click score at a param change or a seed change, in dB (clean audio: about 0). */
  clickDb: 6,
  /** How far the loudness may swing through a seed crossfade, in dB either way. */
  seedSwingDb: 2,
  /** How far the RMS level at 44.1 kHz may differ from 48 kHz, in dB: sounds work in Hz and seconds. */
  sampleRateDb: 1,
  /**
   * The mix check: with every sound at volume 70, the limiter's gain reduction
   * stays under 1 dB for 95 % of readings.
   */
  mixReductionDb: 1,
  mixReductionShare: 0.95,
} as const;

type ThresholdName = keyof typeof THRESHOLDS;

/** Render time ÷ audio time for one layer at defaults, by its metadata's `cost`. */
export const COST_BUDGET: Readonly<Record<SoundMeta["cost"], number>> = {
  "very low": 0.002,
  low: 0.005,
  medium: 0.015,
};

/**
 * The budgets hold on the developer's machine. Shared CI runners are slower
 * and noisier, so CI allows twice the budget: it still catches a sound that
 * blows its budget, without failing on a busy runner.
 */
export const COST_SLACK = CI ? 2 : 1;

interface Exception {
  value: number;
  reason: string;
}

interface SoundExceptions {
  /** Thresholds this sound is held to instead of the ones above. */
  thresholds?: Partial<Record<ThresholdName, Exception>>;
  /** Param sets (as `paramSets` names them, e.g. "volume=min") meant to be silent, with why. */
  silentSets?: Readonly<Record<string, string>>;
}

const NOISE_SUB_BASS: Exception = {
  value: -12,
  reason:
    "1/f noise high-passed at 30 Hz (12 dB per octave) keeps 4–6 % of its power below " +
    "25 Hz. A steeper cut would thin the low end the colour is chosen for; the master's " +
    "high-pass takes the rest.",
};

const EXCEPTIONS: Readonly<Record<string, SoundExceptions>> = {
  "brown-noise": { thresholds: { subBassDb: NOISE_SUB_BASS } },
  "grey-noise": { thresholds: { subBassDb: NOISE_SUB_BASS } },
  "pink-noise": { thresholds: { subBassDb: NOISE_SUB_BASS } },
};

/** The pass mark `id` is held to for `name`. */
export function threshold(id: string, name: ThresholdName): number {
  return EXCEPTIONS[id]?.thresholds?.[name]?.value ?? THRESHOLDS[name];
}

/** Whether `id`'s param set `set` is meant to be silent. */
export function silentSet(id: string, set: string): boolean {
  return EXCEPTIONS[id]?.silentSets?.[set] !== undefined;
}
