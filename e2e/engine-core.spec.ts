import { expect, test } from "@playwright/test";
import type * as AnalysisModule from "../src/audio/analysis";
import type * as BiquadModule from "../src/audio/biquad";
import type * as RegistryModule from "../src/sounds/registry";
import type * as ParamsModule from "../src/sounds/params";
import type * as ReverbModule from "../src/audio/reverb";

/**
 * Starship Engine Core rendered in a real browser, through the registry's lazy
 * load, in an OfflineAudioContext: its loudness, peaks at every param extreme,
 * mono compatibility, the harmonics that carry it on small speakers, a seed
 * crossfade and time-addressability, plus the render cost.
 */

const ID = "engine-core";

interface Spec {
  startAt: number;
  seconds: number;
  params?: Record<string, number>;
  /** A seed to crossfade to, and when. */
  seedChange?: { at: number; seed: number };
  /**
   * Sends the reverb to a silent sink instead of a convolver, as the engine
   * sends it to the context's shared one: the layer's own cost, without the
   * reverb all layers share.
   */
  sharedReverb?: boolean;
}

interface Rendered {
  loudness: number;
  /** Loudness of each 1.5 s window, stepped by 0.5 s, for the crossfade check. */
  windows: number[];
  peakDb: number;
  /** The mono sum's level against the stereo level, in dB (negative is a loss). */
  monoDb: number;
  /** The level above 150 Hz against the whole, in dB. */
  above150Db: number;
  finite: boolean;
  /** The left channel's last second. */
  tail: number[];
  /** Render time ÷ audio time. */
  cost: number;
}

test("engine core", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.goto("/#layers=&panel=hidden");

  const render = (spec: Spec) =>
    page.evaluate(
      async ({ id, s }): Promise<Rendered> => {
        // The dev server serves the sources as modules; their types come from the imports above.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const load = async <T>(path: string) => (await import(/* @vite-ignore */ path)) as T;
        const { getSound } = await load<typeof RegistryModule>("/src/sounds/registry.ts");
        const { defaults } = await load<typeof ParamsModule>("/src/sounds/params.ts");
        const { kWeightedLoudness } = await load<typeof AnalysisModule>("/src/audio/analysis.ts");
        const { biquadCoefficients, filterSamples, BUTTERWORTH_Q } =
          await load<typeof BiquadModule>("/src/audio/biquad.ts");
        const entry = getSound(id);
        if (!entry) {
          throw new Error(`No sound ${id}`);
        }
        const { routeReverb } = await load<typeof ReverbModule>("/src/audio/reverb.ts");
        const sound = await entry.load();
        const rate = 48000;
        const ctx = new OfflineAudioContext(2, s.seconds * rate, rate);
        const out = new GainNode(ctx);
        out.connect(ctx.destination);
        if (s.sharedReverb === true) {
          const sink = new GainNode(ctx, { gain: 0 });
          sink.connect(ctx.destination);
          routeReverb(out, () => sink);
        }
        const params = { ...defaults(sound.params), ...s.params };
        const seed = typeof params.seed === "number" ? params.seed : 0;
        const instance = await sound.create(ctx, out, { params, seed, startAt: s.startAt });
        const change = s.seedChange;
        if (change) {
          const swapSeed = async () => {
            await ctx.suspend(change.at);
            instance.update({ ...params, seed: change.seed }, ctx.currentTime);
            // Let the new variation build before rendering on.
            setTimeout(() => void ctx.resume(), 50);
          };
          void swapSeed();
        }
        const began = performance.now();
        const buffer = await ctx.startRendering();
        const cost = (performance.now() - began) / 1000 / s.seconds;
        instance.dispose();

        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        const skip = rate;
        let peak = 0;
        let finite = true;
        let stereo = 0;
        let mono = 0;
        for (let i = skip; i < left.length; i++) {
          const l = left[i] ?? 0;
          const r = right[i] ?? 0;
          finite &&= Number.isFinite(l) && Number.isFinite(r);
          peak = Math.max(peak, Math.abs(l), Math.abs(r));
          stereo += (l * l + r * r) / 2;
          mono += ((l + r) / 2) ** 2;
        }
        const highpass = biquadCoefficients(
          { type: "highpass", frequency: 150, Q: BUTTERWORTH_Q },
          rate,
        );
        let high = 0;
        for (const channel of [left, right]) {
          const filtered = filterSamples(highpass, filterSamples(highpass, channel));
          for (let i = skip; i < filtered.length; i++) {
            high += (filtered[i] ?? 0) ** 2 / 2;
          }
        }
        const windows: number[] = [];
        const step = rate / 2;
        for (let start = rate; start + step <= left.length; start += step) {
          windows.push(
            kWeightedLoudness(
              [left.slice(start - rate, start + step), right.slice(start - rate, start + step)],
              rate,
              1,
            ),
          );
        }
        return {
          loudness: kWeightedLoudness([left, right], rate, 1),
          windows,
          peakDb: 20 * Math.log10(peak),
          monoDb: 10 * Math.log10(mono / stereo),
          above150Db: 10 * Math.log10(high / stereo),
          finite,
          tail: Array.from(left.subarray(left.length - rate)),
          cost,
        };
      },
      { id: ID, s: spec },
    );

  const whole = await render({ startAt: 0, seconds: 12 });
  expect(whole.finite).toBe(true);
  expect(Math.abs(whole.loudness + 23), `loudness ${whole.loudness.toFixed(2)}`).toBeLessThan(1.5);
  expect(whole.peakDb).toBeLessThan(-3);
  // The centred sine keeps the mono sum from cancelling as the detuned harmonics beat.
  expect(whole.monoDb, "mono loss").toBeGreaterThan(-3);
  // Harmonics above 150 Hz carry the hum on small speakers.
  expect(whole.above150Db, "level above 150 Hz").toBeGreaterThan(-20);
  // Recorded, not checked: the cost is too noisy with tests running in parallel.
  const layer = await render({ startAt: 0, seconds: 12, sharedReverb: true });
  test.info().annotations.push({
    type: "measured",
    description:
      `${whole.loudness.toFixed(1)} LUFS, peak ${whole.peakDb.toFixed(1)} dBFS, ` +
      `mono ${whole.monoDb.toFixed(1)} dB, above 150 Hz ${whole.above150Db.toFixed(1)} dB, ` +
      `cost ${(layer.cost * 100).toFixed(2)} % (${(whole.cost * 100).toFixed(2)} % with ` +
      `a reverb of its own)`,
  });

  // Rendered from absolute time 6 s, the sound matches the end of a render from 0.
  const late = await render({ startAt: 6, seconds: 6 });
  let diff = 0;
  let signal = 0;
  late.tail.forEach((v, i) => {
    diff += (v - (whole.tail[i] ?? 0)) ** 2;
    signal += v * v;
  });
  expect(10 * Math.log10(diff / signal), "time-addressable").toBeLessThan(-30);

  const extremes: Record<string, number>[] = [
    { power: 100, pulseDepth: 100 },
    { power: 100, pulseDepth: 100, pulseRate: 1.6, room: 100, hiss: 100 },
    { power: 0 },
    { pitch: 32 },
    { pitch: 72, power: 100, pulseDepth: 100 },
    { pulseRate: 0.3 },
    { pulseDepth: 0 },
    { room: 0 },
    { room: 100 },
    { hiss: 0 },
    { hiss: 100 },
  ];
  for (const params of extremes) {
    const extreme = await render({ startAt: 0, seconds: 6, params });
    const label = JSON.stringify(params);
    expect(extreme.finite).toBe(true);
    expect(extreme.peakDb, label).toBeLessThan(-3);
    expect(extreme.loudness, label).toBeGreaterThan(-30);
    expect(extreme.loudness, label).toBeLessThan(-17);
    expect(extreme.monoDb, label).toBeGreaterThan(-3);
    expect(extreme.above150Db, label).toBeGreaterThan(-24);
  }

  // A seed change crossfades the noise and motion without a dip or a bump in level.
  const swap = await render({ startAt: 0, seconds: 8, seedChange: { at: 3, seed: 2 } });
  const steady = swap.windows.reduce((a, b) => a + b, 0) / swap.windows.length;
  for (const level of swap.windows) {
    expect(Math.abs(level - steady), "level through the seed crossfade").toBeLessThan(1.5);
  }

  expect(errors).toEqual([]);
});
