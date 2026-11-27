/**
 * The render harness: a page the Vite dev server serves (it is never built into
 * `dist`) that renders sounds and mixes in an `OfflineAudioContext` and measures
 * them. The browser sound checks and `npm run render` drive it through
 * `window.harness`. Measuring happens in the page, so only numbers cross back
 * to the test, not seconds of samples.
 */
import * as analysis from "../src/audio/analysis";
import { routeReverb, getReverb, type ReverbKind } from "../src/audio/reverb";
import { seedOf, soundParams } from "../src/audio/mix-graph";
import { buildMix } from "../src/audio/render";
import { parseHash, type Mix } from "../src/mixes/mix";
import { defaults } from "../src/sounds/params";
import { getSound, sounds } from "../src/sounds/registry";
import type { ParamValues } from "../src/sounds/types";

/** A param change during a render: `params` are merged onto the current ones at `at` seconds. */
interface Update {
  at: number;
  params: ParamValues;
}

export interface SoundSpec {
  id: string;
  seconds: number;
  /** The absolute time the render's first sample stands for; default 0. */
  startAt?: number;
  /** Default 48 kHz, which the loudness measures need. */
  sampleRate?: number;
  /** Changes from the sound's defaults. */
  params?: ParamValues;
  /** Overrides `params.seed`. */
  seed?: number;
  updates?: readonly Update[];
  /**
   * Where reverb sends go: "shared" (the default) into the context's shared
   * convolvers and on to the output, as the engine does; "silent" into a silent
   * sink, to measure the layer's own cost without the reverb all layers share.
   */
  reverb?: "shared" | "silent";
  /** Plays through the real master chain (high-pass, limiter and trim). */
  master?: boolean;
}

interface MixSpec {
  /** A mix, or a URL hash holding one. */
  mix: Mix | string;
  seconds: number;
  startAt?: number;
  /** Reads the limiter's gain reduction this often, in seconds (0: never). */
  reductionEvery?: number;
}

interface Rendered {
  channels: Float32Array[];
  sampleRate: number;
  /** Render time ÷ audio time. */
  cost: number;
  /** The limiter's gain reduction in dB (≤ 0), at each reading, for a mix. */
  reduction: number[];
  /** Failures a sound reported while rendering, such as a crashed worklet. */
  errors: string[];
}

/** Everything the checks measure in one render, in dB unless noted. */
export interface Measurements {
  finite: boolean;
  /** Approximate integrated loudness, in LUFS (ungated, after a 1 s settle). */
  loudness: number;
  peakDb: number;
  /** The larger channel's DC offset, as a sample value. */
  dc: number;
  /** Energy below 25 Hz against the total (negative: below it). */
  subBassDb: number;
  /** Energy at 150 Hz–4 kHz against the total: what small speakers can play. */
  speakersDb: number;
  /** How much quieter the mono sum is than the stereo signal. */
  monoLossDb: number;
  correlation: number;
  /** The left channel's tilt from 100 Hz to 8 kHz, in dB per octave. */
  slope: number;
}

const DEFAULT_RATE = 48000;
/** The start of each render that measures skip while filters and reverbs settle, in seconds. */
const SETTLE = 1;
/** How long a render stays suspended at an update, so a crossfade's new graph can build. */
const BUILD_WAIT_MS = 50;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function render(
  ctx: OfflineAudioContext,
  seconds: number,
  updates: readonly { at: number; apply: () => void }[],
): Promise<{ buffer: AudioBuffer; cost: number }> {
  for (const { at, apply } of updates) {
    const pause = async () => {
      await ctx.suspend(at);
      try {
        apply();
      } finally {
        setTimeout(() => void ctx.resume(), BUILD_WAIT_MS);
      }
    };
    pause().catch((error: unknown) => {
      console.error(error);
    });
  }
  const began = performance.now();
  const buffer = await ctx.startRendering();
  // The waits at updates aren't rendering.
  const elapsed = performance.now() - began - updates.length * BUILD_WAIT_MS;
  return { buffer, cost: elapsed / 1000 / seconds };
}

const channelsOf = (buffer: AudioBuffer) =>
  Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));

/** Renders one sound as a layer at volume 1. */
async function renderSound(spec: SoundSpec): Promise<Rendered> {
  const entry = getSound(spec.id);
  if (!entry) {
    throw new Error(`No sound "${spec.id}"`);
  }
  const sampleRate = spec.sampleRate ?? DEFAULT_RATE;
  const ctx = new OfflineAudioContext(2, Math.round(spec.seconds * sampleRate), sampleRate);
  const errors: string[] = [];
  const onError = (error: unknown) => {
    errors.push(describe(error));
  };
  // Coerced against the schema, as the engine passes them.
  let params = soundParams(entry, {
    ...defaults(entry.params),
    ...spec.params,
    ...(spec.seed === undefined ? {} : { seed: spec.seed }),
  });
  const seed = seedOf(params);

  if (spec.master === true) {
    if ((spec.updates?.length ?? 0) > 0) {
      throw new Error("Updates aren't supported through the master chain");
    }
    const mix: Mix = { master: 100, layers: [{ id: spec.id, volume: 100, muted: false, params }] };
    const graph = await buildMix(ctx, mix, { startAt: spec.startAt ?? 0, onError });
    const { buffer, cost } = await render(ctx, spec.seconds, []);
    graph.dispose();
    return { channels: channelsOf(buffer), sampleRate, cost, reduction: [], errors };
  }

  const out = new GainNode(ctx);
  out.connect(ctx.destination);
  const sink = new GainNode(ctx, { gain: 0 });
  sink.connect(ctx.destination);
  const returns = new Set<ReverbKind>();
  routeReverb(out, (kind) => {
    if (spec.reverb === "silent") {
      return sink;
    }
    const convolver = getReverb(ctx, kind);
    if (!returns.has(kind)) {
      convolver.connect(ctx.destination);
      returns.add(kind);
    }
    return convolver;
  });
  const sound = await entry.load();
  const instance = await sound.create(ctx, out, {
    params,
    seed,
    startAt: spec.startAt ?? 0,
    onError,
  });
  const updates = (spec.updates ?? []).map((u) => ({
    at: u.at,
    apply: () => {
      params = soundParams(entry, { ...params, ...u.params });
      instance.update(params, ctx.currentTime);
    },
  }));
  const { buffer, cost } = await render(ctx, spec.seconds, updates);
  instance.dispose();
  return { channels: channelsOf(buffer), sampleRate, cost, reduction: [], errors };
}

/** Renders a whole mix through the master chain, reading the limiter as it goes. */
async function renderMix(spec: MixSpec): Promise<Rendered> {
  const mix = typeof spec.mix === "string" ? parseHash(spec.mix).mix : spec.mix;
  const ctx = new OfflineAudioContext(2, Math.round(spec.seconds * DEFAULT_RATE), DEFAULT_RATE);
  const errors: string[] = [];
  const graph = await buildMix(ctx, mix, {
    startAt: spec.startAt ?? 0,
    onError: (error) => {
      errors.push(describe(error));
    },
  });
  const reduction: number[] = [];
  const every = spec.reductionEvery ?? 0;
  if (every > 0) {
    // Chained, so each suspend is scheduled while the context is suspended at the one before.
    const read = async (at: number) => {
      await ctx.suspend(at);
      reduction.push(graph.master.limiter.reduction);
      if (at + every < spec.seconds) {
        read(at + every).catch((error: unknown) => {
          console.error(error);
        });
      }
      await ctx.resume();
    };
    read(every).catch((error: unknown) => {
      console.error(error);
    });
  }
  const { buffer, cost } = await render(ctx, spec.seconds, []);
  graph.dispose();
  return { channels: channelsOf(buffer), sampleRate: DEFAULT_RATE, cost, reduction, errors };
}

function measure({ channels, sampleRate }: Rendered): Measurements {
  const skip = Math.round(SETTLE * sampleRate);
  const settled = channels.map((c) => c.subarray(skip));
  const [left = new Float32Array(0), right = left] = settled;
  const band = (lo: number, hi: number) =>
    10 *
    Math.log10(
      settled.reduce(
        (sum, c) => sum + 10 ** (analysis.bandEnergyDb(c, sampleRate, lo, hi) / 10),
        0,
      ),
    );
  const total = band(0, sampleRate);
  return {
    finite: channels.every((c) => c.every((v) => Number.isFinite(v))),
    loudness: analysis.kWeightedLoudness(channels, sampleRate, SETTLE),
    peakDb: Math.max(...settled.map((c) => analysis.peakDb(c))),
    dc: Math.max(...settled.map((c) => Math.abs(analysis.dcOffset(c)))),
    subBassDb: band(0, 25) - total,
    speakersDb: band(150, 4000) - total,
    monoLossDb: analysis.monoLossDb(left, right),
    correlation: analysis.interChannelCorrelation(left, right),
    slope: analysis.spectralSlope(left, sampleRate, 100, 8000),
  };
}

/** Renders `spec` and measures it. */
async function measureSound(spec: SoundSpec): Promise<Measurements & { errors: string[] }> {
  const rendered = await renderSound(spec);
  return { ...measure(rendered), errors: rendered.errors };
}

/**
 * How far `b` strays from `a`, in dB against `a`'s level (see
 * `maxDifferenceAfter`): `b` is compared with `a` from `offset` seconds into
 * `a`, after `settle` seconds.
 */
async function difference(a: SoundSpec, b: SoundSpec, offset: number, settle: number) {
  const first = await renderSound(a);
  const second = await renderSound(b);
  const skip = Math.round(offset * first.sampleRate);
  return analysis.maxDifferenceAfter(
    first.channels.map((c) => c.subarray(skip)),
    second.channels,
    first.sampleRate,
    settle,
  );
}

/**
 * Renders `spec` and scores clicks at each of `at` (the worse channel's score),
 * and follows its loudness in 1.5 s windows stepped by 0.5 s.
 */
async function clicks(spec: SoundSpec, at: readonly number[]) {
  const { channels, sampleRate, errors } = await renderSound(spec);
  return {
    scores: at.map((t) => Math.max(...channels.map((c) => analysis.clickScore(c, sampleRate, t)))),
    windows: analysis.windowedLoudness(channels, sampleRate, 1.5, 0.5, SETTLE),
    errors,
  };
}

/** Renders a mix and measures it, with the limiter's readings. */
async function measureMix(spec: MixSpec) {
  const rendered = await renderMix(spec);
  return { ...measure(rendered), reduction: rendered.reduction, errors: rendered.errors };
}

/** Render cost (render time ÷ audio time), the best of `runs` renders of `spec`. */
async function bestCost(spec: SoundSpec, runs: number): Promise<number> {
  let best = Infinity;
  for (let run = 0; run < runs; run++) {
    best = Math.min(best, (await renderSound(spec)).cost);
  }
  return best;
}

/**
 * A render as 16-bit PCM, interleaved and base64-encoded, for writing a WAV
 * file. Samples are clipped to full scale and rounded with TPDF dither.
 */
async function pcm16(spec: { sound: SoundSpec } | { mix: MixSpec }): Promise<string> {
  const rendered = "sound" in spec ? await renderSound(spec.sound) : await renderMix(spec.mix);
  if (rendered.errors.length > 0) {
    throw new Error(rendered.errors.join("; "));
  }
  const { channels } = rendered;
  const frames = channels[0]?.length ?? 0;
  const samples = new Int16Array(frames * channels.length);
  // Seeded dither, so a render's file is the same every time.
  let state = 0x2545f491;
  const uniform = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = 0; i < frames; i++) {
    channels.forEach((c, ch) => {
      const dither = uniform() - uniform();
      const v = Math.max(-1, Math.min(1, c[i] ?? 0)) * 32767 + dither;
      samples[i * channels.length + ch] = Math.max(-32768, Math.min(32767, Math.round(v)));
    });
  }
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Every registered sound's id and default seed, for the render script. */
const listSounds = () => sounds.map((s) => ({ id: s.id, seed: seedOf(defaults(s.params)) }));

/** A mix hash's layers, as the app reads it, for naming a render. */
const mixLayers = (hash: string) => parseHash(hash).mix.layers.map((l) => l.id);

const harness = {
  listSounds,
  mixLayers,
  renderSound,
  renderMix,
  measureSound,
  measureMix,
  difference,
  clicks,
  bestCost,
  pcm16,
};

type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}

window.harness = harness;
