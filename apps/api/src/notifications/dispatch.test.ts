import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { dispatchEvent, BlockedError } from "./dispatch.js";
import type { OutboxEvent } from "./outbox.js";
import { existsSync, readFileSync } from "node:fs";

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

const config = { appBaseUrl: "https://app.example", supportContact: "@support", botUsername: "watch_bot", adminTelegramIds: new Set(["111", "222"]) };

function event(type: string, payload: Record<string, unknown>): OutboxEvent {
  return { id: "e1", type, aggregateType: "Test", aggregateId: "a1", dedupeKey: "d1", payload, attempts: 1, leaseExpiresAt: new Date() };
}

describe("dispatchEvent", () => {
  it.each(["ORDER_CREATED", "INVENTORY_SYNC_FAILED", "PAYOUT_REQUESTED"])("binds runtime Admin IDs for %s", async (type) => {
    const pool = new MockPool();
    pool.setBySql("SELECT public_number, total_minor, currency FROM orders WHERE id = $1", [{ public_number: "W-T43", total_minor: 100, currency: "BYN" }]);
    pool.setBySql("SELECT currency FROM payouts WHERE id=$1", [{ currency: "BYN" }]);
    pool.setBySql(`SELECT title_snapshot, quantity, partner_commission_unit_snapshot_minor FROM order_items
     WHERE order_id = $1 ORDER BY id`, [{ title_snapshot: "Watch", quantity: 1, partner_commission_unit_snapshot_minor: 10 }]);
    await dispatchEvent(pool as unknown as Pool, event(type, { orderId: "order", runId: "run", payoutId: "payout", partnerId: "partner", amountMinor: 100, status: "REQUESTED" }),
      { ...config, adminTelegramIds: new Set(["9007199254740993"]) }, vi.fn());
    const selection = pool.queries.find((query) => query.sql.includes("is_admin = true"));
    expect(selection?.params).toEqual([["9007199254740993"]]);
    expect(selection?.sql).toContain("telegram_user_id = ANY($1::bigint[])");
    expect(selection?.sql).toContain("is_blocked = false AND bot_can_message = true");
  });
  it("every generated notification path has a web flow; order identities match API expectations", async () => {
    const orderId = "00000000-0000-4000-8000-000000000040";
    const pool = { query: async (sql: string) => ({ rows: sql.includes("FROM order_items")
      ? [{ title_snapshot: "Watch", quantity: 1, partner_commission_unit_snapshot_minor: 100 }]
      : sql.includes("SELECT public_number") ? [{ public_number: "W-T40", total_minor: 1000, currency: "BYN" }]
      : sql.includes("SELECT currency") ? [{ currency: "BYN" }]
      : [{ id: "admin", user_id: "user", telegram_user_id: "111" }] }) } as unknown as Pool;
    const send = vi.fn().mockResolvedValue(undefined);
    for (const type of ["PARTNER_ACTIVATED", "ORDER_CREATED", "ORDER_STATUS_CHANGED", "ORDER_CANCELLED", "ORDER_DELIVERY_FAILED", "COMMISSION_EARNED", "RETURN_COMPLETED", "INVENTORY_SYNC_FAILED", "PAYOUT_REQUESTED", "PAYOUT_PAID", "PAYOUT_REJECTED"]) {
      await dispatchEvent(pool, event(type, { orderId, publicNumber: "W-T40", partnerId: "partner", partnerIdSnapshot: "partner", toStatus: "SHIPPED", runId: "run", payoutId: "payout", amountMinor: 100, commissionReversalMinor: 100, status: type === "PAYOUT_PAID" ? "PAID" : type === "PAYOUT_REJECTED" ? "REJECTED" : "REQUESTED" }), config, send);
    }
    const paths = new Set(send.mock.calls.flatMap(([, message]) => (String(message).match(/https:\/\/app\.example[^\s]+/g) ?? []).map((url) => new URL(url).pathname)));
    const expected: Record<string, [string, string]> = {
      "/orders/W-T40": ["orders/[publicNumber]/page.tsx", 'screen="orders" publicNumber={publicNumber}'],
      "/partner/orders/W-T40": ["partner/orders/[publicNumber]/page.tsx", 'screen="partnerOrders" publicNumber={publicNumber}'],
      [`/admin/orders/${orderId}`]: ["admin/orders/[id]/page.tsx", 'orderId={id}'],
      "/partner": ["partner/page.tsx", 'screen="partner"'],
      "/partner/payouts": ["partner/payouts/page.tsx", 'screen="payouts"'],
      "/admin/payouts": ["admin/payouts/page.tsx", 'screen="adminPayouts"'],
      "/admin/inventory": ["admin/inventory/page.tsx", 'screen="adminInventory"']
    };
    expect([...paths].sort()).toEqual(Object.keys(expected).sort());
    for (const path of paths) {
      const [file, binding] = expected[path]!;
      const url = new URL(`../../../web/src/app/${file}`, import.meta.url);
      expect(existsSync(url), path).toBe(true);
      expect(readFileSync(url, "utf8"), path).toContain(binding);
    }
    const adminClient = readFileSync(new URL("../../../web/src/app/admin-orders-client.tsx", import.meta.url), "utf8");
    expect(adminClient).toContain("/api/v1/admin/orders/${encodeURIComponent(orderId)}");
    const api = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(api).toContain('app.get("/api/v1/admin/orders/:id"');
    expect(api).toContain('app.get("/api/v1/orders/:publicNumber"');
    expect(api).toContain('app.get("/api/v1/partner/orders/:publicNumber"');
    const bootstrap = readFileSync(new URL("../../../web/src/app/mini-app-bootstrap.tsx", import.meta.url), "utf8");
    expect(bootstrap).toContain('screen === "orders"');
    expect(bootstrap).toContain('screen === "partnerOrders"');
    expect(bootstrap).toContain('publicNumber={publicNumber}');
    const ordersClient = readFileSync(new URL("../../../web/src/app/orders-client.tsx", import.meta.url), "utf8");
    expect(ordersClient).toContain('partner ? "/partner/orders" : "/orders"');
    expect(ordersClient).toContain('${base}/${encodeURIComponent(publicNumber)}');
    expect(ordersClient).toContain('fetch(`/api/v1${path}`');
    for (const [file, endpoint] of [
      ["payouts-client.tsx", "/api/v1/partner/payouts"],
      ["payouts-client.tsx", "/api/v1/admin/payouts"],
      ["admin-inventory-client.tsx", "/api/v1/admin/inventory"],
      ["partner-client.tsx", "/api/v1/partner/orders"],
      ["earnings-client.tsx", "/api/v1/partner/earnings"]
    ]) {
      expect(readFileSync(new URL(`../../../web/src/app/${file}`, import.meta.url), "utf8")).toContain(endpoint);
    }
  });
  it.each([["PAID","выплачена"],["REJECTED","отклонена"]])("notifies Partner of terminal payout %s without sending another Admin request", async (status,label) => {
    const pool = new MockPool();
    pool.setBySql("SELECT currency FROM payouts WHERE id=$1", [{ currency: "BYN" }]);
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1",telegram_user_id: "111" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchEvent(pool as unknown as Pool,event(`PAYOUT_${status}`,{ v: 1,payoutId: "payout",partnerId: "partner",amountMinor: 5000,status }),config,send);
    expect(send).toHaveBeenCalledExactlyOnceWith("111",expect.stringContaining(`50.00 BYN ${label}`));
    expect(send).toHaveBeenCalledWith("111",expect.stringContaining("/partner/payouts"));
    expect(pool.queries.some((query) => query.sql.includes("is_admin = true"))).toBe(false);
  });
  it("formats PAYOUT_REQUESTED using the payout currency rather than loading an Order", async () => {
    const pool = new MockPool();
    pool.setBySql("SELECT currency FROM payouts WHERE id=$1", [{ currency: "BYN" }]);
    pool.setBySql("SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id\n     FROM partners p JOIN users u ON u.id = p.user_id\n     WHERE p.id = $1 AND u.bot_can_message = true", [{ user_id: "u1",telegram_user_id: "111" }]);
    pool.setBySql("SELECT id, telegram_user_id::text AS telegram_user_id FROM users WHERE telegram_user_id = ANY($1::bigint[]) AND is_admin = true AND is_blocked = false AND bot_can_message = true", [{ id: "u2",telegram_user_id: "222" }]);
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
    pool.setBySql("SELECT id, telegram_user_id::text AS telegram_user_id FROM users WHERE telegram_user_id = ANY($1::bigint[]) AND is_admin = true AND is_blocked = false AND bot_can_message = true", [{ id: "u2", telegram_user_id: "222" }]);
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
    pool.setBySql("SELECT id, telegram_user_id::text AS telegram_user_id FROM users WHERE telegram_user_id = ANY($1::bigint[]) AND is_admin = true AND is_blocked = false AND bot_can_message = true", [{ id: "u2", telegram_user_id: "222" }]);
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
