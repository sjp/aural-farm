import { expect, test, type Page } from "@playwright/test";
import type { Layer } from "../src/mixes/mix";
import { defaults } from "../src/sounds/params";
import { sounds, type SoundEntry } from "../src/sounds/registry";
import type { ParamValues } from "../src/sounds/types";
import { paramSets } from "../src/test/param-sets";
import type { Measurements, SoundSpec } from "./harness";
import { extraSets, silentSet, threshold, THRESHOLDS } from "./sound-thresholds";

/**
 * Every registered sound rendered in a real browser, through the registry's
 * lazy load, in an OfflineAudioContext, and measured: level, peaks, spectrum,
 * stereo, clicks, determinism and time-addressability. Each sound is one test,
 * with a step per check; the pass marks are in `sound-thresholds.ts`. A final
 * test plays every sound at once through the master chain. Render cost is
 * measured on its own, in `sound-cost.spec.ts`.
 *
 * Each test attaches its measurements, which the sound reporter collects into
 * `test-results/sounds.json` and a table.
 */

const MAX_MIX_LAYERS = 8;

/** Opens the render harness and collects any page error. */
async function openHarness(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.goto("/e2e/harness.html");
  await page.waitForFunction(() => "harness" in window);
  return errors;
}

const measure = (page: Page, spec: SoundSpec) =>
  page.evaluate(async (s) => window.harness.measureSound(s), spec);

const fixed = (value: number, digits = 1) => Number(value.toFixed(digits));

/**
 * Each number param (but the seed) at the end of its range farther from its
 * default, then each select at an option other than its default, and each
 * toggle flipped.
 */
function farChanges(sound: SoundEntry): { numbers: ParamValues; others: ParamValues } {
  const numbers: ParamValues = {};
  const others: ParamValues = {};
  for (const [key, def] of Object.entries(sound.params)) {
    switch (def.kind) {
      case "number":
        if (key !== "seed") {
          numbers[key] = def.default - def.min > def.max - def.default ? def.min : def.max;
        }
        break;
      case "select": {
        const option = def.options.findLast((o) => o.value !== def.default);
        if (option) {
          others[key] = option.value;
        }
        break;
      }
      case "boolean":
        others[key] = !def.default;
        break;
      default:
        def satisfies never;
    }
  }
  return { numbers, others };
}

/** A seed other than the default, inside the seed param's range. */
function otherSeed(sound: SoundEntry): number {
  const def = Object.entries(sound.params).find(([key]) => key === "seed")?.[1];
  if (def?.kind !== "number") {
    return 2;
  }
  return def.default + 1 <= def.max ? def.default + 1 : def.default - 1;
}

for (const sound of sounds) {
  test(sound.id, async ({ page }) => {
    test.setTimeout(240_000);
    const { id } = sound;
    const errors = await openHarness(page);
    const results: Record<string, unknown> = { id, cost: sound.cost };
    const limit = (name: Parameters<typeof threshold>[1]) => threshold(id, name);

    try {
      await test.step("not silent, no NaN, DC, sub-bass, mono and small speakers", async () => {
        const m = await measure(page, { id, seconds: 10 });
        Object.assign(results, {
          loudness: fixed(m.loudness),
          peakDb: fixed(m.peakDb),
          dc: fixed(m.dc, 5),
          subBassDb: fixed(m.subBassDb),
          speakersDb: fixed(m.speakersDb),
          monoLossDb: fixed(m.monoLossDb, 2),
          correlation: fixed(m.correlation, 2),
          slope: fixed(m.slope, 2),
        });
        expect.soft(m.errors, "errors").toEqual([]);
        expect.soft(m.finite, "finite").toBe(true);
        expect.soft(m.loudness, "not silent").toBeGreaterThan(limit("audibleLufs"));
        expect.soft(m.dc, "DC offset").toBeLessThan(limit("dcOffset"));
        expect.soft(m.subBassDb, "energy below 25 Hz").toBeLessThan(limit("subBassDb"));
        expect.soft(m.monoLossDb, "mono loss").toBeLessThan(limit("monoLossDb"));
        expect.soft(m.speakersDb, "energy at 150 Hz–4 kHz").toBeGreaterThan(limit("speakersDb"));
      });

      await test.step("level at seeds 1, 2 and 3", async () => {
        const levels: number[] = [];
        for (const seed of [1, 2, 3]) {
          const m = await measure(page, { id, seconds: 30, seed });
          levels.push(fixed(m.loudness));
          expect
            .soft(Math.abs(m.loudness - limit("targetLufs")), `loudness at seed ${String(seed)}`)
            .toBeLessThan(limit("levelToleranceDb"));
        }
        results.levels = levels;
      });

      await test.step("peaks and level at every param set", async () => {
        let worstPeak = -Infinity;
        const range = [Infinity, -Infinity];
        const base = defaults(sound.params);
        const sets = [
          ...paramSets(sound.params),
          ...extraSets(id).map((set) => ({ name: set.name, params: { ...base, ...set.params } })),
        ];
        for (const set of sets) {
          const m = await measure(page, { id, seconds: 10, params: set.params });
          worstPeak = Math.max(worstPeak, m.peakDb);
          range[0] = Math.min(range[0] ?? Infinity, m.loudness);
          range[1] = Math.max(range[1] ?? -Infinity, m.loudness);
          const label = `${set.name}: ${m.loudness.toFixed(1)} LUFS, peak ${m.peakDb.toFixed(1)} dBFS`;
          expect.soft(m.errors, label).toEqual([]);
          expect.soft(m.finite, label).toBe(true);
          expect.soft(m.peakDb, label).toBeLessThanOrEqual(limit("peakDbfs"));
          expect.soft(m.loudness, label).toBeLessThan(limit("paramSetMaxLufs"));
          if (!silentSet(id, set.name)) {
            expect.soft(m.loudness, label).toBeGreaterThan(limit("paramSetMinLufs"));
            expect.soft(m.monoLossDb, `${label}: mono loss`).toBeLessThan(limit("monoLossDb"));
            expect
              .soft(m.speakersDb, `${label}: energy at 150 Hz–4 kHz`)
              .toBeGreaterThan(limit("speakersDb"));
          }
        }
        results.worstPeakDb = fixed(worstPeak);
        results.paramSetLufs = range.map((v) => fixed(v));
      });

      await test.step("44.1 kHz", async () => {
        const at48 = await page.evaluate(
          async (s) => {
            const r = await window.harness.renderSound(s);
            return r.channels.map((c) => c.reduce((sum, v) => sum + v * v, 0) / c.length);
          },
          { id, seconds: 10 },
        );
        const at44 = await page.evaluate(
          async (s) => {
            const r = await window.harness.renderSound(s);
            return {
              power: r.channels.map((c) => c.reduce((sum, v) => sum + v * v, 0) / c.length),
              peak: Math.max(
                ...r.channels.map((c) => c.reduce((p, v) => Math.max(p, Math.abs(v)), 0)),
              ),
              finite: r.channels.every((c) => c.every((v) => Number.isFinite(v))),
            };
          },
          { id, seconds: 10, sampleRate: 44100 },
        );
        const db = (power: number[]) => 10 * Math.log10(power.reduce((a, b) => a + b, 0));
        const difference = db(at44.power) - db(at48);
        results.sampleRateDb = fixed(difference, 2);
        expect.soft(at44.finite, "finite at 44.1 kHz").toBe(true);
        expect
          .soft(20 * Math.log10(at44.peak), "peak at 44.1 kHz")
          .toBeLessThanOrEqual(limit("peakDbfs"));
        expect
          .soft(Math.abs(difference), "level at 44.1 kHz against 48 kHz")
          .toBeLessThan(limit("sampleRateDb"));
      });

      await test.step("determinism", async () => {
        const spec = { id, seconds: 5 };
        const difference = await page.evaluate(
          async (s) => window.harness.difference(s, s, 0, 0),
          spec,
        );
        results.determinismDb = fixed(difference);
        expect
          .soft(difference, "two renders with the same seed")
          .toBeLessThanOrEqual(limit("determinismDb"));
      });

      await test.step("time-addressable", async () => {
        const difference = await page.evaluate(
          async ([whole, late]) => window.harness.difference(whole, late, 10, 2),
          [
            { id, seconds: 20 },
            { id, seconds: 10, startAt: 10 },
          ] satisfies [SoundSpec, SoundSpec],
        );
        results.timeAddressableDb = fixed(difference);
        expect
          .soft(difference, "a render from 10 s against the same stretch rendered from 0")
          .toBeLessThan(limit("timeAddressableDb"));
      });

      await test.step("param changes are click-free", async () => {
        const { numbers, others } = farChanges(sound);
        const updates = [{ at: 4, params: numbers }];
        if (Object.keys(others).length > 0) {
          updates.push({ at: 6, params: others });
        }
        const spec: SoundSpec = { id, seconds: 8, updates };
        const { scores, errors: soundErrors } = await page.evaluate(
          async ([s, at]) => window.harness.clicks(s, at),
          [spec, updates.map((u) => u.at)] as const,
        );
        results.paramClickDb = fixed(Math.max(...scores));
        expect.soft(soundErrors, "errors").toEqual([]);
        scores.forEach((score, i) => {
          expect
            .soft(score, `click score at ${JSON.stringify(updates[i]?.params)}`)
            .toBeLessThan(limit("clickDb"));
        });
      });

      await test.step("seed crossfade", async () => {
        const at = 3;
        const spec: SoundSpec = {
          id,
          seconds: 8,
          updates: [{ at, params: { seed: otherSeed(sound) } }],
        };
        const { scores, windows } = await page.evaluate(
          async ([s, t]) => window.harness.clicks(s, [t]),
          [spec, at] as const,
        );
        const steady = windows.reduce((a, b) => a + b, 0) / windows.length;
        const swing = Math.max(...windows.map((w) => Math.abs(w - steady)));
        results.seedClickDb = fixed(scores[0] ?? Number.NaN);
        results.seedSwingDb = fixed(swing, 2);
        expect.soft(scores[0], "click score at the seed change").toBeLessThan(limit("clickDb"));
        expect.soft(swing, "level through the seed crossfade").toBeLessThan(limit("seedSwingDb"));
      });
    } finally {
      await test.info().attach("sound-measurements", {
        body: JSON.stringify(results),
        contentType: "application/json",
      });
    }
    expect(errors, "page errors").toEqual([]);
  });
}

test("a mix of every sound stays clear of the limiter", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openHarness(page);
  const layers: Layer[] = sounds.slice(0, MAX_MIX_LAYERS).map((s) => ({
    id: s.id,
    volume: 70,
    muted: false,
    params: defaults(s.params),
  }));
  const settle = 3;
  const m = await page.evaluate(
    async (mix) => window.harness.measureMix({ mix, seconds: 30, reductionEvery: 0.1 }),
    { master: 100, layers },
  );
  // The limiter's detector starts from a state that reads as reduction and
  // recovers over about 2 s, even for a quiet input: skip that.
  const readings = m.reduction.slice(settle * 10);
  const clear = readings.filter((r) => r > -THRESHOLDS.mixReductionDb).length / readings.length;
  await test.info().attach("sound-measurements", {
    body: JSON.stringify({
      id: "mix",
      loudness: fixed(m.loudness),
      peakDb: fixed(m.peakDb),
      limiterClear: fixed(clear, 3),
      worstReductionDb: fixed(Math.min(...readings), 2),
    } satisfies Partial<Measurements> & Record<string, unknown>),
    contentType: "application/json",
  });
  expect(m.errors).toEqual([]);
  expect(m.finite).toBe(true);
  expect(readings.length).toBeGreaterThan(200);
  expect(clear, "share of readings under 1 dB of gain reduction").toBeGreaterThanOrEqual(
    THRESHOLDS.mixReductionShare,
  );
  expect(errors, "page errors").toEqual([]);
});
