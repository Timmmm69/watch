import { randomInt } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { processTelegramUpdate } from "./bot.js";

const pool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
const telegramId = randomInt(1_000_000_000, 9_000_000_000);
const config = { token: "123:test", appBaseUrl: "https://app.example", supportContact: "@support" };
const message = (text: string) => ({ message: { chat: { id: telegramId, type: "private" },
  from: { id: telegramId, first_name: "T43" }, text } });
afterAll(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM partners WHERE user_id IN (SELECT id FROM users WHERE telegram_user_id=$1)", [String(telegramId)]);
  await pool.query("DELETE FROM users WHERE telegram_user_id=$1", [String(telegramId)]);
  await pool.end();
});

describe.skipIf(!pool)("Bot navigation against PostgreSQL", () => {
  it("persists /start capability and changes menus with current Partner/User state", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await processTelegramUpdate(pool!, message("/start"), config, send);
    expect(JSON.stringify(send.mock.calls.at(-1)![1])).toContain("/partner/onboarding");
    const user = (await pool!.query("SELECT id, bot_can_message FROM users WHERE telegram_user_id=$1", [String(telegramId)])).rows[0];
    expect(user.bot_can_message).toBe(true);
    await pool!.query("INSERT INTO partners (id, user_id) VALUES (gen_random_uuid(), $1)", [user.id]);
    await processTelegramUpdate(pool!, message("/orders"), config, send);
    expect(JSON.stringify(send.mock.calls.at(-1)![1])).toContain("/partner/orders");
    await pool!.query("UPDATE partners SET status='BLOCKED', block_reason='T43', blocked_at=now() WHERE user_id=$1", [user.id]);
    await processTelegramUpdate(pool!, message("/start"), config, send);
    const blockedMenu = send.mock.calls.at(-1)![1];
    expect(blockedMenu.text).toContain("Доступен только просмотр");
    expect(JSON.stringify(blockedMenu.reply_markup)).not.toContain("/shop");
    await pool!.query("UPDATE users SET is_blocked=true WHERE id=$1", [user.id]);
    await processTelegramUpdate(pool!, message("/balance"), config, send);
    expect(send.mock.calls.at(-1)![1].reply_markup).toBeUndefined();
  });
});
