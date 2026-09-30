import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadApiRuntimeConfig } from "@watch/config";
import { createDatabasePool } from "@watch/db";
import { processTelegramUpdate } from "./bot.js";
import { TelegramInbox } from "./inbox.js";
import { createConfiguredInventoryOrchestrator, startScheduledInventorySync } from "../inventory/runtime.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
const runtime = loadApiRuntimeConfig();
const pool = createDatabasePool(runtime.DATABASE_URL);
const inbox = new TelegramInbox(pool);
const inventoryOrchestrator = createConfiguredInventoryOrchestrator(pool, runtime);
const stopInventorySync = inventoryOrchestrator
  ? startScheduledInventorySync(inventoryOrchestrator, runtime.INVENTORY_SYNC_INTERVAL_SECONDS, {
      error: (fields, message) => console.error(message, fields)
    })
  : undefined;
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

try {
  while (running) {
    const update = await inbox.claim();
    if (!update) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    try {
      await processTelegramUpdate(pool, update.payload, {
        token: runtime.TELEGRAM_BOT_TOKEN,
        appBaseUrl: runtime.APP_BASE_URL,
        supportContact: runtime.SUPPORT_CONTACT
      });
      await inbox.complete(update);
    } catch (error) {
      console.error("Telegram update failed", { updateId: update.update_id,
        errorName: error instanceof Error ? error.name : "Unknown" });
      await inbox.fail(update, error);
    }
  }
} finally {
  await stopInventorySync?.();
  await pool.end();
}
