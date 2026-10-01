import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("S12 acceptance requires a migrated disposable PostgreSQL TEST_DATABASE_URL; skipped DB tests cannot pass the financial gate");
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", "src/finance/", "src/orders/checkout.integration.test.ts", "src/orders/admin.integration.test.ts",
  "src/orders/admin.routes.test.ts", "src/orders/completion.test.ts"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
