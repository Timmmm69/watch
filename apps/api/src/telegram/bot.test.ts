import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { processTelegramUpdate } from "./bot.js";

const config = { token: "123:test", appBaseUrl: "https://app.example", supportContact: "@support" };

describe("Telegram bot commands", () => {
  it("records private /start capability and sends a Mini App launch button", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_blocked: false }] });
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, { message: {
      chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Ada" }, text: "/start"
    } }, config, send);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("bot_can_message = true");
    expect(send.mock.calls[0]?.[1]).toMatchObject({ chat_id: 42,
      reply_markup: { inline_keyboard: [[{ web_app: { url: "https://app.example" } }]] } });
  });

  it("shows support on /help and ignores non-private messages", async () => {
    const query = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate({ query } as unknown as Pool, { message: {
      chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Ada" }, text: "/help"
    } }, config, send);
    expect(query).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1].text).toContain("@support");
    await processTelegramUpdate({ query } as unknown as Pool, { message: {
      chat: { id: -42, type: "group" }, from: { id: 42, first_name: "Ada" }, text: "/start"
    } }, config, send);
    expect(send).toHaveBeenCalledOnce();
  });
});
