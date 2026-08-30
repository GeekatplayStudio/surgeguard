import { defineConfig, devices } from "@playwright/test";

// Real-browser tests for the parts Vitest/jsdom cannot exercise honestly:
// canvas hit-testing, popup DOM, and the click-driven game interactions.
// See src/game/*.test.ts for the logic-level unit/integration coverage -
// this suite exists to catch regressions that only show up when an actual
// browser paints the canvas and dispatches real pointer events.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5183",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 5183 --strictPort",
    url: "http://localhost:5183",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
