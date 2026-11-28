import type { Page } from "@playwright/test";
import { expect, startPlaying, test } from "./fixtures";

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

const clock = (page: Page) => page.getByRole("button", { name: /^Sleep timer/ });
const menu = (page: Page) => page.getByRole("dialog", { name: "Sleep timer" });
const choice = (page: Page, group: string, name: string) =>
  menu(page).getByRole("group", { name: group }).getByRole("button", { name, exact: true });

test("starts, reschedules and cancels a sleep timer without errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/#layers=engine-core");
  await startPlaying(page);

  await clock(page).click();
  await choice(page, "Sleep timer", "15 min").click();
  await expect(menu(page)).toBeHidden();
  await expect(clock(page)).toHaveAccessibleName("Sleep timer, 15:00 left");

  // A new fade-out reschedules the running fade; a new length restarts it.
  await clock(page).click();
  await choice(page, "Fade out over", "15 min").click();
  await choice(page, "Fade out over", "10 s").click();
  await choice(page, "Sleep timer", "1 h").click();
  await expect(clock(page)).toHaveAccessibleName("Sleep timer, 1:00:00 left");

  // T cycles on from 1 h, then Off cancels.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("t");
  await expect(page.getByRole("status")).toHaveText("Sleep timer: 1 h 30");
  await page.keyboard.press("t");
  await expect(page.getByRole("status")).toHaveText("Sleep timer: Off");
  await expect(clock(page)).toHaveAccessibleName("Sleep timer");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("fades out and pauses by itself when a one-minute timer runs out", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto("/#layers=engine-core");
  await startPlaying(page);

  await clock(page).click();
  await choice(page, "Fade out over", "10 s").click();
  await choice(page, "Sleep timer", "Custom").click();
  await menu(page).getByLabel("Minutes").fill("1");
  await menu(page).getByRole("button", { name: "Start" }).click();
  await expect(clock(page)).toHaveAccessibleName("Sleep timer, 1:00 left");
  // The last minute counts down each second.
  await expect(clock(page)).toHaveAccessibleName(/Sleep timer, 0:5\d left/);

  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({
    timeout: 75_000,
  });
  await expect(clock(page)).toHaveAccessibleName("Sleep timer");
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe("paused");
  expect(errors).toEqual([]);
});
