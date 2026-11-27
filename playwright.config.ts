import { defineConfig } from "@playwright/test";

const PORT = 5199;
const CI = (process.env.CI ?? "") !== "";

/**
 * Browser tests in headless Chromium, run against the Vite dev server so the
 * dev-only checks are active too.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: CI,
  reporter: CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    browserName: "chromium",
  },
  webServer: {
    command: `npx vite --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}/`,
    reuseExistingServer: !CI,
  },
});
