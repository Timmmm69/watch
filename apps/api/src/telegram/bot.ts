import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

interface BotConfig {
  token: string;
  appBaseUrl: string;
  supportContact: string;
  nativeCommerce?: boolean;
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
  const native = config.nativeCommerce ?? false;
  const blocked = user?.partner_status === "BLOCKED";
  const button = (text: string, path: string) => ({ text, web_app: { url: new URL(path, config.appBaseUrl).toString() } });
  const contact = config.supportContact.trim();
  let supportUrl: string | undefined;
  if (/^@[a-zA-Z0-9_]+$/.test(contact)) supportUrl = `https://t.me/${contact.slice(1)}`;
  else {
    try {
      const url = new URL(contact);
      if (url.protocol === "https:" || url.protocol === "http:") supportUrl = url.href;
    } catch { /* Non-link contacts remain available in the message text. */ }
  }
  const supportMenu = native && supportUrl
    ? [[{ text: partner ? "Поддержка партнёров" : "Связаться с магазином", url: supportUrl }]] : [];
  const history = [button("Заказы", partner ? "/partner/orders" : "/orders")];
  const menu = user?.is_blocked ? [] : partner
    ? blocked
      ? [[button("Партнёрский кабинет", "/partner")], history, [button("Доходы", "/partner/earnings")], ...supportMenu]
      : [[button("Партнёрский кабинет", "/partner")], [button(native ? "Часы для продажи" : "Партнёрский каталог", native ? "/shop?mode=partner" : "/shop")], history,
        [button(native ? "Заработок" : "Доходы", "/partner/earnings"), button("Выплаты", "/partner/payouts")], ...supportMenu]
    : [[button(native ? "Выбрать часы" : "Открыть магазин", "/shop")], ...[[button("Корзина", "/cart"), ...history]],
      ...supportMenu, [button(native ? "Продавать с нами" : "Стать партнёром", "/partner/onboarding")]];
  let text = native
    ? "Здравствуйте! Выбирайте часы по розничной цене, добавляйте в корзину и оформляйте заказ. Покупка по ссылке партнёра не меняет цену."
    : "Выберите товар в магазине, добавьте его в корзину и оформите заказ. Свои заказы можно посмотреть здесь же.";
  let keyboard = menu;
  if (partner) text = native
    ? "Оформляйте заказы клиентам по согласованной цене или делитесь партнёрской ссылкой: клиент сам купит по розничной цене, а вы получите установленную комиссию. Для себя покупайте в розничном магазине."
    : "Делитесь ссылками на товары и получайте комиссию за завершённые заказы. Заказы, доходы и выплаты доступны в кабинете.";
  if (command === "/help") text = native
    ? partner
      ? "Чтобы оформить заказ для покупателя, выберите часы, укажите цену продажи и данные получателя. Статусы заказов, заработок и заявки на выплату смотрите в партнёрском кабинете. Также можно отправить партнёрскую ссылку: клиент купит самостоятельно по розничной цене, а вы получите установленную комиссию. По вопросам работы напишите в поддержку партнёров."
      : "Выберите часы, добавьте их в корзину и оформите заказ. В корзине виден источник покупки: напрямую или по ссылке партнёра. Оплату и доставку согласуйте с магазином."
    : "Бот помогает открыть магазин, заказы и партнёрский кабинет.";
  if (command === "/catalog") {
    text = native
      ? partner ? "Выберите часы для покупателя. В каталоге указана ваша цена; цену продажи вы укажете при оформлении заказа."
        : "Посмотрите часы, цены и наличие в каталоге. По вопросам покупки и доставки напишите в поддержку магазина."
      : partner ? "Партнёрский каталог в приложении." : "Каталог магазина в приложении.";
    keyboard = [[button(partner ? "Просмотреть каталог" : native ? "Выбрать часы" : "Открыть магазин", partner && native ? "/shop?mode=partner" : "/shop")], ...supportMenu];
  }
  if (command === "/orders") {
    text = native
      ? partner ? "Здесь ваши оформленные заказы и покупки клиентов по вашим ссылкам. Данные получателей доступны только в заказах, оформленных вами."
        : "Здесь можно посмотреть заказы, которые вы ранее оформляли в этом аккаунте. Если заказ оформил ваш продавец, уточните статус у него."
      : "История заказов в приложении.";
    keyboard = [history, ...supportMenu];
  }
  if (command === "/balance" && partner) {
    text = native ? "Здесь ваш ожидаемый заработок и суммы, доступные к выплате. Откройте начисления, чтобы проверить состояние заработка по заказам."
      : "Доходы и история начислений в приложении.";
    keyboard = [[button(native ? "Заработок" : "Доходы", "/partner/earnings")], ...supportMenu];
  }
  if (command === "/balance" && !partner) {
    text = native ? "Этот раздел для партнёров, которые продают часы своим покупателям. Если вы выбираете часы для себя, откройте каталог. Условия сотрудничества доступны по кнопке «Продавать с нами»."
      : "Доходы и выплаты доступны партнёрам. Прочитайте условия программы, чтобы начать работу.";
    keyboard = [[button(native ? "Продавать с нами" : "Стать партнёром", "/partner/onboarding")],
      [button(native ? "Выбрать часы" : "Открыть магазин", "/shop")], ...supportMenu];
  }
  if (blocked) text = native
    ? "Партнёрский аккаунт заблокирован. Доступен только просмотр каталога, заказов и начислений. Новые заказы и заявки на выплату недоступны. Чтобы уточнить причину ограничения, напишите в поддержку партнёров."
    : "Партнёрский аккаунт заблокирован. Доступен только просмотр истории и каталога. Новые ссылки и заявки на выплату недоступны. Чтобы уточнить причину ограничения, напишите в поддержку.";
  if (user?.is_blocked) {
    text = "Доступ к приложению ограничен. Обратитесь в поддержку.";
    keyboard = [];
  }
  text += `\n\nПоддержка: ${config.supportContact}`;
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
