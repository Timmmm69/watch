import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminReturnService } from "./returns.js";
import { CheckoutService } from "../orders/checkout.js";
import { AdminOrderService } from "../orders/admin.js";
import { OrderCompletionWorker } from "../orders/completion.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `returns_test_${randomUUID().replaceAll("-", "")}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema},public` }) : null;
const admin = randomUUID(), supplier = randomUUID(), product = randomUUID();
const organicVariant = randomUUID(), attributedVariant = randomUUID();
const partnerUser = randomUUID(), partner = randomUUID();
const docs = { SALES_TERMS: { id: randomUUID(), version: "t31-sales" }, PRIVACY: { id: randomUUID(), version: "t31-privacy" },
  PARTNER_TERMS: { id: randomUUID(), version: "t31-partner" } };
const currency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";
let service: AdminReturnService;
let checkout: CheckoutService;

function request(variantId: string, quantity = 1) {
  return { items: [{ variantId, quantity, expectedUnitPriceMinor: 1000 }], recipientName: "Private Buyer",
    phone: "375291234567", address: "Private Address", comment: "Private Comment",
    salesTermsDocumentId: docs.SALES_TERMS.id, privacyDocumentId: docs.PRIVACY.id,
    salesTermsAccepted: true, privacyAcknowledged: true };
}
async function placeOrder(buyerId: string, attributed: boolean, quantity = 1, variantOverride?: string): Promise<{ id: string; itemId: string }> {
  const variantId = variantOverride ?? (attributed ? attributedVariant : organicVariant);
  await pool!.query("DELETE FROM carts WHERE buyer_user_id=$1", [buyerId]);
  const cart = randomUUID();
  await pool!.query("INSERT INTO carts (id,buyer_user_id) VALUES ($1,$2)", [cart, buyerId]);
  await pool!.query("INSERT INTO cart_items (cart_id,variant_id,quantity) VALUES ($1,$2,$3)", [cart, variantId, quantity]);
  if (attributed) {
    await pool!.query(`INSERT INTO attribution_touches (id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,expires_at)
      VALUES ($1,$2,$3,$4,$5,now()+interval '30 days')`,
    [randomUUID(), buyerId, partner, randomUUID(), randomBytes(32).toString("hex")]);
  }
  const order = (await checkout.checkout(buyerId, randomUUID(), request(variantId, quantity))).order;
  return { id: order.id, itemId: (await pool!.query("SELECT id FROM order_items WHERE order_id=$1", [order.id])).rows[0].id };
}
async function deliver(orderId: string) {
  const transitions = new AdminOrderService(pool!, 0);
  for (const target of ["CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED"] as const)
    await transitions.transition(orderId, admin, target);
}
async function counts() {
  return (await pool!.query(`SELECT (SELECT count(*)::int FROM returns) AS returns,(SELECT count(*)::int FROM return_items) AS items,
    (SELECT count(*)::int FROM audit_logs) AS audits`)).rows[0];
}
async function setStatus(orderId: string, status: string) {
  await pool!.query("UPDATE orders SET status=$2 WHERE id=$1", [orderId, status]);
}

async function finance(orderId: string) {
  const commissions = (await pool!.query(`SELECT c.state,c.gross_amount_minor,c.reversed_amount_minor,
    -COALESCE((SELECT SUM(amount_minor)::int FROM ledger_entries WHERE commission_id=c.id AND entry_type='COMMISSION_REVERSAL'),0) AS ledger_reversed
    FROM commissions c WHERE order_id=$1 ORDER BY c.id`, [orderId])).rows;
  for (const commission of commissions) expect(commission.reversed_amount_minor).toBe(commission.ledger_reversed);
  return { commissions, balances: (await pool!.query(`SELECT bucket,SUM(amount_minor)::int AS amount FROM ledger_entries
    WHERE partner_id=$1 GROUP BY bucket ORDER BY bucket::text`, [partner])).rows };
}

describe.skipIf(!pool)("T32 Return completion and reversals against PostgreSQL", () => {
  it("partially reverses HOLD, releases only the remainder, then fully reverses EARNED idempotently", async () => {
    const { id, itemId } = await placeOrder(admin, true, 3);
    await deliver(id);
    const inventory = (await pool!.query("SELECT * FROM inventory_items WHERE variant_id=$1", [attributedVariant])).rows;
    const first = await service.create(admin, { orderId: id, reason: "Partial", items: [{ orderItemId: itemId, quantity: 1 }] });
    expect(await new OrderCompletionWorker(pool!).completeOrder(id)).toBe(false);
    const completed = await service.complete(first.id, admin, "t32", "Private note");
    expect(completed).toMatchObject({ status: "COMPLETED", note: "Private note" });
    expect(await finance(id)).toMatchObject({ commissions: [{ state: "HOLD", reversed_amount_minor: 100 }], balances: [{ bucket: "PENDING", amount: 200 }] });
    const before = await counts();
    expect(await service.complete(first.id, admin, "retry", "Different note")).toEqual(completed);
    expect(await counts()).toEqual(before);
    expect(await new OrderCompletionWorker(pool!).completeOrder(id)).toBe(true);
    expect(await finance(id)).toMatchObject({ commissions: [{ state: "EARNED", reversed_amount_minor: 100 }] });
    const second = await service.create(admin, { orderId: id, reason: "Remaining", items: [{ orderItemId: itemId, quantity: 2 }] });
    await service.complete(second.id, admin);
    expect(await finance(id)).toMatchObject({ commissions: [{ state: "VOID", reversed_amount_minor: 300 }], balances: [{ bucket: "AVAILABLE", amount: 0 }, { bucket: "PENDING", amount: 0 }] });
    expect((await pool!.query("SELECT * FROM inventory_items WHERE variant_id=$1", [attributedVariant])).rows).toEqual(inventory);
    const event = (await pool!.query("SELECT payload,dedupe_key FROM events WHERE aggregate_id=$1 AND type='RETURN_COMPLETED'", [first.id])).rows;
    expect(event).toEqual([{ dedupe_key: `return:${first.id}:completed`, payload: { v: 1, returnId: first.id, orderId: id, partnerIdSnapshot: partner, commissionReversalMinor: 100 } }]);
    const audit = (await pool!.query("SELECT metadata FROM audit_logs WHERE request_id='t32'")).rows[0];
    expect(audit.metadata).toEqual({ orderId: id, commissionReversalMinor: 100 });
    await expect(service.cancel(first.id, admin)).rejects.toMatchObject({ code: "RETURN_NOT_ALLOWED" });
  });

  it("fully reverses HOLD to VOID and still allows system completion", async () => {
    const { id, itemId } = await placeOrder(admin, true, 2); await deliver(id);
    const created = await service.create(admin, { orderId: id, reason: "Full", items: [{ orderItemId: itemId, quantity: 2 }] });
    await service.complete(created.id, admin);
    expect(await finance(id)).toMatchObject({ commissions: [{ state: "VOID", reversed_amount_minor: 200 }], balances: [{ bucket: "PENDING", amount: 0 }] });
    expect(await new OrderCompletionWorker(pool!).completeOrder(id)).toBe(true);
    expect((await pool!.query("SELECT * FROM ledger_entries WHERE entry_type='COMMISSION_RELEASE'")).rows).toEqual([]);
  });

  for (const paid of [false, true]) it(`creates AVAILABLE debt after a ${paid ? "paid" : "requested"} payout without rewriting history`, async () => {
    const { id, itemId } = await placeOrder(admin, true, 2); await deliver(id);
    await new OrderCompletionWorker(pool!).completeOrder(id);
    const payoutId = randomUUID();
    await pool!.query(`INSERT INTO payouts (id,partner_id,amount_minor,currency,status,idempotency_key,request_fingerprint,requested_by_user_id)
      VALUES ($1,$2,200,$3,$4,$5,$6,$7)`, [payoutId, partner, currency, paid ? "PAID" : "REQUESTED", randomUUID(), "a".repeat(64), partnerUser]);
    const group = randomUUID();
    for (const [bucket, amount, type] of [["AVAILABLE", -200, "PAYOUT_LOCK"], ["PAYOUT_LOCKED", 200, "PAYOUT_LOCK"],
      ...(paid ? [["PAYOUT_LOCKED", -200, "PAYOUT_PAID"]] : [])])
      await pool!.query(`INSERT INTO ledger_entries (id,partner_id,payout_id,bucket,amount_minor,entry_type,transaction_group_id,idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), partner, payoutId, bucket, amount, type, group, randomUUID()]);
    const history = (await pool!.query("SELECT * FROM ledger_entries WHERE payout_id=$1 ORDER BY id", [payoutId])).rows;
    const payout = (await pool!.query("SELECT * FROM payouts WHERE id=$1", [payoutId])).rows;
    const created = await service.create(admin, { orderId: id, reason: "Late", items: [{ orderItemId: itemId, quantity: 1 }] });
    await service.complete(created.id, admin);
    expect((await finance(id)).commissions).toMatchObject([{ state: "EARNED", reversed_amount_minor: 100 }]);
    expect((await finance(id)).balances).toContainEqual({ bucket: "AVAILABLE", amount: -100 });
    expect((await pool!.query("SELECT * FROM ledger_entries WHERE payout_id=$1 ORDER BY id", [payoutId])).rows).toEqual(history);
    expect((await pool!.query("SELECT * FROM payouts WHERE id=$1", [payoutId])).rows).toEqual(payout);
  });

  it("completes organic and attributed zero-unit returns without financial entries", async () => {
    for (const attributed of [false, true]) {
      const { id, itemId } = await placeOrder(admin, attributed, 1, organicVariant); await deliver(id);
      const created = await service.create(admin, { orderId: id, reason: "No commission", items: [{ orderItemId: itemId, quantity: 1 }] });
      await service.complete(created.id, admin);
      expect((await pool!.query("SELECT payload FROM events WHERE aggregate_id=$1 AND type='RETURN_COMPLETED'", [created.id])).rows[0].payload.commissionReversalMinor).toBe(0);
      expect((await finance(id)).commissions).toEqual([]);
    }
  });

  it("serializes concurrent completions and Order completion without duplicate money", async () => {
    const { id, itemId } = await placeOrder(admin, true, 2); await deliver(id);
    const created = await service.create(admin, { orderId: id, reason: "Race", items: [{ orderItemId: itemId, quantity: 1 }] });
    await Promise.all([service.complete(created.id, admin), service.complete(created.id, admin), new OrderCompletionWorker(pool!).completeOrder(id)]);
    await new OrderCompletionWorker(pool!).completeOrder(id);
    expect(await finance(id)).toMatchObject({ commissions: [{ state: "EARNED", reversed_amount_minor: 100 }], balances: [{ bucket: "AVAILABLE", amount: 100 }, { bucket: "PENDING", amount: 0 }] });
    expect((await pool!.query("SELECT count(*)::int AS count FROM ledger_entries WHERE entry_type='COMMISSION_REVERSAL'")).rows[0].count).toBe(1);
    expect((await pool!.query("SELECT count(*)::int AS count FROM events WHERE type='RETURN_COMPLETED' AND aggregate_id=$1", [created.id])).rows[0].count).toBe(1);
  });

  it("rejects cancelled/missing Returns and rechecks cumulative quantities under locks", async () => {
    await expect(service.complete(randomUUID(), admin)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { id, itemId } = await placeOrder(admin, true); await deliver(id);
    const created = await service.create(admin, { orderId: id, reason: "Cancelled", items: [{ orderItemId: itemId, quantity: 1 }] });
    await service.cancel(created.id, admin);
    await expect(service.complete(created.id, admin)).rejects.toMatchObject({ code: "RETURN_NOT_ALLOWED" });
    const next = await service.create(admin, { orderId: id, reason: "Corrupt quantity", items: [{ orderItemId: itemId, quantity: 1 }] });
    await pool!.query("UPDATE return_items SET quantity=2 WHERE return_id=$1", [next.id]);
    await expect(service.complete(next.id, admin)).rejects.toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
    expect((await service.detail(next.id)).status).toBe("OPEN");
    expect((await finance(id)).commissions[0].reversed_amount_minor).toBe(0);
  });

  it("rolls back reversal/projection/status/Event together when Audit fails, then retries once", async () => {
    const { id, itemId } = await placeOrder(admin, true); await deliver(id);
    const created = await service.create(admin, { orderId: id, reason: "Rollback", items: [{ orderItemId: itemId, quantity: 1 }] });
    await pool!.query(`CREATE FUNCTION fail_t32_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 't32 audit failure'; END $$;
      CREATE TRIGGER fail_t32_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_t32_audit()`);
    try {
      const before = await finance(id);
      await expect(service.complete(created.id, admin)).rejects.toThrow("t32 audit failure");
      expect(await finance(id)).toEqual(before);
      expect((await service.detail(created.id)).status).toBe("OPEN");
      expect((await pool!.query("SELECT * FROM events WHERE aggregate_id=$1", [created.id])).rows).toEqual([]);
    } finally { await pool!.query("DROP TRIGGER fail_t32_audit ON audit_logs; DROP FUNCTION fail_t32_audit()"); }
    await service.complete(created.id, admin);
    expect((await finance(id)).commissions[0]).toMatchObject({ state: "VOID", reversed_amount_minor: 100 });
  });

  it("serializes completion versus cancellation and competing Return creation", async () => {
    const { id, itemId } = await placeOrder(admin, true); await deliver(id);
    const created = await service.create(admin, { orderId: id, reason: "Race", items: [{ orderItemId: itemId, quantity: 1 }] });
    const results = await Promise.allSettled([service.complete(created.id, admin), service.cancel(created.id, admin)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "RETURN_NOT_ALLOWED" });
    const status = (await service.detail(created.id)).status;
    expect((await finance(id)).commissions[0].reversed_amount_minor).toBe(status === "COMPLETED" ? 100 : 0);
    if (status === "CANCELLED") {
      const next = await service.create(admin, { orderId: id, reason: "Retry", items: [{ orderItemId: itemId, quantity: 1 }] });
      await service.complete(next.id, admin);
    }
    await expect(service.create(admin, { orderId: id, reason: "Overrun", items: [{ orderItemId: itemId, quantity: 1 }] }))
      .rejects.toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
  });

  it("fails closed on a missing positive Commission", async () => {
    const { id, itemId } = await placeOrder(admin, true, 1, organicVariant); await deliver(id);
    // Simulate retained pre-S12 data without a Commission; preserve the append-only journal.
    await pool!.query("UPDATE order_items SET partner_commission_unit_snapshot_minor=100 WHERE id=$1", [itemId]);
    const corrupt = await service.create(admin, { orderId: id, reason: "Missing", items: [{ orderItemId: itemId, quantity: 1 }] });
    await expect(service.complete(corrupt.id, admin)).rejects.toMatchObject({ code: "INTERNAL_INVARIANT_VIOLATION" });
    expect((await service.detail(corrupt.id)).status).toBe("OPEN");
    expect((await finance(id)).commissions).toEqual([]);
    expect((await pool!.query("SELECT * FROM events WHERE aggregate_id=$1", [corrupt.id])).rows).toEqual([]);
  });
});

describe.skipIf(!pool)("T31 Return workflow foundation against PostgreSQL", () => {
  it("creates OPEN Returns only for DELIVERED/COMPLETED Orders with server-derived Order identity", async () => {
    const { id, itemId } = await placeOrder(admin, false);
    await expect(service.create(admin, { orderId: id, reason: "Not delivered yet", items: [{ orderItemId: itemId, quantity: 1 }] }, "request-t31"))
      .rejects.toMatchObject({ code: "RETURN_NOT_ALLOWED" });
    await expect(service.create(admin, { orderId: randomUUID(), reason: "Missing", items: [{ orderItemId: itemId, quantity: 1 }] }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const transitions = new AdminOrderService(pool!, 0);
    for (const target of ["CONFIRMED", "FULFILLING", "SHIPPED"] as const) await transitions.transition(id, admin, target);
    await expect(service.create(admin, { orderId: id, reason: "Shipped already", items: [{ orderItemId: itemId, quantity: 1 }] }))
      .rejects.toMatchObject({ code: "RETURN_NOT_ALLOWED" });
    await transitions.transition(id, admin, "DELIVERED");
    const created = await service.create(admin, { orderId: id, reason: "Damaged in transit", items: [{ orderItemId: itemId, quantity: 1 }] }, "request-t31");
    expect(created).toMatchObject({ orderId: id, status: "OPEN", reason: "Damaged in transit", currency,
      createdByAdminUserId: admin, reversalPreviewMinor: 0 });
    expect(created.orderPublicNumber).toMatch(/^W-/);
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({ orderItemId: itemId, quantity: 1, variantId: organicVariant });
    const item = (await pool!.query("SELECT * FROM return_items WHERE return_id=$1", [created.id])).rows[0];
    expect(item.order_id).toBe(id);
    const audit = (await pool!.query("SELECT * FROM audit_logs WHERE request_id='request-t31'")).rows[0];
    expect(audit).toMatchObject({ actor_user_id: admin, action: "admin.return.create", entity_id: created.id });
    expect(audit.metadata).toMatchObject({ orderId: id, items: [{ orderItemId: itemId, quantity: 1 }] });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Damaged/);
    await pool!.query("UPDATE returns SET status='CANCELLED' WHERE id=$1", [created.id]);
    await setStatus(id, "COMPLETED");
    const second = await service.create(admin, { orderId: id, reason: "Second return", items: [{ orderItemId: itemId, quantity: 1 }] });
    expect(second.status).toBe("OPEN");
  });

  it("rejects every non-DELIVERED/non-COMPLETED Order state", async () => {
    const { id, itemId } = await placeOrder(admin, false);
    for (const status of ["PLACED", "CONFIRMED", "FULFILLING", "SHIPPED", "CANCELLED", "DELIVERY_FAILED"]) {
      await setStatus(id, status);
      await expect(service.create(admin, { orderId: id, reason: "x", items: [{ orderItemId: itemId, quantity: 1 }] }))
        .rejects.toMatchObject({ code: "RETURN_NOT_ALLOWED" });
    }
    for (const status of ["DELIVERED", "COMPLETED"]) {
      await setStatus(id, status);
      const created = await service.create(admin, { orderId: id, reason: "x", items: [{ orderItemId: itemId, quantity: 1 }] });
      expect(created.status).toBe("OPEN");
      await pool!.query("UPDATE returns SET status='CANCELLED' WHERE id=$1", [created.id]);
    }
  });

  it("enforces OPEN+COMPLETED cumulative quantities and rejects unknown OrderItems", async () => {
    const { id, itemId } = await placeOrder(admin, true);
    await deliver(id);
    const first = await service.create(admin, { orderId: id, reason: "Partial", items: [{ orderItemId: itemId, quantity: 1 }] });
    expect(first.reversalPreviewMinor).toBe(100);
    const request = { orderId: id, reason: "Too much", items: [{ orderItemId: itemId, quantity: 1 }] };
    await expect(service.create(admin, request)).rejects.toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
    await pool!.query("UPDATE returns SET status='COMPLETED' WHERE id=$1", [first.id]);
    await expect(service.create(admin, request)).rejects.toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
    await pool!.query("UPDATE returns SET status='CANCELLED' WHERE id=$1", [first.id]);
    expect((await service.create(admin, request)).status).toBe("OPEN");
    await expect(service.create(admin, { orderId: id, reason: "Unknown item", items: [{ orderItemId: randomUUID(), quantity: 1 }] }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const foreign = await placeOrder(admin, false);
    await expect(service.create(admin, { orderId: id, reason: "Foreign item", items: [{ orderItemId: foreign.itemId, quantity: 1 }] }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("cancels only OPEN Returns idempotently and unblocks Order completion", async () => {
    const { id, itemId } = await placeOrder(admin, true);
    await deliver(id);
    const created = await service.create(admin, { orderId: id, reason: "Cancel me", items: [{ orderItemId: itemId, quantity: 1 }] });
    const worker = new OrderCompletionWorker(pool!);
    expect(await worker.completeOrder(id)).toBe(false);
    const cancelled = await service.cancel(created.id, admin, "request-t31");
    expect(cancelled.status).toBe("CANCELLED");
    const before = await counts();
    const replay = await service.cancel(created.id, admin, "request-t31");
    expect(replay).toEqual(cancelled);
    expect(await counts()).toEqual(before);
    expect((await pool!.query("SELECT status FROM returns WHERE id=$1", [created.id])).rows[0].status).toBe("CANCELLED");
    expect(await worker.completeOrder(id)).toBe(true);
    const completed = await service.create(admin, { orderId: id, reason: "Never", items: [{ orderItemId: itemId, quantity: 1 }] });
    await pool!.query("UPDATE returns SET status='COMPLETED' WHERE id=$1", [completed.id]);
    await expect(service.cancel(completed.id, admin)).rejects.toMatchObject({ code: "RETURN_NOT_ALLOWED" });
    await expect(service.cancel(randomUUID(), admin)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serializes concurrent creations on the Order lock and never exceeds ordered quantity", async () => {
    const { id, itemId } = await placeOrder(admin, false);
    await deliver(id);
    const request = { orderId: id, reason: "Race", items: [{ orderItemId: itemId, quantity: 1 }] };
    const results = await Promise.allSettled([service.create(admin, request), service.create(admin, request)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
    expect((await pool!.query("SELECT * FROM returns WHERE order_id=$1 AND status='OPEN'", [id])).rowCount).toBe(1);
    expect((await pool!.query("SELECT count(*)::int AS count FROM return_items")).rows[0].count).toBe(1);
  });

  it("lists summaries with filters, pagination and deterministic ordering", async () => {
    const first = await placeOrder(admin, false);
    await deliver(first.id);
    const created = await service.create(admin, { orderId: first.id, reason: "Listed", items: [{ orderItemId: first.itemId, quantity: 1 }] });
    const query = { page: 1, limit: 20 };
    expect(await service.list({ ...query, status: "OPEN" })).toMatchObject({ total: 1, items: [{ id: created.id, itemCount: 1 }] });
    expect((await service.list({ ...query, status: "OPEN" })).items[0]!.orderPublicNumber).toMatch(/^W-/);
    expect(await service.list({ ...query, status: "CANCELLED" })).toMatchObject({ total: 0, items: [] });
    expect(await service.list({ ...query, orderId: first.id })).toMatchObject({ total: 1 });
    expect(await service.list({ ...query, orderId: randomUUID() })).toMatchObject({ total: 0 });
    expect((await service.list({ page: 2, limit: 20 })).items).toHaveLength(0);
    await pool!.query("UPDATE returns SET created_at=now()-interval '1 hour' WHERE id=$1", [created.id]);
    await pool!.query("UPDATE returns SET status='CANCELLED' WHERE id=$1", [created.id]);
    const newer = await service.create(admin, { orderId: first.id, reason: "Newer", items: [{ orderItemId: first.itemId, quantity: 1 }] });
    const listed = await service.list({ ...query, limit: 1 });
    expect(listed).toMatchObject({ total: 2, items: [{ id: newer.id }] });
    await expect(service.detail(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces composite relational integrity at the database level", async () => {
    const { id, itemId } = await placeOrder(admin, false);
    await deliver(id);
    const created = await service.create(admin, { orderId: id, reason: "Integrity", items: [{ orderItemId: itemId, quantity: 1 }] });
    const other = await placeOrder(admin, false);
    const bare = randomUUID();
    await pool!.query("INSERT INTO returns (id,order_id,reason,created_by_admin_user_id) VALUES ($1,$2,'Bare',$3)", [bare, id, admin]);
    await expect(pool!.query("INSERT INTO return_items (id,return_id,order_id,order_item_id,quantity) VALUES ($1,$2,$3,$4,1)",
      [randomUUID(), bare, other.id, itemId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO return_items (id,return_id,order_id,order_item_id,quantity) VALUES ($1,$2,$3,$4,1)",
      [randomUUID(), bare, id, other.itemId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("INSERT INTO return_items (id,return_id,order_id,order_item_id,quantity) VALUES ($1,$2,$3,$4,0)",
      [randomUUID(), bare, id, itemId])).rejects.toMatchObject({ code: "23514" });
    await expect(pool!.query("INSERT INTO return_items (id,return_id,order_id,order_item_id,quantity) VALUES ($1,$2,$3,$4,1)",
      [randomUUID(), created.id, id, itemId])).rejects.toMatchObject({ code: "23505" });
  });

  it("rolls back Return and items when the AuditLog insert fails", async () => {
    const { id, itemId } = await placeOrder(admin, false);
    await deliver(id);
    await pool!.query(`CREATE FUNCTION fail_t31_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 't31 audit failure'; END $$;
      CREATE TRIGGER fail_t31_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_t31_audit()`);
    try {
      const before = await counts();
      await expect(service.create(admin, { orderId: id, reason: "Audit fails", items: [{ orderItemId: itemId, quantity: 1 }] }))
        .rejects.toThrow("t31 audit failure");
      expect(await counts()).toEqual(before);
    } finally { await pool!.query("DROP TRIGGER fail_t31_audit ON audit_logs; DROP FUNCTION fail_t31_audit()"); }
  });
});

beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const table of ["users", "platform_settings", "suppliers", "partners", "partner_terms_acceptances", "legal_documents",
    "products", "product_variants", "inventory_items", "inventory_sync_runs", "attribution_touches", "events", "audit_logs"])
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  for (const migration of ["20260930100000_cart", "20260930110000_orders", "20261001000000_commission_ledger", "20261002000000_returns"])
    await pool.query(await readFile(new URL(`../../../../packages/db/prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"));
  await pool.query("INSERT INTO platform_settings (singleton_id,platform_currency) VALUES (1,$1)", [currency]);
  await pool.query("INSERT INTO users (id,telegram_user_id,first_name) VALUES ($1,$2,'Admin')", [admin, 424240]);
  await pool.query("INSERT INTO users (id,telegram_user_id,first_name) VALUES ($1,$2,'Partner')", [partnerUser, 424241]);
  await pool.query("INSERT INTO suppliers (id,name) VALUES ($1,'Supplier')", [supplier]);
  await pool.query("INSERT INTO products (id,supplier_id,title,slug,status) VALUES ($1,$2,'Watch',$1::uuid::text,'ACTIVE')", [product, supplier]);
  await pool.query(`INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key,status)
    VALUES ($1,$2,$1::uuid::text,1000,$3,0,$1::uuid::text,'ACTIVE')`, [organicVariant, product, currency]);
  await pool.query(`INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key,status)
    VALUES ($1,$2,$1::uuid::text,1000,$3,100,$1::uuid::text,'ACTIVE')`, [attributedVariant, product, currency]);
  for (const variantId of [organicVariant, attributedVariant])
    await pool.query("INSERT INTO inventory_items (variant_id,source_quantity,source_status,last_successful_sync_at) VALUES ($1,100,'OK',now())", [variantId]);
  await pool.query("INSERT INTO partners (id,user_id) VALUES ($1,$2)", [partner, partnerUser]);
  await pool.query("INSERT INTO partner_terms_acceptances (partner_id,legal_document_id) VALUES ($1,$2)", [partner, docs.PARTNER_TERMS.id]);
  for (const [type, doc] of Object.entries(docs)) await pool.query(`INSERT INTO legal_documents
    (id,type,version,sha256,content_markdown,effective_at) VALUES ($1,$2,$3,$4,'Terms',now())`, [doc.id, type, doc.version, randomBytes(32).toString("hex")]);
  service = new AdminReturnService(pool);
  checkout = new CheckoutService(pool, currency, docs);
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE orders,returns,payouts,audit_logs,attribution_touches CASCADE");
});
afterAll(async () => { if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); } });
