import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

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

const group = (page: Page, name: string) => page.getByRole("group", { name });

test("applies a preset, saves, renames, deletes and backs up mixes", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/#layers=engine-core");
  // Rest the pointer on the panel, so it doesn't fade while the test types.
  await page.locator(".panel").hover();

  // P opens the Mixes view; a preset crossfades in and names the mix.
  await page.keyboard.press("p");
  await expect(page.getByRole("heading", { name: "Mixes" })).toBeVisible();
  await group(page, "Presets")
    .getByRole("button", { name: /^Deep Brown/ })
    .click();
  await expect(page.getByRole("status")).toContainText("Replaced your mix");
  await expect(page).toHaveTitle("Deep Brown · Aural Farm");
  await expect(page).toHaveURL(/#name=Deep%20Brown&layers=brown-noise&/);
  await expect(group(page, "Presets").getByRole("button", { name: /^Deep Brown/ })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // Save it under a new name; it's listed, and named in the header.
  await page.getByRole("button", { name: "Save mix…" }).click();
  const name = page.getByRole("textbox", { name: "Mix name" });
  await expect(name).toHaveValue("Deep Brown");
  await name.fill("Bedtime");
  await name.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Saved Bedtime");
  await expect(group(page, "My mixes").getByRole("button", { name: /^Bedtime/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bedtime");
  await expect(page).toHaveURL(/#name=Bedtime&/);

  // A saved mix survives a reload; export it, delete it, and import it back.
  await page.reload();
  await page.locator(".panel").hover();
  await page.getByRole("button", { name: "Mixes" }).click();
  await expect(group(page, "My mixes").getByRole("button", { name: /^Bedtime/ })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export my mixes" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("aural-farm-mixes.json");
  const path = await file.path();
  const saved: unknown = JSON.parse(await readFile(path, "utf8"));
  expect(saved).toMatchObject({ app: "aural-farm", version: 1, mixes: [{ name: "Bedtime" }] });

  await page.getByRole("button", { name: "Delete Bedtime" }).click();
  await expect(group(page, "My mixes").getByText(/Mixes you save appear here/)).toBeVisible();
  await page.getByLabel("Import mixes file").setInputFiles(path);
  await expect(page.getByRole("status")).toHaveText("Imported 1 mix");
  await expect(group(page, "My mixes").getByRole("button", { name: /^Bedtime/ })).toBeVisible();

  // Rename keeps the mix playing in step.
  await page.getByRole("button", { name: "Rename Bedtime" }).click();
  const rename = page.getByRole("textbox", { name: "New name for Bedtime" });
  await rename.fill("Lights Out");
  await rename.press("Enter");
  await expect(page).toHaveTitle("Lights Out · Aural Farm");

  expect(errors).toEqual([]);
});
