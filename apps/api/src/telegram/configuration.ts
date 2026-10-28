// These operations run only from the explicit telegram:configure command.
// Telegram limits: https://core.telegram.org/bots/api#setmydescription (512),
// https://core.telegram.org/bots/api#setmyshortdescription (120).
export const botDescription = "Выбирайте часы в каталоге и обращайтесь в магазин по вопросам покупки и доставки.\n\nПродаёте часы своим покупателям? Подключайтесь как партнёр: оформляйте заказы, следите за заработком и запрашивайте выплаты.";
export const botShortDescription = "Каталог часов и связь с магазином. Для партнёров — заказы, заработок и выплаты.";

export function botConfiguration(appBaseUrl: string, webhookSecret: string) {
  const appUrl = new URL(appBaseUrl);
  if (appUrl.protocol !== "https:") throw new Error("APP_BASE_URL must use HTTPS for Telegram setup");
  if ([...botDescription].length > 512 || [...botShortDescription].length > 120) throw new Error("Bot description exceeds Telegram limits");
  return [
    { method: "setMyDescription", body: { description: botDescription } },
    { method: "setMyShortDescription", body: { short_description: botShortDescription } },
    { method: "setMyCommands", body: { commands: [
      { command: "start", description: "Открыть приложение" }, { command: "help", description: "Помощь" },
      { command: "catalog", description: "Выбрать часы" }, { command: "orders", description: "Заказы" }, { command: "balance", description: "Заработок" }
    ] } },
    { method: "setChatMenuButton", body: { menu_button: { type: "web_app", text: "Открыть приложение", web_app: { url: appUrl.toString() } } } },
    { method: "setWebhook", body: { url: new URL("/api/v1/telegram/webhook", appUrl).toString(), secret_token: webhookSecret, allowed_updates: ["message"] } }
  ];
}
