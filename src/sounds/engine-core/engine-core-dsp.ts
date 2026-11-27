/**
 * Starship Engine Core's waveforms and param mappings: pure functions with no
 * Web Audio globals, so they can be checked in Node.
 */
import { dbToGain } from "../../audio/glide";
import { pulseWave, type Wave } from "../../audio/lfo";

/** The pitch every frequency below is given for; they all scale with the `pitch` param. */
export const REFERENCE_PITCH = 48;

/** Harmonics in the drone's harmonic wave. */
export const HARMONICS = 8;
/** How much quieter the even harmonics are than the odd ones, in dB. */
export const EVEN_HARMONIC_DB = -3;
/** The harmonic wave's fundamental, relative to the centred sine's. */
export const HARMONIC_LEVEL = 0.55;

/**
 * The drone's harmonic wave: harmonics 1–8 falling at 6 dB per octave (amplitude
 * 1/k), the even ones 3 dB lower than the odd. The even harmonics start a
 * quarter-cycle later than the odd ones, which keeps their peaks from lining up:
 * the wave peaks at about 1.45 × its RMS, against a sawtooth's 1.77 with the
 * same levels, leaving headroom for the throb.
 */
export function droneWave(): Wave {
  const real = [0];
  const imag = [0];
  for (let k = 1; k <= HARMONICS; k++) {
    const level = (HARMONIC_LEVEL / k) * (k % 2 === 0 ? dbToGain(EVEN_HARMONIC_DB) : 1);
    const phase = k % 2 === 0 ? Math.PI / 2 : 0;
    real.push(level * Math.sin(phase));
    imag.push(level * Math.cos(phase));
  }
  return { real, imag };
}

/** The level of harmonic `k` in `wave`. */
export function harmonicLevel(wave: Wave, k: number): number {
  return Math.hypot(wave.real[k] ?? 0, wave.imag[k] ?? 0);
}

/**
 * The throb's shape: an asymmetric raised pulse, a quick rise over 35 % of the
 * cycle and a long fall, in 6 Fourier terms. Plus `offset`, it spans 0..1.
 */
export const THROB = pulseWave(0.35, 6);

/** The drone's low-pass cutoff at `power` (0–100) and `pitch`, before the throb opens it. */
export function droneCutoff(power: number, pitch: number): number {
  // 180 Hz at power 0 to 900 Hz at 100, evenly in octaves, at the reference pitch.
  const p = Math.min(1, Math.max(0, power / 100));
  return 180 * 5 ** p * (pitch / REFERENCE_PITCH);
}

/** How far the throb opens the cutoff at full depth: +60 %. */
export const THROB_BRIGHTNESS = 0.6;
/** The throb band's swell at full depth: its gain (+6 dB when added to the drone). */
export const THROB_LEVEL = 1;
/** The air's swell at full depth: +2 dB, as a gain above 1. */
export const THROB_AIR = dbToGain(2) - 1;

/** `pulseDepth` (0–100) as a fraction. */
export function throbDepth(pulseDepth: number): number {
  return Math.min(1, Math.max(0, pulseDepth / 100));
}

/** The reverb send's level at `room` (0–100): −40 dB to −12 dB. */
export function roomSendDb(room: number): number {
  return -40 + 28 * Math.min(1, Math.max(0, room / 100));
}

/** The throb band's centre, and the room resonances', as multiples of the pitch. */
export const THROB_BAND = 2.5;
export const RESONANCES = [3.1, 4.6, 7.3] as const;
