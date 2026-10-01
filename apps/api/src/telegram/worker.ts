import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadApiRuntimeConfig } from "@watch/config";
import { checkDatabaseReady, createDatabasePool } from "@watch/db";
import { processTelegramUpdate } from "./bot.js";
import { TelegramInbox } from "./inbox.js";
import { callBot } from "./bot.js";
import { EventOutbox } from "../notifications/outbox.js";
import { BlockedError, dispatchEvent } from "../notifications/dispatch.js";
import { createConfiguredInventoryOrchestrator, startScheduledInventorySync } from "../inventory/runtime.js";
import { OrderCompletionWorker, startScheduledOrderCompletion } from "../orders/completion.js";
import { verifyS12FinancialData } from "../finance/gate.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
const runtime = loadApiRuntimeConfig();
const pool = createDatabasePool(runtime.DATABASE_URL);
try {
  await checkDatabaseReady(pool);
  await verifyS12FinancialData(pool);
} catch (error) {
  await pool.end();
  throw error;
}
const inbox = new TelegramInbox(pool);
const outbox = new EventOutbox(pool);
const stopOrderCompletion = startScheduledOrderCompletion(new OrderCompletionWorker(pool), {
  error: (fields, message) => console.error(message, fields)
});
const inventoryOrchestrator = createConfiguredInventoryOrchestrator(pool, runtime);
const stopInventorySync = inventoryOrchestrator
  ? startScheduledInventorySync(inventoryOrchestrator, runtime.INVENTORY_SYNC_INTERVAL_SECONDS, {
      error: (fields, message) => console.error(message, fields)
    })
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
      console.error("Telegram update failed", { updateId: update.update_id,
        errorName: error instanceof Error ? error.name : "Unknown" });
      await inbox.fail(update, error);
    }
  }
}

async function runOutboxLoop(): Promise<void> {
  const dispatchConfig = {
    appBaseUrl: runtime.APP_BASE_URL,
    supportContact: runtime.SUPPORT_CONTACT,
    botUsername: runtime.TELEGRAM_BOT_USERNAME
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
      console.error("Outbox event failed", { eventId: event.id, type: event.type,
        errorName: error instanceof Error ? error.name : "Unknown" });
      await outbox.fail(event, error);
    }
  }
}

try {
  await Promise.all([runInboxLoop(), runOutboxLoop()]);
} finally {
  await stopOrderCompletion();
  await stopInventorySync?.();
  await pool.end();
}
