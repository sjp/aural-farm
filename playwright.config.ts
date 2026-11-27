import { defineConfig } from "@playwright/test";

const PORT = 5199;
const CI = (process.env.CI ?? "") !== "";

/**
 * Browser tests in headless Chromium, run against the Vite dev server so the
 * dev-only checks are active too. The sound reporter gathers the sound checks' measurements into
 * `test-results/sounds.json` and a table.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: CI,
  reporter: [["list"], ...(CI ? [["github"] as const] : []), ["./e2e/sound-reporter.ts"]],
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
