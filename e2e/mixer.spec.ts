import { expect, startPlaying, test } from "./fixtures";

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
  await page.goto("/#layers=engine-core");

  await startPlaying(page);

  // The tint dot follows the layer's level while the panel is seen.
  const dot = page.locator(".layer .layer-dot");
  await page.mouse.move(10, 10);
  await expect
    .poll(async () => Number(await dot.evaluate((el) => el.style.getPropertyValue("--level"))))
    .toBeGreaterThan(0.3);

  const mute = page.getByRole("button", { name: "Mute Starship Engine Core" });
  await mute.click();
  await expect(page).toHaveURL(/engine-core\.muted=1/);
  await expect(page.locator(".layer")).toHaveAttribute("data-muted", "true");
  await page.keyboard.press("1");
  await expect(mute).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Solo Starship Engine Core" }).click();
  await expect(page.getByRole("button", { name: "Clear solo" })).toBeVisible();
  await expect(page).not.toHaveURL(/solo/);
  await page.getByRole("button", { name: "Clear solo" }).click();

  // Removing the only layer leaves the empty state, with Undo in a toast.
  await page.getByRole("button", { name: "Remove Starship Engine Core" }).click();
  await expect(page.getByText("Add a sound to start")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add sound" })).toBeFocused();
  await expect(page).toHaveURL(/layers=$/);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("heading", { name: "Starship Engine Core" })).toBeVisible();
  await expect(page).toHaveURL(/layers=engine-core/);

  // `/` opens the sound picker, whose first row Enter adds.
  await page.getByRole("button", { name: "Remove Starship Engine Core" }).click();
  await page.keyboard.press("/");
  const search = page.getByRole("combobox", { name: "Search sounds" });
  await expect(search).toBeFocused();
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "Starship Engine Core" })).toBeFocused();

  expect(errors).toEqual([]);
});
