import { expect, test } from "@playwright/test";
import { sounds } from "../src/sounds/registry";
import { COST_BUDGET, COST_SLACK } from "./sound-thresholds";

/**
 * Each sound's render cost: render time ÷ audio time for one layer at its
 * defaults, the best of five 60 s renders in an OfflineAudioContext, against
 * the budget for the `cost` its metadata declares. Its reverb sends go to a
 * silent sink, as the engine sends them to the context's shared convolvers: the
 * layer's own cost, without the reverb every layer shares.
 *
 * Timing needs a quiet machine, so these run in the "cost" project: one at a
 * time, after every other browser test has finished.
 */

const SECONDS = 60;
const RUNS = 5;

for (const sound of sounds) {
  test(sound.id, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/e2e/harness.html");
    await page.waitForFunction(() => "harness" in window);
    const cost = await page.evaluate(async ([spec, runs]) => window.harness.bestCost(spec, runs), [
      { id: sound.id, seconds: SECONDS, reverb: "silent" },
      RUNS,
    ] as const);
    await test.info().attach("sound-measurements", {
      body: JSON.stringify({ id: sound.id, costPercent: Number((cost * 100).toFixed(3)) }),
      contentType: "application/json",
    });
    const budget = COST_BUDGET[sound.cost] * COST_SLACK;
    expect(
      cost,
      `${(cost * 100).toFixed(2)} % against the "${sound.cost}" budget of ${(budget * 100).toFixed(2)} %`,
    ).toBeLessThan(budget);
  });
}
