import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { currentLegalDocuments, loadApiRuntimeConfig } from "@watch/config";
import { createDatabasePool } from "@watch/db";
import { bootstrapRelease } from "./bootstrap.js";
import { verifyInstalledRelease } from "./readiness.js";
import { cleanupTransportData, retryFailed, supportDiagnostics } from "./maintenance.js";
import { verifyS12FinancialData } from "../finance/gate.js";
import { callBot } from "../telegram/bot.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
const [command, ...args] = process.argv.slice(2);
let stage = "config";
try {
  const runtime = loadApiRuntimeConfig();
  if (command === "config") {
    console.log(JSON.stringify({ status: "ok", command }));
  } else if (command === "database-name") {
    const database = decodeURIComponent(new URL(runtime.DATABASE_URL).pathname.slice(1));
    if (!/^(watch|watch_restore_[a-z0-9_]+)$/.test(database)) throw new Error("Unsupported deployment database name");
    console.log(JSON.stringify({ database }));
  } else if (command === "webhook-info" || command === "webhook-remove") {
    stage = command;
    const info = await callBot<{ pending_update_count?: number; last_error_date?: number }>(runtime.TELEGRAM_BOT_TOKEN, command === "webhook-info" ? "getWebhookInfo" : "deleteWebhook", { drop_pending_updates: false });
    // Telegram URLs/errors may include credentials/PII: emit only operational counters.
    const safe = info;
    console.log(JSON.stringify({ status: "ok", command, pendingUpdates: safe.pending_update_count, lastErrorAt: safe.last_error_date }));
  } else {
    stage = "database";
    let databaseUrl = runtime.DATABASE_URL;
    if (command === "verify-restore") {
      const target = process.env.WATCH_RESTORE_DATABASE;
      if (!target || !/^watch_restore_[a-z0-9_]+$/.test(target)) throw new Error("Restore verification requires an isolated watch_restore_ database");
      const url = new URL(databaseUrl); url.pathname = `/${target}`; databaseUrl = url.toString();
    }
    const pool = createDatabasePool(databaseUrl);
    try {
      stage = command ?? "command";
      if (command === "bootstrap" && args.length === 1) await bootstrapRelease(pool, runtime, args[0]!);
      else if (command === "verify" || command === "verify-restore") {
        await verifyInstalledRelease(pool, runtime);
        await verifyS12FinancialData(pool);
        const directory = fileURLToPath(new URL("../../../../packages/db/prisma/migrations/", import.meta.url));
        const applied = await pool.query<{ migration_name: string; checksum: string }>(
          "SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name");
        const names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
        if (JSON.stringify(applied.rows.map((row) => row.migration_name)) !== JSON.stringify(names)) throw new Error("Migration history does not match this release");
        for (const row of applied.rows) {
          const sql = await readFile(`${directory}/${row.migration_name}/migration.sql`);
          if (row.checksum !== createHash("sha256").update(sql).digest("hex")) throw new Error("Migration checksum mismatch");
        }
        // A restored database must also be queryable using the least-privilege app role.
        await pool.query("SELECT id FROM orders LIMIT 1");
        await pool.query("SELECT id FROM ledger_entries LIMIT 1");
        console.log(JSON.stringify({ migrations: applied.rows.length, legalTypes: Object.keys(currentLegalDocuments(runtime)) }));
      } else if (command === "diagnostics") console.log(JSON.stringify(await supportDiagnostics(pool)));
      else if (command === "cleanup") await cleanupTransportData(pool, runtime.TELEGRAM_UPDATE_RETENTION_DAYS);
      else if ((command === "retry-event" || command === "retry-telegram") && args.length === 2) {
        await retryFailed(pool, command === "retry-event" ? "event" : "telegram", args[0]!, args[1]!, runtime.ADMIN_TELEGRAM_IDS);
      } else throw new Error("Unknown operations command or invalid arguments");
      console.log(JSON.stringify({ status: "ok", command }));
    } finally { await pool.end(); }
  }
} catch (error) {
  // Never print config values, DB error detail, raw updates or Telegram replies.
  console.error(JSON.stringify({ status: "failed", command, stage, errorName: error instanceof Error ? error.name : "Unknown" }));
  process.exitCode = 1;
}
