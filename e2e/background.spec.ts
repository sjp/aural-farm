import type { Page } from "@playwright/test";
import { expect, startPlaying, test } from "./fixtures";

const output = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector("audio");
    return element
      ? { stream: element.srcObject instanceof MediaStream, paused: element.paused }
      : undefined;
  });

const session = (page: Page) =>
  page.evaluate(() => ({
    title: navigator.mediaSession.metadata?.title,
    artist: navigator.mediaSession.metadata?.artist,
    state: navigator.mediaSession.playbackState,
  }));

test("plays through a hidden audio element when Audio output is Media element", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.addInitScript(() => {
    localStorage.setItem("aural-farm.display.audioOutput", "media");
  });
  await page.goto("/#layers=engine-core");
  await startPlaying(page);
  await expect.poll(() => output(page)).toEqual({ stream: true, paused: false });
  await expect
    .poll(() => session(page))
    .toEqual({ title: "Starship Engine Core", artist: "Aural Farm", state: "playing" });

  // Pausing pauses the element once the fade has suspended the context.
  await page.getByRole("button", { name: "Pause" }).click();
  const play = page.getByRole("button", { name: "Play", exact: true });
  await expect(play).toBeVisible();
  await expect.poll(() => output(page)).toEqual({ stream: true, paused: true });
  await expect.poll(async () => (await session(page)).state).toBe("paused");

  // Playing again, then pausing the element from outside the app, pauses the app.
  await play.click();
  await expect.poll(() => output(page)).toEqual({ stream: true, paused: false });
  await page.evaluate(() => {
    document.querySelector("audio")?.pause();
  });
  await expect(play).toBeVisible();
  await expect.poll(async () => (await session(page)).state).toBe("paused");
  expect(errors).toEqual([]);
});

test("plays straight to the speakers on a desktop browser", async ({ page }) => {
  await page.goto("/#layers=engine-core");
  await startPlaying(page);
  expect(await output(page)).toBeUndefined();
  await expect.poll(async () => (await session(page)).state).toBe("playing");
});
