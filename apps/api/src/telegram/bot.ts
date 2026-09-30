import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

interface BotConfig {
  token: string;
  appBaseUrl: string;
  supportContact: string;
}

interface TelegramMessage {
  chat?: { id?: number; type?: string };
  from?: { id?: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string; language_code?: string };
  text?: string;
}

export async function processTelegramUpdate(pool: Pool, payload: unknown, config: BotConfig,
  send: (method: string, body: Record<string, unknown>) => Promise<void> = (method, body) => callBot(config.token, method, body)
): Promise<void> {
  if (!payload || typeof payload !== "object") return;
  const message = (payload as { message?: TelegramMessage }).message;
  const from = message?.from;
  const chat = message?.chat;
  if (!message || !from || !chat || chat.type !== "private" || typeof from.id !== "number" ||
    !Number.isSafeInteger(from.id) || typeof chat.id !== "number" || !Number.isSafeInteger(chat.id) ||
    from.is_bot || typeof from.first_name !== "string" || !from.first_name ||
    typeof message.text !== "string") return;

  const command = message.text.split(/\s/, 1)[0]?.split("@")[0];
  if (command !== "/start" && command !== "/help") return;
  if (command === "/start") {
    const user = await pool.query<{ is_blocked: boolean }>(`
      INSERT INTO users (id, telegram_user_id, first_name, last_name, username, language_code,
        bot_can_message, bot_started_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, now())
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
        username = EXCLUDED.username, language_code = EXCLUDED.language_code,
        bot_can_message = true, bot_started_at = now(), updated_at = now()
      RETURNING is_blocked
    `, [randomUUID(), String(from.id), from.first_name.slice(0, 128),
      typeof from.last_name === "string" ? from.last_name.slice(0, 128) : null,
      typeof from.username === "string" ? from.username.slice(0, 64) : null,
      typeof from.language_code === "string" ? from.language_code.slice(0, 16) : null]);
    if (user.rows[0]?.is_blocked) {
      await send("sendMessage", { chat_id: chat.id, text: "Доступ к приложению ограничен. Обратитесь в поддержку." });
      return;
    }
  }

  const text = command === "/start"
    ? "Добро пожаловать! Откройте приложение, чтобы посмотреть магазин и начать работу с партнёрской программой."
    : `Помощь по работе с ботом: ${config.supportContact}`;
  await send("sendMessage", {
    chat_id: chat.id,
    text,
    reply_markup: { inline_keyboard: [[{ text: "Открыть приложение", web_app: { url: config.appBaseUrl } }]] }
  });
}

export async function callBot(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Telegram ${method} HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
    throw new Error(`Telegram ${method} failed`);
  }
}
