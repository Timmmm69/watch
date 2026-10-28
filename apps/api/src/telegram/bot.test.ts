import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { existsSync, readFileSync } from "node:fs";
import { processTelegramUpdate } from "./bot.js";

const config = { token: "123:test", appBaseUrl: "https://app.example", supportContact: "@support" };
const commands = ["/start", "/help", "/catalog", "/orders", "/balance"];
function message(text: string, type = "private") {
  return { message: { chat: { id: 42, type }, from: { id: 42, first_name: "Ada" }, text } };
}
function paths(body: any): string[] {
  return (body.reply_markup?.inline_keyboard ?? []).flat().filter((button: any) => button.web_app)
    .map((button: any) => new URL(button.web_app.url).pathname);
}

describe("Telegram bot commands", () => {
  it.each([null, "ACTIVE", "BLOCKED"])("routes all five commands using current Partner state %s", async (status) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false, partner_status: status }] });
    const send = vi.fn().mockResolvedValue(undefined);
    for (const command of commands) {
      await processTelegramUpdate({ query } as unknown as Pool, message(command + "@watch_bot"), config, send);
      const body = send.mock.calls.at(-1)![1];
      const urls = paths(body);
      expect(body.text).toContain("@support");
      for (const path of urls) {
        expect(existsSync(new URL(`../../../web/src/app${path}/page.tsx`, import.meta.url)), path).toBe(true);
      }
      if (command === "/orders") expect(urls).toEqual([status ? "/partner/orders" : "/orders"]);
      if (command === "/catalog") expect(urls).toEqual(["/shop"]);
      if (command === "/balance") expect(urls).toEqual(status ? ["/partner/earnings"] : ["/partner/onboarding", "/shop"]);
      if (command === "/start" && !status) expect(urls).toEqual(["/shop", "/cart", "/orders", "/partner/onboarding"]);
      if (command === "/start" && status === "ACTIVE") expect(urls).toEqual(["/partner", "/shop", "/partner/orders", "/partner/earnings", "/partner/payouts"]);
      if (status === "BLOCKED") {
        expect(body.text).toContain("Доступен только просмотр");
        expect(JSON.stringify(body.reply_markup)).not.toMatch(/Стать партнёром|Партнёрский каталог|Открыть магазин/);
      }
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0]![0]).toContain("bot_can_message = true");
    expect(query.mock.calls.filter(([sql]) => sql.includes("LEFT JOIN partners"))).toHaveLength(5);
  });

  it.each([null, "ACTIVE"])("explains native commerce without offering a retail cart for %s", async (status) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false, partner_status: status }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message("/start"), { ...config, nativeCommerce: true }, send);
    const body = send.mock.calls[0]![1];
    expect(paths(body)).not.toContain("/cart");
    expect(body.text).not.toMatch(/комисси|ссылк/);
    expect(body.text).toContain(status ? "данные получателя" : "покупки и доставки");
  });

  it.each(["/start", "/help", "/catalog"])("keeps native buyer copy about buying watches for %s", async (command) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false, partner_status: null }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message(command), { ...config, nativeCommerce: true }, send);
    const body = send.mock.calls[0]![1];
    expect(body.text).toMatch(/часы/);
    expect(body.text).not.toMatch(/партнёр|наценк|начислен|комисси|цену продажи|данные получателя/);
    expect(paths(body)).not.toContain("/cart");
    expect(paths(body)).not.toContain("/partner");
    expect(body.reply_markup.inline_keyboard.flat()).toContainEqual({ text: "Связаться с магазином", url: "https://t.me/support" });
    if (command !== "/catalog") {
      expect(body.reply_markup.inline_keyboard.at(-1)).toEqual([
        { text: "Продавать с нами", web_app: { url: "https://app.example/partner/onboarding" } }
      ]);
    }
  });

  it.each(commands)("does not tell a blocked native partner to create orders for %s", async (command) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false, partner_status: "BLOCKED" }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message(command), { ...config, nativeCommerce: true }, send);
    const body = send.mock.calls[0]![1];
    expect(body.text).toContain("Новые заказы и заявки на выплату недоступны");
    expect(body.text).toContain("@support");
    expect(body.text).not.toMatch(/укажите|оформляйте|цену продажи|новые ссылки|делитесь/iu);
    expect(paths(body)).not.toContain("/partner/onboarding");
    expect(paths(body)).not.toContain("/partner/payouts");
  });

  it.each(commands)("keeps native active partner navigation in the partner account for %s", async (command) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false, partner_status: "ACTIVE" }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message(command), { ...config, nativeCommerce: true }, send);
    const body = send.mock.calls[0]![1];
    expect(paths(body)).not.toContain("/partner/onboarding");
    expect(paths(body)).not.toContain("/cart");
    expect(paths(body)).not.toContain("/orders");
    expect(body.reply_markup.inline_keyboard.flat()).toContainEqual({ text: "Поддержка партнёров", url: "https://t.me/support" });
    if (command === "/orders") expect(paths(body)).toEqual(["/partner/orders"]);
    if (command === "/balance") expect(paths(body)).toEqual(["/partner/earnings"]);
  });

  it.each(commands)("overrides native partner menus when the whole user is blocked for %s", async (command) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: true, partner_status: "ACTIVE" }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message(command), { ...config, nativeCommerce: true }, send);
    const body = send.mock.calls[0]![1];
    expect(body.reply_markup).toBeUndefined();
    expect(body.text).toContain("Доступ к приложению ограничен");
    expect(body.text).not.toMatch(/оформляйте|цену продажи|данные получателя/iu);
  });

  it("switches native copy after activation and blocking without requiring a new start", async () => {
    const query = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    for (const status of [null, "ACTIVE", "BLOCKED"]) {
      query.mockResolvedValueOnce({ rows: [{ is_blocked: false, partner_status: status }] });
      await processTelegramUpdate({ query } as unknown as Pool, message("/help"), { ...config, nativeCommerce: true }, send);
    }
    expect(send.mock.calls[0]![1].text).not.toMatch(/партнёр|заработок/);
    expect(send.mock.calls[1]![1].text).toContain("заказ для покупателя");
    expect(paths(send.mock.calls[1]![1])).toContain("/partner/payouts");
    expect(send.mock.calls[2]![1].text).toContain("заблокирован");
    expect(paths(send.mock.calls[2]![1])).not.toContain("/shop");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("explains buyer order ownership instead of promising the seller's order history", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false, partner_status: null }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message("/orders"), { ...config, nativeCommerce: true }, send);
    const body = send.mock.calls[0]![1];
    expect(body.text).toContain("ранее оформляли в этом аккаунте");
    expect(body.text).toContain("Если заказ оформил ваш продавец");
    expect(paths(body)).toEqual(["/orders"]);
  });

  it.each(["@support", "https://shop.example/help", "Телефон магазина", "javascript:alert(1)"])("uses actionable native support contacts safely: %s", async (supportContact) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false, partner_status: null }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message("/start"), { ...config, nativeCommerce: true, supportContact }, send);
    const body = send.mock.calls[0]![1];
    const links = body.reply_markup.inline_keyboard.flat().filter((button: any) => button.url);
    expect(links.map((button: any) => button.url)).toEqual(supportContact === "@support" ? ["https://t.me/support"]
      : supportContact.startsWith("https:") ? [supportContact] : []);
    expect(body.text).toContain(supportContact);
  });

  it("re-reads state after Partner becomes BLOCKED", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ partner_status: "ACTIVE" }] })
      .mockResolvedValueOnce({ rows: [{ partner_status: "BLOCKED" }] });
    const send = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < 2; i++) await processTelegramUpdate({ query } as unknown as Pool, message("/help"), config, send);
    expect(paths(send.mock.calls[0]![1])).toContain("/shop");
    expect(paths(send.mock.calls[1]![1])).not.toContain("/shop");
  });

  it.each(commands)("globally blocked User receives no app buttons for %s", async (command) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: true, partner_status: "ACTIVE" }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, message(command), config, send);
    expect(paths(send.mock.calls[0]![1])).toEqual([]);
    expect(send.mock.calls[0]![1].text).toContain("@support");
    expect(send.mock.calls[0]![1].text).toContain("Доступ к приложению ограничен");
  });

  it.each(commands)("ignores group command %s", async (command) => {
    const query = vi.fn(), send = vi.fn();
    await processTelegramUpdate({ query } as unknown as Pool, message(command, "group"), config, send);
    expect(query).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("clears messaging capability when recipient blocks bot", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const send = vi.fn().mockRejectedValue(new Error("Telegram sendMessage blocked"));
    await processTelegramUpdate({ query } as unknown as Pool, message("/help"), config, send);
    expect(query).toHaveBeenLastCalledWith("UPDATE users SET bot_can_message = false WHERE telegram_user_id = $1", ["42"]);
  });

  it("keeps transient send errors retryable", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(processTelegramUpdate({ query } as unknown as Pool, message("/help"), config,
      vi.fn().mockRejectedValue(new Error("network")))).rejects.toThrow("network");
  });

  it("registers all navigation commands in Telegram setup", () => {
    const setup = readFileSync(new URL("./configuration.ts", import.meta.url), "utf8");
    for (const command of commands) expect(setup).toContain(`command: "${command.slice(1)}"`);
  });
});
