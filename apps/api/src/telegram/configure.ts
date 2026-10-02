import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadApiRuntimeConfig } from "@watch/config";
import { callBot } from "./bot.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
const runtime = loadApiRuntimeConfig();
const appUrl = new URL(runtime.APP_BASE_URL);
if (appUrl.protocol !== "https:") throw new Error("APP_BASE_URL must use HTTPS for Telegram setup");
const webhookUrl = new URL("/api/v1/telegram/webhook", appUrl).toString();

await callBot(runtime.TELEGRAM_BOT_TOKEN, "setMyCommands", { commands: [
  { command: "start", description: "Открыть приложение" },
  { command: "help", description: "Помощь" },
  { command: "catalog", description: "Каталог" },
  { command: "orders", description: "Заказы" },
  { command: "balance", description: "Доходы" }
] });
await callBot(runtime.TELEGRAM_BOT_TOKEN, "setChatMenuButton", {
  menu_button: { type: "web_app", text: "Открыть приложение", web_app: { url: appUrl.toString() } }
});
await callBot(runtime.TELEGRAM_BOT_TOKEN, "setWebhook", {
  url: webhookUrl, secret_token: runtime.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message"]
});
console.log("Telegram bot commands, menu and webhook configured");
