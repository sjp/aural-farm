import { expect, test, type Page } from "@playwright/test";

/** The backdrop's pixels as the page shows them: mean colour and the range of brightness. */
async function backdropPixels(page: Page) {
  // Hides whatever sits in front of the backdrop (the play prompt, a toast) for the shot.
  const png = await page.locator("canvas.backdrop").screenshot({
    style: ".app > :not(.backdrop) { visibility: hidden !important; }",
  });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.codePointAt(0) ?? 0);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("No 2D context");
    }
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const sum = [0, 0, 0];
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
      const luma = (r + g + b) / 3;
      min = Math.min(min, luma);
      max = Math.max(max, luma);
    }
    const n = data.length / 4;
    return { mean: sum.map((s) => s / n), min, max };
  }, png.toString("base64"));
}

test("draws a soft glow that takes the mix's tint once playing", async ({ page }) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    } else if (message.type() === "warning") {
      warnings.push(message.text());
    }
  });
  await page.goto("/#layers=engine-core&panel=hidden");
  const canvas = page.locator("canvas.backdrop");
  await expect(canvas).toBeVisible();

  // Before playing: a dim neutral, darker at the edges, so not all one colour.
  await expect.poll(async () => (await backdropPixels(page)).max).toBeGreaterThan(8);
  const neutral = await backdropPixels(page);
  expect(neutral.max - neutral.min).toBeGreaterThan(4);
  expect(neutral.max).toBeLessThan(64);

  // Playing: Starship Engine Core's blue, once the two-second ease is over.
  const tap = page.getByRole("button", { name: "Tap to play" });
  if (await tap.isVisible()) {
    await tap.click();
  }
  await expect
    .poll(async () => {
      const [r = 0, , b = 0] = (await backdropPixels(page)).mean;
      return b - r;
    })
    .toBeGreaterThan(8);

  expect(errors).toEqual([]);
  expect(warnings.filter((w) => w.includes("backdrop"))).toEqual([]);
});

test("Off shows the plain background", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("aural-farm.display.backdrop", "off");
  });
  await page.goto("/#panel=hidden");
  await expect(page.locator('.backdrop[data-backdrop="off"]')).toBeAttached();
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("Night dims the panel too", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".panel-wrap")).toHaveCSS("filter", "none");
  await page.evaluate(() => {
    localStorage.setItem("aural-farm.display.backdrop", "night");
  });
  await page.reload();
  await expect(page.locator(".panel-wrap")).toHaveCSS("filter", "brightness(0.6)");
});
