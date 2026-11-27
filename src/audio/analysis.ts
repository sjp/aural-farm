/**
 * Measurements of rendered audio, for tests: pure functions over sample arrays.
 */
import { filterSamples, type BiquadCoefficients } from "./biquad";

/** The sample rate the K-weighting coefficients are given for. */
const K_WEIGHTING_RATE = 48000;

/**
 * ITU-R BS.1770's K-weighting at 48 kHz: a high shelf of about +4 dB above 1.5 kHz
 * (the head's effect), then a high-pass near 38 Hz (the revised low-frequency
 * B-curve).
 */
const K_WEIGHTING: readonly BiquadCoefficients[] = [
  {
    b0: 1.53512485958697,
    b1: -2.69169618940638,
    b2: 1.19839281085285,
    a1: -1.69065929318241,
    a2: 0.73248077421585,
  },
  { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 },
];

/**
 * The loudness of `channels` (left and right, or one channel) as BS.1770 defines
 * it without gating: −0.691 + 10·log10 of the summed mean squares of the
 * K-weighted channels. In LUFS; samples must be at 48 kHz. Skips the first
 * `settleSeconds` of each filtered channel, while the high-pass settles.
 */
export function kWeightedLoudness(
  channels: readonly Float32Array[],
  sampleRate: number,
  settleSeconds = 0,
): number {
  if (sampleRate !== K_WEIGHTING_RATE) {
    throw new Error(`K-weighting needs ${String(K_WEIGHTING_RATE)} Hz audio`);
  }
  const skip = Math.round(settleSeconds * sampleRate);
  let total = 0;
  for (const channel of channels) {
    let weighted = channel;
    for (const stage of K_WEIGHTING) {
      weighted = filterSamples(stage, weighted);
    }
    let sum = 0;
    for (let i = skip; i < weighted.length; i++) {
      const v = weighted[i] ?? 0;
      sum += v * v;
    }
    total += sum / Math.max(1, weighted.length - skip);
  }
  return -0.691 + 10 * Math.log10(total);
}
