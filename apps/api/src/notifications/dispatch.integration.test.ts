import { randomUUID, randomInt } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dispatchEvent, BlockedError } from "./dispatch.js";
import type { OutboxEvent } from "./outbox.js";
import { dropshipFixture, disposableUrl } from "../../test/dropship-fixture.js";

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
    expect(send).toHaveBeenCalledExactlyOnceWith(telegramIds[0], expect.stringContaining("Не удалось обновить остатки"));
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

describe.skipIf(!disposableUrl())("Native order status notifications against disposable PostgreSQL", () => {
  it("sends CONFIRMED, SHIPPED and DELIVERED only to the owning Partner with a Partner link and no recipient PII", async () => {
    const fixture = await dropshipFixture(2, "160.00", true);
    try {
      const { service, owners, request, orders, pool } = fixture;
      const owner = owners[0]!;
      await pool.query("UPDATE users SET bot_can_message=true WHERE id=$1", [owner.user]);
      const checkout = await service.checkout(owner.user, "native-status", request(14500));
      const config = { appBaseUrl: "https://app.example", supportContact: "@support", botUsername: "watch_bot", adminTelegramIds: new Set<string>() };
      const sent: { chatId: string; text: string }[] = [];
      const send = async (chatId: string, text: string) => { sent.push({ chatId, text }); };

      for (const status of ["CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED"] as const) {
        await orders.transition(checkout.order.id, owners[2]!.user, status);
        if (status === "FULFILLING") continue;
        const row = (await pool.query<OutboxEvent>("SELECT id,type,aggregate_type AS \"aggregateType\",aggregate_id AS \"aggregateId\",dedupe_key AS \"dedupeKey\",payload,attempts,lease_expires_at AS \"leaseExpiresAt\" FROM events WHERE dedupe_key=$1", [`order:${checkout.order.id}:status:${status}`])).rows[0]!;
        await dispatchEvent(pool, row, config, send);
      }

      expect(sent).toHaveLength(3);
      for (const { chatId, text } of sent) {
        expect(chatId).toBe("1");
        expect(text).toContain(`/partner/orders/${checkout.order.publicNumber}`);
        expect(text).not.toContain("Тестовый получатель");
        expect(text).not.toContain("123-45-67");
        expect(text).not.toContain("адрес");
      }
      expect((await pool.query("SELECT buyer_user_id FROM orders WHERE id=$1", [checkout.order.id])).rows[0].buyer_user_id).toBeNull();
      expect((await pool.query("SELECT dedupe_key FROM events WHERE aggregate_id=$1 AND type='ORDER_STATUS_CHANGED' ORDER BY dedupe_key", [checkout.order.id])).rows.map((row) => row.dedupe_key))
        .toEqual([`order:${checkout.order.id}:status:CONFIRMED`, `order:${checkout.order.id}:status:DELIVERED`, `order:${checkout.order.id}:status:FULFILLING`, `order:${checkout.order.id}:status:SHIPPED`]);
    } finally {
      await fixture.close();
    }
  });
});
