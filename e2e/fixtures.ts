import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/**
 * Playwright's `test`, with a page whose panel never fades for an idle pointer.
 * The panel fades after 3 s without input, hiding its controls (and taking them
 * out of the accessibility tree), and on a busy CI runner a single step can take
 * that long. The page sees pointer activity every half second instead.
 */
export const test = base.extend({
  page: async ({ page }, provide) => {
    await page.addInitScript(() => {
      setInterval(() => {
        window.dispatchEvent(new PointerEvent("pointermove"));
      }, 500);
    });
    await provide(page);
  },
});

/**
 * Starts playback. Headless Chromium autoplays, but on a busy machine the start
 * can take long enough that the app offers Tap to play, then starts by itself
 * after all. So where it offers one, this clicks the backdrop, which starts
 * playback while it's blocked and does nothing once it plays: a click on Tap to
 * play could land after it had turned to Pause.
 */
export async function startPlaying(page: Page): Promise<void> {
  const playing = page.locator('button[aria-label="Pause"]:not([aria-busy="true"])');
  const tap = page.getByRole("button", { name: "Tap to play" });
  await expect(playing.or(tap)).toBeVisible();
  if (await tap.isVisible()) {
    await page.mouse.click(5, 5);
  }
  await expect(playing).toBeVisible();
}
