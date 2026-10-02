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
  return (body.reply_markup?.inline_keyboard ?? []).flat().map((button: any) => new URL(button.web_app.url).pathname);
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
      if (command === "/balance") expect(urls).toEqual([status ? "/partner/earnings" : "/partner/onboarding"]);
      if (command === "/start" && !status) expect(urls).toEqual(["/partner/onboarding", "/shop"]);
      if (command === "/start" && status === "ACTIVE") expect(urls).toEqual(["/partner", "/shop", "/partner/orders", "/partner/earnings", "/shop"]);
      if (status === "BLOCKED") {
        expect(body.text).toContain("Доступен только просмотр");
        expect(JSON.stringify(body.reply_markup)).not.toMatch(/Стать партнёром|Партнёрский каталог|Открыть магазин/);
      }
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0]![0]).toContain("bot_can_message = true");
    expect(query.mock.calls.filter(([sql]) => sql.includes("LEFT JOIN partners"))).toHaveLength(5);
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
    const setup = readFileSync(new URL("./configure.ts", import.meta.url), "utf8");
    for (const command of commands) expect(setup).toContain(`command: "${command.slice(1)}"`);
  });
});
