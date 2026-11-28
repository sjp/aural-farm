import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

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
