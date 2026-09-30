import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadApiRuntimeConfig } from "@watch/config";
import { checkDatabaseReady, createDatabasePool } from "@watch/db";
import { createApp } from "./app.js";
import { SessionStore } from "./auth/session.js";
import { TelegramInbox } from "./telegram/inbox.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const runtimeConfig = loadApiRuntimeConfig();
const pool = createDatabasePool(runtimeConfig.DATABASE_URL);
const adminTelegramIds = new Set(runtimeConfig.ADMIN_TELEGRAM_IDS);
const app = createApp({
  checkReadiness: () => checkDatabaseReady(pool),
  auth: {
    store: new SessionStore(pool, adminTelegramIds),
    csrfSecret: runtimeConfig.CSRF_SECRET,
    appBaseUrl: runtimeConfig.APP_BASE_URL,
    adminIds: () => adminTelegramIds,
    botToken: runtimeConfig.TELEGRAM_BOT_TOKEN
  },
  webhook: { secret: runtimeConfig.TELEGRAM_WEBHOOK_SECRET, inbox: new TelegramInbox(pool) }
});
pool.on("error", (error) => {
  app.log.error({ errorName: error.name }, "Idle database connection failed");
});
app.addHook("onClose", async () => pool.end());

try {
  await app.listen({ host: runtimeConfig.API_HOST, port: runtimeConfig.API_PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
