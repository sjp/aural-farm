import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    /** Every AudioContext the page has made, recorded by the init script below. */
    madeContexts?: AudioContext[];
  }
}

/** Collects page errors and console errors, to check none happened. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}

test("plays, pauses with the button and Space, and follows layer changes in the hash", async ({
  page,
}) => {
  const errors = collectErrors(page);
  // Keep hold of every AudioContext the page makes, to read its state.
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    const made: AudioContext[] = [];
    window.madeContexts = made;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        made.push(this);
      }
    };
  });
  const contextStates = () =>
    page.evaluate(() => (window.madeContexts ?? []).map((ctx) => ctx.state));
  await page.goto("/#layers=test-tone");

  // Autoplay, or a click where the browser asks for one (headless Chromium does).
  const pause = page.getByRole("button", { name: "Pause" });
  const playing = page.locator('button[aria-label="Pause"]:not([aria-busy="true"])');
  const tap = page.getByRole("button", { name: "Tap to play" });
  await expect(playing.or(tap)).toBeVisible();
  if (await tap.isVisible()) {
    expect(await contextStates()).toEqual(["suspended"]);
    await tap.click();
  }
  await expect(playing).toBeVisible();
  await expect.poll(contextStates).toEqual(["running"]);

  // Pausing fades out, then suspends the context.
  await pause.click();
  const play = page.getByRole("button", { name: "Play", exact: true });
  await expect(play).toBeVisible();
  await expect.poll(contextStates).toEqual(["suspended"]);

  // Space toggles from anywhere but a button.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await expect(pause).toBeVisible();
  await expect.poll(contextStates).toEqual(["running"]);
  await expect(pause).not.toHaveAttribute("aria-busy", "true");

  // Remove the layer and add it back through the hash.
  await page.evaluate(() => {
    window.location.hash = "layers=";
  });
  await expect(page.getByText("The mix is empty.")).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "layers=test-tone";
  });
  await expect(page.getByRole("button", { name: "Test Tone" })).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.getByRole("alert")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("starts on the first click anywhere when autoplay is blocked", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/#layers=test-tone&panel=hidden");
  const prompt = page.getByRole("button", { name: "Tap to play" });
  const playing = page.locator('button[aria-label="Pause"]:not([aria-busy="true"])');
  await expect(playing.or(prompt)).toBeAttached();
  test.skip(!(await prompt.isVisible()), "this browser allowed autoplay");
  // A click on the backdrop, away from the prompt, starts playback too.
  await page.mouse.click(10, 300);
  await expect(prompt).toHaveCount(0);
  await expect(playing).toBeAttached();
  expect(errors).toEqual([]);
});
