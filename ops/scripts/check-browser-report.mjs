import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const report = JSON.parse(await readFile(new URL("../../apps/web/test-results/playwright.json", import.meta.url), "utf8"));
assert.equal(report.errors.length, 0);
assert.ok(report.stats.expected > 0, "Browser acceptance must execute tests");
assert.equal(report.stats.skipped, 0, "Mandatory browser flows must not skip");
assert.equal(report.stats.unexpected, 0);
assert.equal(report.stats.flaky, 0);
console.log(`Browser acceptance: ${report.stats.expected} passed, no skipped tests`);
