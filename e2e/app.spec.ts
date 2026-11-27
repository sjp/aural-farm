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
  await expect(page.getByRole("heading", { name: "Test Tone" })).toBeVisible();

  const pitch = page.getByLabel("Pitch");
  await expect(pitch).toBeVisible();
  await pitch.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/test-tone\.pitch=\d+/);

  const volume = page.getByLabel("Volume", { exact: true });
  await volume.fill("40");
  await expect(page).toHaveURL(/test-tone\.volume=40/);

  // An edited hash applies without a reload.
  await page.evaluate(() => {
    window.location.hash = "layers=test-tone&test-tone.wave=triangle";
  });
  await expect(page.getByRole("button", { name: "Triangle" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  expect(errors).toEqual([]);
});
