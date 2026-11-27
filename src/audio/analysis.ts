/**
 * Measurements of rendered audio, for tests: pure functions over sample arrays.
 */
import {
  biquadCoefficients,
  BUTTERWORTH_Q,
  filterSamples,
  type BiquadCoefficients,
} from "./biquad";

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

/**
 * The K-weighted loudness of each `windowSeconds` window of `channels`, stepped by
 * `stepSeconds`, after `settleSeconds`: BS.1770's short-term loudness without
 * gating, for following a level over time. In LUFS; 48 kHz only.
 */
export function windowedLoudness(
  channels: readonly Float32Array[],
  sampleRate: number,
  windowSeconds: number,
  stepSeconds: number,
  settleSeconds = 0,
): number[] {
  if (sampleRate !== K_WEIGHTING_RATE) {
    throw new Error(`K-weighting needs ${String(K_WEIGHTING_RATE)} Hz audio`);
  }
  const weighted = channels.map((channel) =>
    K_WEIGHTING.reduce((signal, stage) => filterSamples(stage, signal), channel),
  );
  const length = Math.min(...weighted.map((w) => w.length));
  const window = Math.round(windowSeconds * sampleRate);
  const step = Math.max(1, Math.round(stepSeconds * sampleRate));
  const levels: number[] = [];
  for (
    let start = Math.round(settleSeconds * sampleRate);
    start + window <= length;
    start += step
  ) {
    let total = 0;
    for (const w of weighted) {
      total += meanSquare(w, start, start + window);
    }
    levels.push(-0.691 + 10 * Math.log10(total));
  }
  return levels;
}

/** The mean of `ch[i]²` for `from` ≤ i < `to`. */
function meanSquare(ch: Float32Array, from = 0, to = ch.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = ch[i] ?? 0;
    sum += v * v;
  }
  return sum / Math.max(1, to - from);
}

/** dB of a power ratio; silence is −Infinity. */
const powerDb = (power: number) => 10 * Math.log10(power);

/** The largest absolute sample, in dBFS (−Infinity for silence). */
export function peakDb(ch: Float32Array): number {
  let peak = 0;
  for (const v of ch) {
    peak = Math.max(peak, Math.abs(v));
  }
  return 20 * Math.log10(peak);
}

/** The RMS level, in dBFS: a full-scale sine reads −3 dB. */
export function rmsDb(ch: Float32Array): number {
  return powerDb(meanSquare(ch));
}

/** The mean sample value. */
export function dcOffset(ch: Float32Array): number {
  let sum = 0;
  for (const v of ch) {
    sum += v;
  }
  return sum / Math.max(1, ch.length);
}

/** In-place radix-2 FFT of (`re`, `im`); the length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const half = size >> 1;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const cos = Math.cos(angle * k);
        const sin = Math.sin(angle * k);
        const a = start + k;
        const b = a + half;
        const bRe = re[b] ?? 0;
        const bIm = im[b] ?? 0;
        const tRe = bRe * cos - bIm * sin;
        const tIm = bRe * sin + bIm * cos;
        const aRe = re[a] ?? 0;
        const aIm = im[a] ?? 0;
        re[b] = aRe - tRe;
        im[b] = aIm - tIm;
        re[a] = aRe + tRe;
        im[a] = aIm + tIm;
      }
    }
  }
}

/** The longest FFT segment the spectral measures use: about 2.9 Hz bins at 48 kHz. */
const MAX_SEGMENT = 16384;

/**
 * Welch's power spectrum of `ch`: Hann-windowed segments overlapping by half,
 * averaged. Entry k is the mean-square power in bin k (0 ≤ k ≤ size/2), with the
 * negative frequencies folded in, so the entries sum to about the mean square
 * of `ch`.
 */
function powerSpectrum(ch: Float32Array): Float64Array {
  let size = 2;
  while (size * 2 <= Math.min(MAX_SEGMENT, ch.length)) {
    size *= 2;
  }
  const window = Float64Array.from({ length: size }, (_, i) => Math.sin((Math.PI * i) / size) ** 2);
  const windowPower = window.reduce((sum, w) => sum + w * w, 0);
  const power = new Float64Array(size / 2 + 1);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let segments = 0;
  for (let start = 0; start + size <= ch.length; start += size / 2) {
    for (let i = 0; i < size; i++) {
      re[i] = (ch[start + i] ?? 0) * (window[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) {
      const fold = k === 0 || k === size / 2 ? 1 : 2;
      power[k] = (power[k] ?? 0) + (fold * ((re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2)) / windowPower;
    }
    segments++;
  }
  return power.map((p) => p / (size * Math.max(1, segments)));
}

/** The summed power of the bins of `spectrum` from `lo` Hz up to (not including) `hi`. */
function bandPower(spectrum: Float64Array, sampleRate: number, lo: number, hi: number): number {
  const binHz = sampleRate / (2 * (spectrum.length - 1));
  let sum = 0;
  for (let k = 0; k < spectrum.length; k++) {
    const f = k * binHz;
    if (f >= lo && f < hi) {
      sum += spectrum[k] ?? 0;
    }
  }
  return sum;
}

/**
 * The mean-square power of `ch` between `lo` and `hi` Hz, in dB, from an FFT:
 * the whole band (0 to Nyquist and above) reads about the same as `rmsDb`.
 */
export function bandEnergyDb(ch: Float32Array, sampleRate: number, lo: number, hi: number): number {
  return powerDb(bandPower(powerSpectrum(ch), sampleRate, lo, hi));
}

/**
 * The spectrum's tilt between `lo` and `hi` Hz, in dB per octave: a straight-line
 * fit of the power density of third-octave bands against octaves. White noise
 * reads 0, pink noise −3 and brown noise −6.
 */
export function spectralSlope(
  ch: Float32Array,
  sampleRate: number,
  lo: number,
  hi: number,
): number {
  const spectrum = powerSpectrum(ch);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let band = lo; band * 2 ** (1 / 3) <= hi * 1.0001; band *= 2 ** (1 / 3)) {
    const top = band * 2 ** (1 / 3);
    const power = bandPower(spectrum, sampleRate, band, top);
    if (power > 0) {
      xs.push(Math.log2(Math.sqrt(band * top)));
      ys.push(powerDb(power / (top - band)));
    }
  }
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * ((ys[i] ?? 0) - my);
    den += (x - mx) ** 2;
  });
  return num / den;
}

/** The correlation of the two channels: 1 for mono, 0 for unrelated, −1 for inverted. */
export function interChannelCorrelation(l: Float32Array, r: Float32Array): number {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < Math.min(l.length, r.length); i++) {
    const a = l[i] ?? 0;
    const b = r[i] ?? 0;
    lr += a * b;
    ll += a * a;
    rr += b * b;
  }
  return ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 0;
}

/**
 * How much quieter the mono sum ((L + R) / 2) is than the stereo signal (the mean
 * of the channels' power), in dB: 0 for mono, about 3 for unrelated channels,
 * Infinity for channels that cancel.
 */
export function monoLossDb(l: Float32Array, r: Float32Array): number {
  let stereo = 0;
  let mono = 0;
  for (let i = 0; i < Math.min(l.length, r.length); i++) {
    const a = l[i] ?? 0;
    const b = r[i] ?? 0;
    stereo += (a * a + b * b) / 2;
    mono += ((a + b) / 2) ** 2;
  }
  return powerDb(stereo / mono);
}

/** Clicks are measured above this, in Hz, where steady ambient sound has little energy. */
const CLICK_HIGHPASS_HZ = 6000;
/** The length of each window the click score compares, in seconds. */
const CLICK_WINDOW = 0.02;
/** Keeps silence from reading −Infinity. */
const CLICK_FLOOR = 1e-20;

/** The median of `values` (which it sorts). */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1
    ? (values[mid] ?? 0)
    : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}

/**
 * How far a click at `at` seconds stands out, in dB: the energy above 6 kHz in a
 * 20 ms window centred on `at`, against the median of the 20 ms windows in the
 * `span` seconds before it and, separately, after it, whichever is louder. A
 * change that brightens or darkens the sound moves one median but not the other,
 * so only a sudden burst scores high. Clean audio scores around 0 or below.
 */
export function clickScore(ch: Float32Array, sampleRate: number, at: number, span = 0.5): number {
  const highpass = biquadCoefficients(
    { type: "highpass", frequency: CLICK_HIGHPASS_HZ, Q: BUTTERWORTH_Q },
    sampleRate,
  );
  const high = filterSamples(highpass, filterSamples(highpass, ch));
  const size = Math.round(CLICK_WINDOW * sampleRate);
  const centre = Math.round(at * sampleRate) - (size >> 1);
  const energy = (start: number) =>
    meanSquare(high, Math.max(0, start), Math.min(high.length, start + size)) + CLICK_FLOOR;
  const count = Math.floor((span * sampleRate) / size);
  const before: number[] = [];
  const after: number[] = [];
  for (let n = 1; n <= count; n++) {
    if (centre - n * size >= 0) {
      before.push(energy(centre - n * size));
    }
    if (centre + (n + 1) * size <= high.length) {
      after.push(energy(centre + n * size));
    }
  }
  const references = [before, after].filter((w) => w.length > 0).map((w) => median(w));
  return powerDb(energy(centre) / Math.max(CLICK_FLOOR, ...references));
}

/**
 * How different two renders of the same channels are after `settleSeconds`: for
 * each channel, the RMS of `a − b` against the RMS of `a`, in dB, and the worst
 * channel's figure. Identical renders read −Infinity.
 */
export function maxDifferenceAfter(
  a: readonly Float32Array[],
  b: readonly Float32Array[],
  sampleRate: number,
  settleSeconds: number,
): number {
  const skip = Math.round(settleSeconds * sampleRate);
  let worst = -Infinity;
  a.forEach((x, c) => {
    const y = b[c] ?? new Float32Array(0);
    const length = Math.min(x.length, y.length);
    let diff = 0;
    let signal = 0;
    for (let i = skip; i < length; i++) {
      const v = x[i] ?? 0;
      diff += (v - (y[i] ?? 0)) ** 2;
      signal += v * v;
    }
    worst = Math.max(worst, signal > 0 ? powerDb(diff / signal) : diff > 0 ? Infinity : -Infinity);
  });
  return worst;
}
