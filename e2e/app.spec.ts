import { expect, test } from "./fixtures";

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
  // Rest the pointer on the panel, so it can't fade out (and leave the accessibility
  // tree) if a step takes longer than the idle timeout on a busy machine.
  await page.locator(".panel").hover();
  await expect(page.getByRole("heading", { name: "Aural Farm" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Starship Engine Core" })).toBeVisible();

  const power = page.getByRole("slider", { name: "Power" });
  await expect(power).toBeVisible();
  await power.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/engine-core\.power=56/);

  const volume = page.getByLabel("Volume", { exact: true });
  await volume.fill("40");
  await expect(page).toHaveURL(/engine-core\.volume=40/);

  // An edited hash applies without a reload.
  await page.evaluate(() => {
    window.location.hash = "layers=engine-core&engine-core.room=25";
  });
  await expect(page.getByRole("slider", { name: "Room" })).toHaveValue("25");

  expect(errors).toEqual([]);
});
