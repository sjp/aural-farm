import { expect, test } from "@playwright/test";

test("mutes, solos, removes with undo, and lights the activity dot while playing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.goto("/#layers=brown-noise");

  // Start playing: autoplay, or a click where the browser asks for one.
  const playing = page.locator('button[aria-label="Pause"]:not([aria-busy="true"])');
  const tap = page.getByRole("button", { name: "Tap to play" });
  await expect(playing.or(tap)).toBeVisible();
  if (await tap.isVisible()) {
    await tap.click();
  }
  await expect(playing).toBeVisible();

  // The tint dot follows the layer's level while the panel is seen.
  const dot = page.locator(".layer .layer-dot");
  await page.mouse.move(10, 10);
  await expect
    .poll(async () => Number(await dot.evaluate((el) => el.style.getPropertyValue("--level"))))
    .toBeGreaterThan(0.3);

  const mute = page.getByRole("button", { name: "Mute Brown Noise" });
  await mute.click();
  await expect(page).toHaveURL(/brown-noise\.muted=1/);
  await expect(page.locator(".layer")).toHaveAttribute("data-muted", "true");
  await page.keyboard.press("1");
  await expect(mute).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Solo Brown Noise" }).click();
  await expect(page.getByRole("button", { name: "Clear solo" })).toBeVisible();
  await expect(page).not.toHaveURL(/solo/);
  await page.getByRole("button", { name: "Clear solo" }).click();

  // Removing the only layer leaves the empty state, with Undo in a toast.
  await page.getByRole("button", { name: "Remove Brown Noise" }).click();
  await expect(page.getByText("Add a sound to start")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add sound" })).toBeFocused();
  await expect(page).toHaveURL(/layers=$/);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("heading", { name: "Brown Noise" })).toBeVisible();
  await expect(page).toHaveURL(/layers=brown-noise/);

  // `/` opens the Add sound list.
  await page.getByRole("button", { name: "Remove Brown Noise" }).click();
  await page.keyboard.press("/");
  const add = page.getByRole("list", { name: "Sounds to add" }).getByRole("button", {
    name: "Brown Noise",
  });
  await expect(add).toBeFocused();
  await add.press("Enter");
  await expect(page.getByRole("heading", { name: "Brown Noise" })).toBeFocused();

  expect(errors).toEqual([]);
});
