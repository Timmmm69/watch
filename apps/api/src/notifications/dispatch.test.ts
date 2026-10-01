import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { dispatchEvent, BlockedError } from "./dispatch.js";
import type { OutboxEvent } from "./outbox.js";

class MockPool {
  queries: { sql: string; params: unknown[] }[] = [];
  responses: Map<string, unknown> = new Map();

  query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params: params ?? [] });
    const key = this.key(sql, params ?? []);
    const response = this.responses.get(key) ?? this.responses.get(sql) ?? { rows: [] };
    return Promise.resolve(response as { rows: unknown[] });
  }

  key(sql: string, params: unknown[]) {
    return `${sql}|${JSON.stringify(params)}`;
  }

  set(sql: string, params: unknown[], rows: unknown[]) {
    this.responses.set(this.key(sql, params), { rows });
  }

  setBySql(sql: string, rows: unknown[]) {
    this.responses.set(sql, { rows });
  }
}

const config = { appBaseUrl: "https://app.example", supportContact: "@support", botUsername: "watch_bot" };

function event(type: string, payload: Record<string, unknown>): OutboxEvent {
  return { id: "e1", type, aggregateType: "Test", aggregateId: "a1", dedupeKey: "d1", payload, attempts: 1, leaseExpiresAt: new Date() };
}

describe("dispatchEvent", () => {
  it("formats PAYOUT_REQUESTED using the payout currency rather than loading an Order", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT currency FROM payouts WHERE id=$1", [{ currency: "BYN" }]);
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1",telegram_user_id: "111" }]);
    pool.setBySql("SELECT id, telegram_user_id::text AS telegram_user_id FROM users WHERE is_admin = true AND bot_can_message = true", [{ id: "u2",telegram_user_id: "222" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool,event("PAYOUT_REQUESTED",{ payoutId: "payout",partnerId: "partner",amountMinor: 5000,status: "REQUESTED" }),config,send);
    expect(send).toHaveBeenCalledWith("111",expect.stringContaining("50.00 BYN"));
    expect(send).toHaveBeenCalledWith("222",expect.stringContaining("50.00 BYN"));
    expect(pool.queries.some((q) => q.sql.includes("FROM orders"))).toBe(false);
  });
  it("notifies partner on PARTNER_ACTIVATED", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1", telegram_user_id: "111" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool, event("PARTNER_ACTIVATED", { partnerId: "p1" }), config, send);
    expect(send).toHaveBeenCalledWith("111", expect.stringContaining("Поздравляем"));
  });

  it("notifies partner and admin on ORDER_CREATED", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT public_number, total_minor, currency FROM orders WHERE id = $1", [{ public_number: "W-ABC", total_minor: 1000, currency: "BYN" }]);
    pool.setBySql(`SELECT title_snapshot, quantity, partner_commission_unit_snapshot_minor FROM order_items\n     WHERE order_id = $1 ORDER BY id`, [{ title_snapshot: "Watch", quantity: 1, partner_commission_unit_snapshot_minor: 100 }]);
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1", telegram_user_id: "111" }]);
    pool.setBySql("SELECT id, telegram_user_id::text AS telegram_user_id FROM users WHERE is_admin = true AND bot_can_message = true", [{ id: "u2", telegram_user_id: "222" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool, event("ORDER_CREATED", { orderId: "o1", publicNumber: "W-ABC", partnerIdSnapshot: "p1", commissionEligibleSnapshot: true }), config, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith("111", expect.stringContaining("Новый заказ W-ABC"));
    expect(send).toHaveBeenCalledWith("222", expect.stringContaining("Новый заказ W-ABC"));
  });

  it.each(["CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED", "DELIVERY_FAILED"])("notifies buyer on ORDER_STATUS_CHANGED to %s", async (toStatus) => {
    const pool = new MockPool();
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM orders o JOIN users u ON u.id = o.buyer_user_id\n     WHERE o.id = $1 AND u.bot_can_message = true", [{ user_id: "u1", telegram_user_id: "111" }]);
    pool.setBySql("SELECT public_number, total_minor, currency FROM orders WHERE id = $1", [{ public_number: "W-ABC", total_minor: 1000, currency: "BYN" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool, event("ORDER_STATUS_CHANGED", { orderId: "o1", publicNumber: "W-ABC", fromStatus: "PLACED", toStatus }), config, send);
    expect(send).toHaveBeenCalledWith("111", expect.stringContaining(toStatus === "CONFIRMED" ? "подтверждён" : toStatus === "SHIPPED" ? "отправлен" : toStatus === "DELIVERED" ? "доставлен" : toStatus === "CANCELLED" ? "отменён" : "не доставлен"));
  });

  it("does not notify buyer on FULFILLING ORDER_STATUS_CHANGED", async () => {
    const pool = new MockPool();
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool, event("ORDER_STATUS_CHANGED", { orderId: "o1", toStatus: "FULFILLING" }), config, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("notifies partner on ORDER_CANCELLED with commission impact", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT public_number, total_minor, currency FROM orders WHERE id = $1", [{ public_number: "W-ABC", total_minor: 1000, currency: "BYN" }]);
    pool.setBySql(`SELECT title_snapshot, quantity, partner_commission_unit_snapshot_minor FROM order_items\n     WHERE order_id = $1 ORDER BY id`, [{ title_snapshot: "Watch", quantity: 2, partner_commission_unit_snapshot_minor: 100 }]);
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1", telegram_user_id: "111" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool, event("ORDER_CANCELLED", { orderId: "o1", publicNumber: "W-ABC", partnerIdSnapshot: "p1" }), config, send);
    expect(send).toHaveBeenCalledWith("111", expect.stringContaining("2.00 BYN"));
  });

  it("notifies admins on INVENTORY_SYNC_FAILED", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT id, telegram_user_id::text AS telegram_user_id FROM users WHERE is_admin = true AND bot_can_message = true", [{ id: "u2", telegram_user_id: "222" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool, event("INVENTORY_SYNC_FAILED", { runId: "r1", providerKey: "google_sheets" }), config, send);
    expect(send).toHaveBeenCalledWith("222", expect.stringContaining("Ошибка синхронизации"));
  });

  it("sets bot_can_message=false on BlockedError and does not throw", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1", telegram_user_id: "111" }]);
    const send = vi.fn().mockRejectedValue(new BlockedError());
    await dispatchEvent(pool as unknown as Pool, event("PARTNER_ACTIVATED", { partnerId: "p1" }), config, send);
    const update = pool.queries.find((q) => q.sql.includes("UPDATE users SET bot_can_message = false"));
    expect(update?.params).toEqual(["u1"]);
  });

  it("throws when a retryable send failure occurs", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1", telegram_user_id: "111" }]);
    const send = vi.fn().mockRejectedValue(new Error("network"));
    await expect(dispatchEvent(pool as unknown as Pool, event("PARTNER_ACTIVATED", { partnerId: "p1" }), config, send)).rejects.toThrow("network");
  });
});
