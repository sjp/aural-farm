/**
 * Binaural Beats' pure parts: the tones' frequencies, the isochronic mode's
 * pulse, the levels, and the period the whole repeats on.
 */
import { fourierWave, waveAt, type Wave } from "../../audio/lfo";
import { NOISE_RMS } from "../../audio/noise-dsp";
import type { BeatPreset } from "./binaural.meta";

/** Each preset's beat, in Hz; Custom takes the Custom beat param. */
const PRESET_BEATS: Readonly<Record<Exclude<BeatPreset, "custom">, number>> = {
  delta: 2,
  theta: 6,
  alpha: 10,
  beta: 18,
};

/** The beat, in Hz: the preset's, or `custom` when the preset is Custom. */
export function beatOf(preset: BeatPreset, custom: number): number {
  return preset === "custom" ? custom : PRESET_BEATS[preset];
}

/** The binaural tones, in Hz: `beat` apart, centred on `carrier`. */
export function toneFrequencies(carrier: number, beat: number): { left: number; right: number } {
  return { left: carrier - beat / 2, right: carrier + beat / 2 };
}

/** Each tone's peak level at full volume: about −26 LUFS for the pair. */
export const TONE_LEVEL = 0.058;

/** The isochronic pulse's low point, in dB below its peak: a swell, not an on/off. */
export const PULSE_FLOOR_DB = -14;
const PULSE_FLOOR = 10 ** (PULSE_FLOOR_DB / 20);
/** The pulse's Fourier terms, and its rise and fall, as a share of the cycle. */
const PULSE_HARMONICS = 4;
const PULSE_EDGE = 0.25;

/**
 * A pulse on for half of each cycle (measured at half height), its rise and
 * fall raised-cosine edges a quarter of the cycle long, band-limited to four
 * Fourier terms so it swells rather than clicks.
 */
function pulseShape(phase: number): number {
  if (phase < PULSE_EDGE) {
    return 0.5 - 0.5 * Math.cos((Math.PI * phase) / PULSE_EDGE);
  }
  if (phase < 0.5) {
    return 1;
  }
  if (phase < 0.5 + PULSE_EDGE) {
    return 0.5 + 0.5 * Math.cos((Math.PI * (phase - 0.5)) / PULSE_EDGE);
  }
  return 0;
}

/**
 * The isochronic tone's gain, as an LFO wave and a base value: `base + wave(φ)`
 * swings from the floor (−14 dB) to 1 (0 dB) over each cycle.
 */
export function pulseGain(): { wave: Wave; base: number } {
  const pulse = fourierWave(pulseShape, PULSE_HARMONICS);
  const depth = 1 - PULSE_FLOOR;
  return {
    wave: {
      real: pulse.real.map((v) => v * depth),
      imag: pulse.imag.map((v) => v * depth),
    },
    base: PULSE_FLOOR + depth * pulse.offset,
  };
}

/** Samples per cycle when averaging the pulse. */
const AVERAGE_POINTS = 1024;

/**
 * The isochronic tone's level: the tones' level, raised by the pulse's RMS
 * gain so that mode is about as loud as the binaural pair.
 */
export function isochronicLevel(): number {
  const { wave, base } = pulseGain();
  let power = 0;
  for (let m = 0; m < AVERAGE_POINTS; m++) {
    power += (base + waveAt(wave, m / AVERAGE_POINTS)) ** 2;
  }
  return TONE_LEVEL / Math.sqrt(power / AVERAGE_POINTS);
}

/** What the bed's 50 Hz–4 kHz band takes from pink noise's level, as a gain to make it up. */
const BAND_MAKEUP = 1.25;
/** The bed at Noise bed 100, in dB against the tones. */
const BED_MAX_DB = -8;

/**
 * The pink noise bed's gain at Noise bed `bed` (0–100): off at 0, 8 dB under
 * the tones' level at 100, and on a square-root curve between, so low settings
 * are still heard.
 */
export function bedGain(bed: number): number {
  const toneRms = TONE_LEVEL / Math.SQRT2;
  const max = ((toneRms * 10 ** (BED_MAX_DB / 20)) / NOISE_RMS) * BAND_MAKEUP;
  return max * Math.sqrt(Math.min(100, Math.max(0, bed)) / 100);
}

/** Steps per hertz of the grid every frequency falls on: Tone's 1 Hz step, and half the beat's 0.1 Hz. */
const GRID_PER_HZ = 20;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * The shortest time, in seconds, after which every one of `frequencies` is
 * back in the same phase: the inverse of their greatest common divisor, on the
 * 0.05 Hz grid they fall on. At most 20 s; 0.2 s for the default tones.
 */
export function wholePeriod(frequencies: readonly number[]): number {
  let divisor = 0;
  for (const f of frequencies) {
    divisor = gcd(divisor, Math.round(f * GRID_PER_HZ));
  }
  return GRID_PER_HZ / Math.max(1, divisor);
}
