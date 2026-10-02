import { defineConfig } from "vitest/config";

const acceptance = !!process.env.CI || process.env.WATCH_REQUIRE_DB === "1";
if (acceptance && !process.env.TEST_DATABASE_URL) {
  throw new Error("Acceptance tests require disposable PostgreSQL TEST_DATABASE_URL; DB suites must not skip");
}

export default defineConfig({
  test: {
    forbidOnly: acceptance,
    reporters: acceptance ? ["default", "json"] : ["default"],
    outputFile: acceptance ? { json: "test-results/vitest.json" } : undefined
  }
});
