import { expect, test } from "@playwright/test";
import type * as AnalysisModule from "../src/audio/analysis";
import type * as RegistryModule from "../src/sounds/registry";
import type * as ParamsModule from "../src/sounds/params";

/**
 * The noise colours rendered in a real browser, through the registry's lazy
 * load, in an OfflineAudioContext: their loudness, peaks, stereo, a seed
 * crossfade and time-addressability, plus the render cost.
 */

interface Spec {
  id: string;
  startAt: number;
  seconds: number;
  params?: Record<string, number>;
  /** A seed to crossfade to, and when. */
  seedChange?: { at: number; seed: number };
}

interface Rendered {
  loudness: number;
  /** Loudness of each 0.5 s window, for the crossfade check. */
  windows: number[];
  peakDb: number;
  /** The mono sum's level against the stereo level, in dB (negative is a loss). */
  monoDb: number;
  finite: boolean;
  /** The left channel's last second. */
  tail: number[];
  /** Render time ÷ audio time. */
  cost: number;
}

const COLOURS = ["white-noise", "pink-noise", "brown-noise", "grey-noise"] as const;

test.describe("noise colours", () => {
  for (const id of COLOURS) {
    test(id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
      });
      await page.goto("/#layers=&panel=hidden");

      const render = (spec: Spec) =>
        page.evaluate(async (s): Promise<Rendered> => {
          // The dev server serves the sources as modules; their types come from the imports above.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const load = async <T>(path: string) => (await import(/* @vite-ignore */ path)) as T;
          const { getSound } = await load<typeof RegistryModule>("/src/sounds/registry.ts");
          const { defaults } = await load<typeof ParamsModule>("/src/sounds/params.ts");
          const { kWeightedLoudness } = await load<typeof AnalysisModule>("/src/audio/analysis.ts");
          const entry = getSound(s.id);
          if (!entry) {
            throw new Error(`No sound ${s.id}`);
          }
          const sound = await entry.load();
          const rate = 48000;
          const ctx = new OfflineAudioContext(2, s.seconds * rate, rate);
          const out = new GainNode(ctx);
          out.connect(ctx.destination);
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
          let peak = 0;
          let finite = true;
          let stereo = 0;
          let mono = 0;
          for (let i = 0; i < left.length; i++) {
            const l = left[i] ?? 0;
            const r = right[i] ?? 0;
            finite &&= Number.isFinite(l) && Number.isFinite(r);
            peak = Math.max(peak, Math.abs(l), Math.abs(r));
            stereo += (l * l + r * r) / 2;
            mono += ((l + r) / 2) ** 2;
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
            finite,
            tail: Array.from(left.subarray(left.length - rate)),
            cost,
          };
        }, spec);

      const whole = await render({ id, startAt: 0, seconds: 12 });
      expect(whole.finite).toBe(true);
      expect(Math.abs(whole.loudness + 23), `loudness ${whole.loudness.toFixed(2)}`).toBeLessThan(
        1.5,
      );
      expect(whole.peakDb).toBeLessThan(-3);
      // Recorded, not checked: the cost is too noisy with tests running in parallel.
      test.info().annotations.push({
        type: "measured",
        description:
          `${whole.loudness.toFixed(1)} LUFS, peak ${whole.peakDb.toFixed(1)} dBFS, ` +
          `mono ${whole.monoDb.toFixed(1)} dB, cost ${(whole.cost * 100).toFixed(2)} %`,
      });

      // Rendered from absolute time 6 s, the sound matches the end of a render from 0.
      const late = await render({ id, startAt: 6, seconds: 6 });
      let diff = 0;
      let signal = 0;
      late.tail.forEach((v, i) => {
        diff += (v - (whole.tail[i] ?? 0)) ** 2;
        signal += v * v;
      });
      expect(10 * Math.log10(diff / signal), "time-addressable").toBeLessThan(-30);

      const wide = await render({ id, startAt: 0, seconds: 6, params: { width: 100 } });
      expect(wide.monoDb, "mono loss at full width").toBeGreaterThan(-4);
      expect(wide.peakDb).toBeLessThan(-3);

      for (const params of [{ tone: -100 }, { tone: 100 }, { movement: 100 }, { width: 0 }]) {
        const extreme = await render({ id, startAt: 0, seconds: 6, params });
        expect(extreme.finite).toBe(true);
        expect(extreme.peakDb, JSON.stringify(params)).toBeLessThan(-3);
        expect(extreme.loudness, JSON.stringify(params)).toBeGreaterThan(-30);
      }

      // A seed change crossfades without a dip or a bump in level.
      const swap = await render({ id, startAt: 0, seconds: 8, seedChange: { at: 3, seed: 2 } });
      const steady = swap.windows.reduce((a, b) => a + b, 0) / swap.windows.length;
      for (const level of swap.windows) {
        expect(Math.abs(level - steady), "level through the seed crossfade").toBeLessThan(2);
      }

      expect(errors).toEqual([]);
    });
  }
});
