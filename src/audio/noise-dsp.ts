/**
 * The shared noise kernel: white, pink and brown noise that is counter-based, so
 * sample n of white noise is `hashFloat(seed, stream, channel, n)` mapped to
 * [−1, 1), where n is the absolute sample index. The output is time-addressable by
 * construction: pink and brown filter that white noise, and settle within about
 * 50 ms of a render starting anywhere.
 *
 * All three colours come out at the same RMS level (`NOISE_RMS`), so a colour
 * change keeps its loudness, and the channels are decorrelated (the channel is
 * part of the hash).
 */
import { HASH_START, hashStep, UINT32_SCALE } from "./random";

export const NOISE_PROCESSOR = "aural-noise";

export const NOISE_COLOURS = ["white", "pink", "brown"] as const;
export type NoiseColour = (typeof NOISE_COLOURS)[number];

/** The RMS level of every colour: −12 dBFS. */
export const NOISE_RMS = 10 ** (-12 / 20);

/** The standard deviation of white noise uniform in [−1, 1). */
const UNIFORM_SD = 1 / Math.sqrt(3);

/**
 * Paul Kellet's refined pink filter, designed at 44.1 kHz: six one-pole sections
 * (pole, gain) plus a direct term and a one-sample-delayed term. The positive
 * poles are rescaled for other sample rates, with their gains, so the slope stays
 * at −3 dB per octave over the same frequencies.
 */
const PINK_SECTIONS: readonly (readonly [pole: number, gain: number])[] = [
  [0.99886, 0.0555179],
  [0.99332, 0.0750759],
  [0.969, 0.153852],
  [0.8665, 0.3104856],
  [0.55, 0.5329522],
  [-0.7616, -0.016898],
];
const PINK_DIRECT = 0.5362;
const PINK_DELAYED = 0.115926;
const PINK_RATE = 44100;

/** The brown integrator's pole at 48 kHz (a corner near 38 Hz), rescaled for other rates. */
const BROWN_POLE = 0.995;
const BROWN_RATE = 48000;

export interface NoiseOptions {
  colour: NoiseColour;
  seed: number;
  stream: number;
  /** 1 or 2. */
  channels: number;
  /** Seconds to add to the context's time to get absolute time. */
  offset: number;
}

const isColour = (value: unknown): value is NoiseColour => NOISE_COLOURS.some((c) => c === value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Reads `processorOptions` from the main thread, falling back to safe defaults. */
export function readNoiseOptions(raw: unknown): NoiseOptions {
  const get = (key: string): unknown =>
    typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
  const colour = get("colour");
  return {
    colour: isColour(colour) ? colour : "white",
    seed: Math.trunc(numberOr(get("seed"), 0)),
    stream: Math.trunc(numberOr(get("stream"), 0)),
    channels: get("channels") === 2 ? 2 : 1,
    offset: numberOr(get("offset"), 0),
  };
}

export class NoiseGenerator {
  private readonly colour: NoiseColour;
  /** Each channel's hash prefix: `hash32(seed, stream, channel)`. */
  private readonly prefixes: Uint32Array;
  /** Pink: each channel's section states (one per section) and the delayed term. */
  private readonly pinkState: Float64Array;
  private readonly pinkPoles: Float64Array;
  private readonly pinkGains: Float64Array;
  private readonly pinkDirect: number;
  private readonly pinkDelayed: number;
  /** Brown: each channel's integrator state. */
  private readonly brownState: Float64Array;
  private readonly brownPole: number;
  private readonly brownGain: number;
  private readonly whiteGain: number;

  constructor(
    colour: NoiseColour,
    seed: number,
    stream: number,
    channels: number,
    sampleRate: number,
  ) {
    this.colour = colour;
    this.prefixes = new Uint32Array(channels);
    const base = hashStep(hashStep(HASH_START, seed), stream);
    for (let c = 0; c < channels; c++) {
      this.prefixes[c] = hashStep(base, c);
    }

    this.whiteGain = NOISE_RMS / UNIFORM_SD;

    const ratio = PINK_RATE / sampleRate;
    const sections = PINK_SECTIONS.length;
    this.pinkPoles = new Float64Array(sections);
    this.pinkGains = new Float64Array(sections);
    PINK_SECTIONS.forEach(([pole, gain], i) => {
      this.pinkPoles[i] = pole > 0 ? pole ** ratio : pole;
      this.pinkGains[i] = pole > 0 ? gain * ratio : gain;
    });
    // Normalise from the filter's impulse response energy, so the RMS is exact at any rate.
    const scale = NOISE_RMS / (UNIFORM_SD * Math.sqrt(this.pinkEnergy(PINK_DIRECT, PINK_DELAYED)));
    for (let i = 0; i < sections; i++) {
      this.pinkGains[i] = (this.pinkGains[i] ?? 0) * scale;
    }
    this.pinkDirect = PINK_DIRECT * scale;
    this.pinkDelayed = PINK_DELAYED * scale;
    this.pinkState = new Float64Array(channels * (sections + 1));

    this.brownPole = BROWN_POLE ** (BROWN_RATE / sampleRate);
    this.brownGain = (NOISE_RMS / UNIFORM_SD) * Math.sqrt(1 - this.brownPole ** 2);
    this.brownState = new Float64Array(channels);
  }

  /** The energy (sum of squares) of the pink filter's impulse response. */
  private pinkEnergy(direct: number, delayed: number): number {
    const p = this.pinkPoles;
    const g = this.pinkGains;
    let sections = 0;
    let first = 0;
    let second = 0;
    for (let i = 0; i < p.length; i++) {
      const pi = p[i] ?? 0;
      const gi = g[i] ?? 0;
      first += gi;
      second += gi * pi;
      for (let j = 0; j < p.length; j++) {
        sections += (gi * (g[j] ?? 0)) / (1 - pi * (p[j] ?? 0));
      }
    }
    return sections + 2 * direct * first + 2 * delayed * second + direct ** 2 + delayed ** 2;
  }

  /** Fills `out` with channel `channel`'s samples from absolute sample `start` on. */
  render(channel: number, out: Float32Array, start: number): void {
    const prefix = this.prefixes[channel] ?? 0;
    const n = out.length;
    switch (this.colour) {
      case "white": {
        for (let i = 0; i < n; i++) {
          out[i] = (hashStep(prefix, start + i) * UINT32_SCALE * 2 - 1) * this.whiteGain;
        }
        return;
      }
      case "pink": {
        this.renderPink(channel, prefix, out, start);
        return;
      }
      case "brown": {
        const pole = this.brownPole;
        const gain = this.brownGain;
        let y = this.brownState[channel] ?? 0;
        for (let i = 0; i < n; i++) {
          const w = hashStep(prefix, start + i) * UINT32_SCALE * 2 - 1;
          y = pole * y + gain * w;
          out[i] = y;
        }
        this.brownState[channel] = y;
        return;
      }
      default:
        out.fill(0);
    }
  }

  private renderPink(channel: number, prefix: number, out: Float32Array, start: number): void {
    const sections = this.pinkPoles.length;
    const s = this.pinkState;
    const base = channel * (sections + 1);
    const p = this.pinkPoles;
    const g = this.pinkGains;
    // Unrolled into locals: this is the hot loop for most sounds.
    const p0 = p[0];
    const p1 = p[1];
    const p2 = p[2];
    const p3 = p[3];
    const p4 = p[4];
    const p5 = p[5];
    const g0 = g[0];
    const g1 = g[1];
    const g2 = g[2];
    const g3 = g[3];
    const g4 = g[4];
    const g5 = g[5];
    let b0 = s[base] ?? 0;
    let b1 = s[base + 1] ?? 0;
    let b2 = s[base + 2] ?? 0;
    let b3 = s[base + 3] ?? 0;
    let b4 = s[base + 4] ?? 0;
    let b5 = s[base + 5] ?? 0;
    let delayed = s[base + 6] ?? 0;
    const direct = this.pinkDirect;
    const late = this.pinkDelayed;
    for (let i = 0; i < out.length; i++) {
      const w = hashStep(prefix, start + i) * UINT32_SCALE * 2 - 1;
      b0 = p0 * b0 + g0 * w;
      b1 = p1 * b1 + g1 * w;
      b2 = p2 * b2 + g2 * w;
      b3 = p3 * b3 + g3 * w;
      b4 = p4 * b4 + g4 * w;
      b5 = p5 * b5 + g5 * w;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + delayed + direct * w;
      delayed = late * w;
    }
    s[base] = b0;
    s[base + 1] = b1;
    s[base + 2] = b2;
    s[base + 3] = b3;
    s[base + 4] = b4;
    s[base + 5] = b5;
    s[base + 6] = delayed;
  }
}
