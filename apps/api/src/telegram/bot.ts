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
  if (!["/start", "/help", "/catalog", "/orders", "/balance"].includes(command ?? "")) return;
  if (command === "/start") {
    await pool.query(`
      INSERT INTO users (id, telegram_user_id, first_name, last_name, username, language_code,
        bot_can_message, bot_started_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, now())
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
        username = EXCLUDED.username, language_code = EXCLUDED.language_code,
        bot_can_message = true, bot_started_at = now(), updated_at = now()
    `, [randomUUID(), String(from.id), from.first_name.slice(0, 128),
      typeof from.last_name === "string" ? from.last_name.slice(0, 128) : null,
      typeof from.username === "string" ? from.username.slice(0, 64) : null,
      typeof from.language_code === "string" ? from.language_code.slice(0, 16) : null]);
  }

  // Read current server state for every command: cached menus must not outlive a block.
  const user = (await pool.query<{ is_blocked: boolean; partner_status: "ACTIVE" | "BLOCKED" | null }>(`
    SELECT u.is_blocked, p.status AS partner_status
    FROM users u LEFT JOIN partners p ON p.user_id = u.id
    WHERE u.telegram_user_id = $1
  `, [String(from.id)])).rows[0];
  const partner = !!user?.partner_status;
  const blocked = user?.partner_status === "BLOCKED";
  const button = (text: string, path: string) => ({ text, web_app: { url: new URL(path, config.appBaseUrl).toString() } });
  const history = [button("Заказы", partner ? "/partner/orders" : "/orders")];
  const menu = user?.is_blocked ? [] : partner
    ? blocked
      ? [[button("Партнёрский кабинет", "/partner")], history, [button("Доходы", "/partner/earnings")]]
      : [[button("Партнёрский кабинет", "/partner")], [button("Партнёрский каталог", "/shop")], history,
        [button("Доходы", "/partner/earnings")], [button("Открыть магазин", "/shop")]]
    : [[button("Стать партнёром", "/partner/onboarding")], [button("Открыть магазин", "/shop")]];
  let text = "Делитесь товарами и получайте комиссию за завершённые заказы. Примите условия в приложении, чтобы стать партнёром.";
  let keyboard = menu;
  if (partner) text = "Откройте партнёрский кабинет, каталог, историю заказов или доходы.";
  if (command === "/help") text = `Бот помогает открыть магазин, заказы и партнёрский кабинет. Поддержка: ${config.supportContact}`;
  if (command === "/catalog") {
    text = partner ? "Партнёрский каталог в приложении." : "Каталог магазина в приложении.";
    keyboard = [[button(partner ? "Просмотреть каталог" : "Открыть магазин", "/shop")]];
  }
  if (command === "/orders") { text = "История заказов в приложении."; keyboard = [history]; }
  if (command === "/balance" && partner) {
    text = "Доходы и история начислений в приложении.";
    keyboard = [[button("Доходы", "/partner/earnings")]];
  }
  if (command === "/balance" && !partner) keyboard = [[button("Стать партнёром", "/partner/onboarding")]];
  if (blocked) text = `Партнёрский аккаунт заблокирован. Доступен только просмотр, продажи и новые ссылки недоступны. ${text}`;
  if (user?.is_blocked) {
    text = "Доступ к приложению ограничен. Обратитесь в поддержку.";
    keyboard = [];
  }
  if (command !== "/help" || user?.is_blocked) text += ` Поддержка: ${config.supportContact}`;
  try {
    await send("sendMessage", { chat_id: chat.id, text,
      ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  } catch (error) {
    if (!(error instanceof Error) || !/blocked|deactivated/i.test(error.message)) throw error;
    await pool.query("UPDATE users SET bot_can_message = false WHERE telegram_user_id = $1", [String(from.id)]);
  }
}

export async function callBot<T = void>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error(`Telegram ${method} blocked`);
    throw new Error(`Telegram ${method} HTTP ${response.status}`);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
    const description = (result as { description?: unknown }).description;
    if (typeof description === "string" && /blocked|deactivated/i.test(description)) {
      throw new Error(`Telegram ${method} blocked: ${description}`);
    }
    throw new Error(`Telegram ${method} failed`);
  }
  return (result as { result: T }).result;
}
