import { randomUUID, randomInt } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dispatchEvent, BlockedError } from "./dispatch.js";
import type { OutboxEvent } from "./outbox.js";

const pool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
const ids: string[] = [];
const event: OutboxEvent = { id: "test-t43", type: "INVENTORY_SYNC_FAILED", aggregateType: "InventorySyncRun",
  aggregateId: "run", dedupeKey: "test-t43", payload: { runId: "run" }, attempts: 1, leaseExpiresAt: new Date() };
afterAll(async () => {
  if (!pool) return;
  if (ids.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids]);
  await pool.end();
});

describe.skipIf(!pool)("Admin notification authority against PostgreSQL", () => {
  it("requires runtime membership, DB mirror, unblocked User and bot capability; revocation is immediate", async () => {
    const telegramIds: string[] = [];
    for (const [isAdmin, isBlocked, canMessage] of [[true, false, true], [true, false, true],
      [false, false, true], [true, true, true], [true, false, false]]) {
      const id = randomUUID(), telegramId = String(randomInt(1_000_000_000, 9_000_000_000));
      ids.push(id); telegramIds.push(telegramId);
      await pool!.query(`INSERT INTO users (id, telegram_user_id, first_name, is_admin, is_blocked, bot_can_message)
        VALUES ($1, $2, 'T43', $3, $4, $5)`, [id, telegramId, isAdmin, isBlocked, canMessage]);
    }
    const adminTelegramIds = new Set(telegramIds.filter((_, index) => index !== 1));
    const config = { appBaseUrl: "https://app.example", supportContact: "@support", botUsername: "watch_bot", adminTelegramIds };
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool!, event, config, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(telegramIds[0], expect.stringContaining("Ошибка синхронизации"));
    // No auth/mirror sync occurs between the config revocation and dispatch.
    adminTelegramIds.delete(telegramIds[0]!); send.mockClear();
    await dispatchEvent(pool!, event, config, send);
    expect(send).not.toHaveBeenCalled();
    adminTelegramIds.clear();
    await dispatchEvent(pool!, event, config, send);
    expect(send).not.toHaveBeenCalled();
    adminTelegramIds.add(telegramIds[0]!);
    send.mockRejectedValue(new BlockedError());
    await dispatchEvent(pool!, event, config, send);
    expect((await pool!.query("SELECT bot_can_message FROM users WHERE id=$1", [ids[0]])).rows[0].bot_can_message).toBe(false);
    send.mockClear();
    await dispatchEvent(pool!, event, config, send);
    expect(send).not.toHaveBeenCalled();
  });
});
