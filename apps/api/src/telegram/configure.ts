import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadApiRuntimeConfig } from "@watch/config";
import { callBot } from "./bot.js";
import { botConfiguration } from "./configuration.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
const runtime = loadApiRuntimeConfig();
for (const operation of botConfiguration(runtime.APP_BASE_URL, runtime.TELEGRAM_WEBHOOK_SECRET)) {
  await callBot(runtime.TELEGRAM_BOT_TOKEN, operation.method, operation.body);
}
console.log("Telegram bot descriptions, commands, menu and webhook configured");
