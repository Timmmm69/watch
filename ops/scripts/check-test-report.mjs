import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// A missing report, empty suite, failure, skip or todo cannot certify acceptance.
const report = JSON.parse(await readFile(new URL("../../apps/api/test-results/vitest.json", import.meta.url), "utf8"));
assert.equal(report.success, true, "Acceptance test run failed");
assert.ok(report.numTotalTests > 0, "Acceptance must execute tests");
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0, "Acceptance tests must not skip");
assert.equal(report.numTodoTests ?? 0, 0, "Acceptance tests must not be todo");
for (const suite of report.testResults) {
  for (const result of suite.assertionResults) {
    assert.equal(result.status, "passed", `${suite.name}: ${result.fullName}`);
  }
}
console.log(`Acceptance: ${report.numTotalTests} passed, no skipped tests`);
