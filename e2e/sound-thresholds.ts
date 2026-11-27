/**
 * Every pass mark the browser sound checks use, in one place, and the sounds
 * that are allowed to miss one, each with its reason. A sound that needs an
 * exception gets it here, never in the spec.
 */
import type { ParamValues, SoundMeta } from "../src/sounds/types";

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
  /**
   * Param combinations to check along with `paramSets`, which changes one param
   * at a time: settings that together make the sound loudest or strangest.
   */
  extraSets?: readonly { name: string; params: ParamValues }[];
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
  "engine-core": {
    extraSets: [
      { name: "power, pulse depth=max", params: { power: 100, pulseDepth: 100 } },
      {
        name: "everything up, fastest pulse",
        params: { power: 100, pulseDepth: 100, pulseRate: 1.6, room: 100, hiss: 100 },
      },
      { name: "highest pitch, full power", params: { pitch: 72, power: 100, pulseDepth: 100 } },
    ],
  },
  rain: {
    // A downpour on each surface, close up, every drop plinking where the surface lets it.
    extraSets: (["ground", "leaves", "roof", "window", "tent"] as const).map((surface) => ({
      name: `${surface}, heaviest and closest`,
      params: { surface, intensity: 100, distance: 0, bubbles: 100 },
    })),
  },
  ocean: {
    // The biggest waves, close up, as often as they come, on each shore.
    extraSets: (["sand", "pebbles"] as const).map((shore) => ({
      name: `${shore}, biggest, closest and most frequent`,
      params: { shore, size: 100, distance: 0, period: 6 },
    })),
    thresholds: {
      seedSwingDb: {
        value: 12,
        reason:
          "The waves themselves swing the 1.5 s level by 15–20 dB, from the bed between waves " +
          "to a crash, so the windows around a seed change measure the waves, not the " +
          "crossfade (the shared equal-power crossfader the other sounds check).",
      },
    },
  },
  fireplace: {
    // The biggest, busiest fire of each wood, close up and far back.
    extraSets: (["hardwood", "softwood"] as const).flatMap((wood) => [
      { name: `${wood}, biggest and busiest`, params: { wood, size: 100, crackle: 100 } },
      {
        name: `${wood}, biggest and busiest, far back`,
        params: { wood, size: 100, crackle: 100, room: 100 },
      },
    ]),
  },
  wind: {
    // A gale at its gustiest, whistling fully, in each setting.
    extraSets: (["field", "trees", "house"] as const).map((setting) => ({
      name: `${setting}, strongest, gustiest, full whistle`,
      params: { setting, strength: 100, gustiness: 100, whistle: 100 },
    })),
  },
  thunder: {
    // The nearest, longest rumbles, as often as they come.
    extraSets: [
      { name: "storm, nearest, longest", params: { often: "storm", distance: 100, roll: 100 } },
    ],
    thresholds: {
      targetLufs: {
        value: -30,
        reason:
          "Rumbles come minutes apart, so no long-term level applies. A 30 s render from 0 holds " +
          "exactly one rumble (the first, 1.5–2.5 s in), whose short-term loudness peaks about " +
          "−21 to −24 LUFS: over the whole 30 s, with silence after it, that reads about −30.",
      },
      seedSwingDb: {
        value: 50,
        reason:
          "The first rumble swells in from silence 1.5–2.5 s in, at a different moment for each " +
          "seed, so the windows around a seed change measure silence against a rumble, not the " +
          "crossfade (the shared equal-power crossfader the other sounds check).",
      },
    },
  },
  stream: {
    // The fastest water, close up, as a brook and as a river.
    extraSets: [0, 100].map((size) => ({
      name: `size ${String(size)}, fastest and closest`,
      params: { size, flow: 100, distance: 0 },
    })),
  },
  insects: {
    // Every cricket, close by, on the warmest night, with the katydids; and the
    // sparsest, coolest night far off.
    extraSets: [
      {
        name: "most, warmest, closest, with katydids",
        params: { count: 12, warmth: 28, distance: 0, katydids: true },
      },
      { name: "fewest, coolest, farthest", params: { count: 1, warmth: 12, distance: 100 } },
    ],
    thresholds: {
      seedSwingDb: {
        value: 8,
        reason:
          "Each cricket sings in 8 s bouts with pauses between, and the nearest one or two set " +
          "most of the level, so a seed's level over the first 8 s swings by up to 7 dB with " +
          "who is singing (seed 1 starts with both near ones paused). The windows around a " +
          "seed change measure that, not the crossfade (the shared equal-power crossfader the " +
          "other sounds check); with no seed change they hold within 1 dB.",
      },
    },
  },
  birdsong: {
    // Every time of day at its busiest, close up.
    extraSets: (["dawn", "morning", "day"] as const).map((time) => ({
      name: `${time}, busiest and closest`,
      params: { time, density: 100, distance: 0 },
    })),
    thresholds: {
      seedSwingDb: {
        value: 12,
        reason:
          "Birdsong is phrases with silences between, and the nearest bird or two set most of " +
          "the level, so the 1.5 s level either side of any moment swings by 10 dB or more with " +
          "whether a near bird happens to be singing. The windows around a seed change measure " +
          "that, not the crossfade (the shared equal-power crossfader the other sounds check).",
      },
    },
  },
  "brown-noise": { thresholds: { subBassDb: NOISE_SUB_BASS } },
  "grey-noise": { thresholds: { subBassDb: NOISE_SUB_BASS } },
  "pink-noise": { thresholds: { subBassDb: NOISE_SUB_BASS } },
};

/** The pass mark `id` is held to for `name`. */
export function threshold(id: string, name: ThresholdName): number {
  return EXCEPTIONS[id]?.thresholds?.[name]?.value ?? THRESHOLDS[name];
}

/** The param combinations `id` is checked with beyond one change at a time. */
export function extraSets(id: string): readonly { name: string; params: ParamValues }[] {
  return EXCEPTIONS[id]?.extraSets ?? [];
}

/** Whether `id`'s param set `set` is meant to be silent. */
export function silentSet(id: string, set: string): boolean {
  return EXCEPTIONS[id]?.silentSets?.[set] !== undefined;
}
