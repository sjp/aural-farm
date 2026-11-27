import { expect, test } from "@playwright/test";

test("shows the panel with the default layer and keeps the hash in sync", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Aural Farm" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Brown Noise" })).toBeVisible();

  const tone = page.getByRole("slider", { name: "Tone" });
  await expect(tone).toBeVisible();
  await tone.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/brown-noise\.tone=-9/);

  const volume = page.getByLabel("Volume", { exact: true });
  await volume.fill("40");
  await expect(page).toHaveURL(/brown-noise\.volume=40/);

  // An edited hash applies without a reload.
  await page.evaluate(() => {
    window.location.hash = "layers=brown-noise&brown-noise.width=25";
  });
  await expect(page.getByRole("slider", { name: "Width" })).toHaveValue("25");

  expect(errors).toEqual([]);
});
