import { expect, test } from "@playwright/test";

test("finds, adds, stars and closes with the keyboard alone", async ({ page }) => {
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
  // Rest the pointer on the panel, so it doesn't fade while the test types.
  await page.locator(".panel").hover();

  await page.keyboard.press("/");
  const search = page.getByRole("combobox", { name: "Search sounds" });
  await expect(search).toBeFocused();
  const list = page.getByRole("listbox", { name: "Sounds" });
  await expect(list.getByRole("option", { name: "Starship Engine Core" })).toContainText(
    "In mix ✓",
  );

  // Search is accent- and case-blind; every word must match.
  await search.fill("BRÓWN waterfall");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "sound" })).toHaveText("1 sound");

  // Shift+Enter adds and keeps the picker open; `*` stars the active row.
  await search.press("Shift+Enter");
  await expect(list.getByRole("option", { name: "Brown Noise" })).toContainText("In mix ✓");
  await search.press("*");
  await expect(page.getByRole("group", { name: "Favourites" })).toContainText("Brown Noise");
  // Neither the search nor the stars go in the hash.
  await expect(page).toHaveURL(/#layers=engine-core,brown-noise$/);

  // Esc clears the search, then the chips, then closes and returns to Add sound.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await page
    .getByRole("toolbar", { name: "Categories" })
    .getByRole("button", { name: "Noise" })
    .click();
  await expect(list.getByRole("option")).toHaveCount(4);
  await search.press("Escape");
  await expect(list.getByRole("option").first()).toBeVisible();
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "Add sound" })).toBeFocused();

  // The star survives a reload, and picking a sound in the mix focuses its row.
  await page.reload();
  await page.locator(".panel").hover();
  await page.keyboard.press("/");
  await expect(page.getByRole("group", { name: "Favourites" })).toContainText("Brown Noise");
  await page.getByRole("combobox", { name: "Search sounds" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Brown Noise" })).toBeFocused();

  expect(errors).toEqual([]);
});
