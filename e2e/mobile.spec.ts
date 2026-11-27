import { expect, test, type Page } from "@playwright/test";

/** Drives touches through Chromium's touch emulation, which Playwright has no drag for. */
async function touchScreen(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = async (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  };
  return {
    /**
     * Drags a finger from (x0, y0) to (x1, y1) in `steps` moves a frame apart, and
     * rests before lifting it. A fast release makes Chromium start a fling, and
     * the next tap then only stops the fling, without a click.
     */
    async drag(x0: number, y0: number, x1: number, y1: number, steps = 15) {
      await send("touchStart", x0, y0);
      for (let i = 1; i <= steps; i++) {
        await send("touchMove", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(150);
      await send("touchEnd");
    },
  };
}

function watchErrors(page: Page): string[] {
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

test("opens the bottom sheet, adds a sound, slides a slider and collapses", async ({ page }) => {
  const errors = watchErrors(page);
  const touch = await touchScreen(page);
  await page.goto("/#layers=engine-core");

  // Collapsed: the peek bar alone.
  const panel = page.locator(".panel");
  await expect(panel).toHaveAttribute("data-layout", "sheet");
  await expect(panel).toHaveAttribute("data-sheet", "collapsed");
  const bar = page.locator(".peek-bar");
  await expect(bar).toContainText("Starship Engine Core");
  await expect(page.getByRole("slider", { name: "Master volume" })).not.toBeInViewport();

  // Dragging the handle up opens it.
  const handle = await page.locator(".sheet-handle").boundingBox();
  if (!handle) {
    throw new Error("No sheet handle");
  }
  await touch.drag(195, handle.y + 10, 195, 300);
  await expect(panel).toHaveAttribute("data-sheet", "expanded");
  await expect(page.getByRole("slider", { name: "Master volume" })).toBeInViewport();

  // Add sound from the panel opens the picker, which fills the sheet.
  await page.getByRole("button", { name: "Add sound" }).tap();
  const search = page.getByRole("combobox", { name: "Search sounds" });
  await expect(search).toBeFocused();
  await page.getByRole("option", { name: /Brown Noise/ }).tap();
  await expect(page.getByRole("heading", { name: "Brown Noise" })).toBeFocused();
  await expect(bar).toContainText("Starship Engine Core + Brown Noise");
  await expect(page).toHaveURL(/layers=engine-core,brown-noise/);

  // A sideways drag moves a slider; a vertical swipe over it scrolls instead.
  const slider = page.locator("#param-brown-noise-volume");
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  if (!box) {
    throw new Error("No slider");
  }
  const y = box.y + box.height / 2;
  await touch.drag(box.x + box.width * 0.7, y, box.x + box.width * 0.25, y);
  await expect(page).toHaveURL(/brown-noise\.volume=(2\d|3\d)/);
  const value = await slider.inputValue();
  const content = page.locator(".sheet-content");
  const scrolled = await content.evaluate((element) => element.scrollTop);
  await touch.drag(box.x + box.width / 2, y, box.x + box.width / 2 + 4, y - 150);
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scrolled);
  expect(await slider.inputValue()).toBe(value);

  // A tap on the backdrop collapses it.
  await page.locator(".backdrop").tap({ position: { x: 195, y: 100 } });
  await expect(panel).toHaveAttribute("data-sheet", "collapsed");

  expect(errors).toEqual([]);
});

test("lays the panel out as a drawer in landscape", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/#layers=engine-core");
  const panel = page.locator(".panel");
  await expect(panel).toHaveAttribute("data-layout", "drawer");
  const box = await panel.boundingBox();
  expect(box?.height).toBe(390);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBe(844);
  await expect(page.getByRole("slider", { name: "Master volume" })).toBeInViewport();
  expect(errors).toEqual([]);
});
