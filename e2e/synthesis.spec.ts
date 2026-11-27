import { expect, test } from "@playwright/test";
import type * as NoiseModule from "../src/audio/noise";
import type * as DriftModule from "../src/audio/drift";
import type * as ReverbModule from "../src/audio/reverb";
import type * as ScopeModule from "../src/audio/scope";

/**
 * The shared synthesis toolkit in a real browser: the shared worklet module loads
 * and its processors run in an OfflineAudioContext. The page imports the audio
 * modules straight from the dev server, so this checks the dev build of the
 * worklet module, whose imports must evaluate without a DOM.
 */

interface Rendered {
  /** RMS of each channel, in dBFS. */
  rmsDb: number[];
  peak: number;
  finite: boolean;
  /** The left channel's samples from 1 s on, to compare renders. */
  tail: number[];
}

test("renders noise and drift from the shared worklet, time-addressably", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.goto("/#panel=hidden");

  const render = (what: "white" | "pink" | "brown" | "drift" | "reverb", startAt: number) =>
    page.evaluate(
      async ({ kind, from }): Promise<Rendered> => {
        // The dev server serves the sources as modules; their types come from the imports above.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const load = async <T>(path: string) => (await import(/* @vite-ignore */ path)) as T;
        const { createNoise } = await load<typeof NoiseModule>("/src/audio/noise.ts");
        const { createDrift } = await load<typeof DriftModule>("/src/audio/drift.ts");
        const { createSend } = await load<typeof ReverbModule>("/src/audio/reverb.ts");
        const { withAudioScope } = await load<typeof ScopeModule>("/src/audio/scope.ts");
        const sampleRate = 48000;
        const seconds = from === 0 ? 2 : 1;
        const ctx = new OfflineAudioContext(2, seconds * sampleRate, sampleRate);
        await withAudioScope(async (scope) => {
          if (kind === "drift") {
            const drift = await createDrift(ctx, scope, {
              seed: 1,
              stream: 1,
              rate: 4,
              octaves: 3,
              startAt: from,
            });
            drift.connect(ctx.destination);
            return;
          }
          const noise = await createNoise(ctx, scope, {
            colour: kind === "reverb" ? "pink" : kind,
            seed: 1,
            stream: 1,
            channels: 2,
            startAt: from,
          });
          if (kind === "reverb") {
            const out = scope.add(new GainNode(ctx));
            out.connect(ctx.destination);
            createSend(ctx, scope, noise, out, "hall", 0);
          } else {
            noise.connect(ctx.destination);
          }
        });
        const buffer = await ctx.startRendering();
        let peak = 0;
        let finite = true;
        const rmsDb = [0, 1].map((c) => {
          const data = buffer.getChannelData(c);
          let sum = 0;
          for (const v of data) {
            finite &&= Number.isFinite(v);
            peak = Math.max(peak, Math.abs(v));
            sum += v * v;
          }
          return 10 * Math.log10(sum / data.length);
        });
        const left = buffer.getChannelData(0);
        return { rmsDb, peak, finite, tail: Array.from(left.subarray(left.length - sampleRate)) };
      },
      { kind: what, from: startAt },
    );

  for (const colour of ["white", "pink", "brown"] as const) {
    const whole = await render(colour, 0);
    expect(whole.finite).toBe(true);
    for (const db of whole.rmsDb) {
      expect(Math.abs(db + 12), `${colour} level`).toBeLessThan(1);
    }
    // Rendered from absolute time 1 s, the noise is the same as the second half of a
    // render from 0 (white exactly; pink and brown once their filters settle).
    const late = await render(colour, 1);
    let worst = 0;
    late.tail.forEach((v, i) => {
      if (i > 12000) {
        worst = Math.max(worst, Math.abs(v - (whole.tail[i] ?? 0)));
      }
    });
    expect(worst, `${colour} time-addressable`).toBeLessThan(1e-3);
  }

  const drift = await render("drift", 0);
  expect(drift.finite).toBe(true);
  expect(drift.peak).toBeLessThanOrEqual(1);
  expect(drift.peak).toBeGreaterThan(0.2);
  expect((await render("drift", 1)).tail).toEqual(drift.tail);

  const reverb = await render("reverb", 0);
  expect(reverb.finite).toBe(true);
  // The impulse has unit energy, so the reverb of noise comes out near its level.
  for (const db of reverb.rmsDb) {
    expect(Math.abs(db + 12)).toBeLessThan(4);
  }

  expect(errors).toEqual([]);
});
