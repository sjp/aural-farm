import { defineConfig } from "@playwright/test";

const PORT = 5199;
const CI = (process.env.CI ?? "") !== "";

/**
 * Browser tests in headless Chromium, run against the Vite dev server so the
 * dev-only checks are active too. The sound cost checks time renders, so they
 * run in their own project, one at a time, once every other test has finished.
 * The sound reporter gathers the sound checks' measurements into
 * `test-results/sounds.json` and a table.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: true,
  // A worker per core: the default, half the cores, leaves a 4-core CI runner idle
  // while tests wait on the browser.
  ...(CI ? { workers: "100%" } : {}),
  forbidOnly: CI,
  reporter: [["list"], ...(CI ? [["github"] as const] : []), ["./e2e/sound-reporter.ts"]],
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    browserName: "chromium",
    // Software WebGL, so the backdrop draws on machines and CI runners without a GPU.
    // The page itself is composited in software: composited through SwiftShader, a
    // page's main thread blocks about 1 s after each navigation (while Chromium tears
    // down the previous document's compositor) until SwiftShader drains its queue,
    // which takes several seconds when parallel browsers starve it of CPU.
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-compositing"],
    },
  },
  projects: [
    { name: "browser", testIgnore: /(sound-cost|mobile)\.spec\.ts$/ },
    {
      // A phone-sized touch screen, for the bottom sheet and touch controls.
      name: "mobile",
      testMatch: /mobile\.spec\.ts$/,
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    {
      name: "cost",
      testMatch: /sound-cost\.spec\.ts$/,
      dependencies: ["browser", "mobile"],
      workers: 1,
    },
  ],
  webServer: {
    command: `npx vite --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}/`,
    reuseExistingServer: !CI,
  },
});
