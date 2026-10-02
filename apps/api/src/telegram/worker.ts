import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadApiRuntimeConfig } from "@watch/config";
import { createDatabasePool } from "@watch/db";
import { processTelegramUpdate } from "./bot.js";
import { TelegramInbox } from "./inbox.js";
import { callBot } from "./bot.js";
import { EventOutbox } from "../notifications/outbox.js";
import { BlockedError, dispatchEvent } from "../notifications/dispatch.js";
import { createConfiguredInventoryOrchestrator, startScheduledInventorySync } from "../inventory/runtime.js";
import { OrderCompletionWorker, startScheduledOrderCompletion } from "../orders/completion.js";
import { verifyS12FinancialData } from "../finance/gate.js";
import { verifyInstalledRelease } from "../operations/readiness.js";
import { cleanupTransportData, startScheduledCleanup } from "../operations/maintenance.js";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
const runtime = loadApiRuntimeConfig();
const pool = createDatabasePool(runtime.DATABASE_URL);
try {
  await verifyInstalledRelease(pool, runtime);
  await verifyS12FinancialData(pool);
  await cleanupTransportData(pool, runtime.TELEGRAM_UPDATE_RETENTION_DAYS);
} catch (error) {
  await pool.end();
  console.error(JSON.stringify({ level: "error", message: "Worker startup verification failed", errorName: error instanceof Error ? error.name : "Unknown" }));
  process.exit(1);
}
const logger = { error: (fields: object, message: string) => console.error(JSON.stringify({ level: "error", message, ...fields })) };
const stopCleanup = startScheduledCleanup(pool, runtime.TELEGRAM_UPDATE_RETENTION_DAYS, logger);
const heartbeatPath = join(tmpdir(), "watch-worker-heartbeat");
const heartbeat = () => writeFile(heartbeatPath, String(Date.now())).catch(() => { running = false; process.exitCode = 1; });
const inbox = new TelegramInbox(pool);
const outbox = new EventOutbox(pool);
const stopOrderCompletion = startScheduledOrderCompletion(new OrderCompletionWorker(pool), logger);
const inventoryOrchestrator = createConfiguredInventoryOrchestrator(pool, runtime);
const stopInventorySync = inventoryOrchestrator
  ? startScheduledInventorySync(inventoryOrchestrator, runtime.INVENTORY_SYNC_INTERVAL_SECONDS, logger)
  : undefined;

function isBlockedError(error: unknown): boolean {
  return error instanceof BlockedError || (error instanceof Error && /blocked|deactivated/i.test(error.message));
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    await callBot(runtime.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: chatId, text });
  } catch (error) {
    if (isBlockedError(error)) throw new BlockedError();
    throw error;
  }
}

let running = true;
await heartbeat();
const heartbeatTimer = setInterval(() => { void heartbeat(); }, 5000);
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function runInboxLoop(): Promise<void> {
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
      logger.error({ updateId: update.update_id,
        errorName: error instanceof Error ? error.name : "Unknown" }, "Telegram update failed");
      await inbox.fail(update, error);
    }
  }
}

async function runOutboxLoop(): Promise<void> {
  const dispatchConfig = {
    appBaseUrl: runtime.APP_BASE_URL,
    supportContact: runtime.SUPPORT_CONTACT,
    botUsername: runtime.TELEGRAM_BOT_USERNAME,
    adminTelegramIds: new Set(runtime.ADMIN_TELEGRAM_IDS)
  };
  while (running) {
    const event = await outbox.claim();
    if (!event) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    try {
      await dispatchEvent(pool, event, dispatchConfig, sendMessage);
      await outbox.complete(event);
    } catch (error) {
      logger.error({ eventId: event.id, type: event.type,
        errorName: error instanceof Error ? error.name : "Unknown" }, "Outbox event failed");
      await outbox.fail(event, error);
    }
  }
}

try {
  await Promise.all([runInboxLoop(), runOutboxLoop()]);
} finally {
  running = false;
  clearInterval(heartbeatTimer);
  await unlink(heartbeatPath).catch(() => {});
  await stopCleanup();
  await stopOrderCompletion();
  await stopInventorySync?.();
  await pool.end();
}
