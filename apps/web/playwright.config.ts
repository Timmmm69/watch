import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  forbidOnly: !!process.env.CI,
  // Real Session suites share API port 3001.
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/playwright.json" }]] : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    // The existing real-backend suites use Next's development API proxy.
    command: `pnpm dev --hostname 127.0.0.1 --port ${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
    url: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI
  }
});
