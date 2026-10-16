import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { dropshipFixture, disposableUrl } from "../../test/dropship-fixture.js";
import { OrderMoneyService } from "./money.js";
import { PayoutService } from "./payouts.js";
import { AdminOrderService } from "../orders/admin.js";
import { OrderCompletionWorker } from "../orders/completion.js";
import { inventoryTransaction, NativeInventoryService } from "../inventory/native.js";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { PartnerEarningsService } from "./earnings.js";

let f: Awaited<ReturnType<typeof dropshipFixture>>;
afterEach(async () => { await f?.close(); });
const actor = () => f.owners[2]!.user;
const money = () => new OrderMoneyService(f.pool);
const payouts = () => new PayoutService(f.pool, "BYN", f.docs.PARTNER_TERMS, 1);
const worker = () => new OrderCompletionWorker(f.pool);
function fact(amountMinor: number, kind = "RECEIPT", extra: object = {}) {
  return { operationKey: randomUUID(), reference: `TEST:${randomUUID().slice(0,8)}:${randomUUID().slice(0,8)}`, occurredAt: "2026-10-01T00:00:00+03:00",
    reason: "TEST ONLY verified fact", confirmed: true, kind, amountMinor, ...extra };
}
async function setup(q = 3, r = 14500, owner = 0) {
  f = await dropshipFixture(8, "640.02", true);
  return place(q, r, owner);
}
async function place(q = 3, r = 14500, owner = 0) {
  const o = (await f.service.checkout(f.owners[owner]!.user, randomUUID(), f.request(r, q))).order;
  const item = (await f.pool.query("SELECT id FROM order_items WHERE order_id=$1", [o.id])).rows[0].id as string;
  return { id: o.id, item, q, r };
}
async function deliver(id: string, days = 0) {
  const orders = new AdminOrderService(f.pool, days);
  for (const status of ["CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED"] as const) await orders.transition(id, actor(), status);
}
async function receive(id: string, amount: number) { return money().record(id, actor(), fact(amount), "money"); }
async function requested(o: { id: string; item: string }, quantity = 1) {
  return f.returns.create(actor(), { orderId: o.id, reason: "TEST ONLY return", items: [{ orderItemId: o.item, quantity }] });
}
async function balance() {
  return (await f.pool.query(`SELECT COALESCE(sum(amount_minor) FILTER(WHERE bucket='AVAILABLE'),0)::int AS available,
    COALESCE(sum(amount_minor) FILTER(WHERE bucket='PAYOUT_LOCKED'),0)::int AS locked FROM ledger_entries`)).rows[0];
}

describe.skipIf(!disposableUrl())("T50 observed money / remuneration / payout on disposable PostgreSQL", () => {
  it("never releases unpaid or partially paid delivered goods; the remaining receipt releases the snapshot only", async () => {
    const o = await setup(1); await deliver(o.id);
    expect(await worker().completeOrder(o.id)).toBe(false);
    await receive(o.id, 10000); expect(await worker().completeOrder(o.id)).toBe(false);
    expect(await balance()).toEqual({ available: 0, locked: 0 });
    await receive(o.id, 4500); expect(await worker().completeOrder(o.id)).toBe(true);
    expect(await balance()).toEqual({ available: 4500, locked: 0 });
    expect((await f.pool.query("SELECT unit_amount_minor,gross_amount_minor FROM commissions")).rows).toEqual([{ unit_amount_minor: 4500, gross_amount_minor: 4500 }]);
    const line = (await f.pool.query("SELECT dropship_unit_price_minor,customer_unit_price_minor,allocated_procurement_cost_minor FROM order_items WHERE id=$1", [o.item])).rows[0];
    expect(line).toEqual({ dropship_unit_price_minor: 10000, customer_unit_price_minor: 14500, allocated_procurement_cost_minor: 8000 });
    expect(line.dropship_unit_price_minor-line.allocated_procurement_cost_minor).toBe(2000);
  });
  it("deduplicates concurrent receipts by operation and reference, rejects changed replay, keeps overpayment as liability", async () => {
    const o = await setup(1); await deliver(o.id); const input = fact(15000);
    await Promise.all([money().record(o.id, actor(), input, "money"), money().record(o.id, actor(), input, "money")]);
    await money().record(o.id, actor(), { ...input, operationKey: randomUUID() }, "money");
    await expect(money().record(o.id, actor(), { ...input, amountMinor: 15001 }, "money")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const state = await money().detail(o.id);
    expect(state).toMatchObject({ cashMinor: 15000, outstandingMinor: 500, retainedSalesMinor: 14500, covered: true });
    expect(state.money).toHaveLength(1); await worker().completeOrder(o.id);
    expect(await balance()).toMatchObject({ available: 4500 });
    const refund = fact(-500, "REFUND", { obligationId: state.obligations[0]!.id });
    await Promise.all([money().record(o.id, actor(), refund, "money"), money().record(o.id, actor(), refund, "money")]);
    expect(await money().detail(o.id)).toMatchObject({ cashMinor: 14500, outstandingMinor: 0, covered: true });
  });
  it("reverses receipts and refunds append-only and once, with current coverage checked at payout", async () => {
    const o = await setup(1); await deliver(o.id); const state = await receive(o.id, 15000);
    const refund = await money().record(o.id, actor(), fact(-500, "REFUND", { obligationId: state.obligations[0]!.id }), "money");
    const row = refund.money.find(row => row.kind === "REFUND")!;
    const correction = fact(500, "CORRECTION", { correctsEntryId: row.id });
    await money().record(o.id, actor(), correction, "money"); await money().record(o.id, actor(), correction, "money");
    await expect(money().record(o.id, actor(), fact(500, "CORRECTION", { correctsEntryId: row.id }), "money")).rejects.toMatchObject({ code: "INVALID_MONEY_FACT" });
    expect(await money().detail(o.id)).toMatchObject({ cashMinor: 15000, outstandingMinor: 500, covered: true });
    await worker().completeOrder(o.id);
    await money().record(o.id, actor(), fact(-15000, "CORRECTION", { correctsEntryId: state.money[0]!.id }), "money");
    expect(await money().detail(o.id)).toMatchObject({ cashMinor: 0, outstandingMinor: 0, covered: false });
    await expect(payouts().request(f.owners[0]!.user, randomUUID())).rejects.toMatchObject({ code: "PAYOUT_FACTS_CHANGED" });
    expect(await new PartnerEarningsService(f.pool).list(f.owners[0]!.partner!, { page: 1, limit: 20 })).toMatchObject({ payoutBlocked: true });
  });
  it("keeps unknown expenses distinct from reviewed zero, invalidates a review and bounds/deduplicates corrections", async () => {
    const o = await setup(1); expect((await money().detail(o.id)).expensesMinor).toBeNull();
    const review = { operationKey: randomUUID(), reason: "TEST ONLY reviewed", confirmed: true, expenseEntryCount: 0, reviewedTotalMinor: 0 };
    await money().record(o.id, actor(), review, "review"); await money().record(o.id, actor(), review, "review");
    expect((await money().detail(o.id)).expensesMinor).toBe(0);
    const input = fact(125, "DELIVERY");
    await Promise.all([money().record(o.id, actor(), input, "expense"), money().record(o.id, actor(), input, "expense")]);
    const state = await money().detail(o.id); expect(state).toMatchObject({ expensesMinor: null, recordedExpensesMinor: 125, expenseEntryCount: 1 });
    await expect(money().record(o.id, actor(), { ...review, operationKey: randomUUID() }, "review")).rejects.toMatchObject({ code: "INVALID_MONEY_FACT" });
    await money().record(o.id, actor(), fact(-125, "DELIVERY", { correctsExpenseId: state.expenses[0]!.id }), "expense");
    expect((await money().detail(o.id)).recordedExpensesMinor).toBe(0);
    await expect(f.pool.query("UPDATE order_direct_expenses SET amount_minor=0")).rejects.toMatchObject({ code: "23514" });
  });
  it("returns the exact quantity R and markup, reserves the refund liability, then settles actual refund separately", async () => {
    const o = await setup(3, 14501); await deliver(o.id); await receive(o.id, 43503);
    const r = await requested(o); await f.returns.complete(r.id, actor()); await f.returns.complete(r.id, actor());
    let state = await money().detail(o.id);
    expect(state).toMatchObject({ cashMinor: 43503, retainedSalesMinor: 29002, outstandingMinor: 14501, covered: true });
    await worker().completeOrder(o.id); expect(await balance()).toMatchObject({ available: 9002 });
    await money().record(o.id, actor(), fact(-14501, "REFUND", { obligationId: state.obligations[0]!.id }), "money");
    state = await money().detail(o.id); expect(state).toMatchObject({ cashMinor: 29002, outstandingMinor: 0, covered: true });
    await expect(money().record(o.id, actor(), fact(-1, "REFUND", { obligationId: state.obligations[0]!.id }), "money")).rejects.toMatchObject({ code: "INVALID_MONEY_FACT" });
    const rest = await requested(o, 2); await f.returns.complete(rest.id, actor());
    expect((await f.pool.query("SELECT gross_amount_minor,reversed_amount_minor FROM commissions")).rows[0]).toEqual({ gross_amount_minor: 13503, reversed_amount_minor: 13503 });
  });
  it("does not fabricate coverage for a partially paid order with a completed return", async () => {
    const o = await setup(2); await deliver(o.id); await receive(o.id, 14500);
    const r = await requested(o); await f.returns.complete(r.id, actor());
    expect(await money().detail(o.id)).toMatchObject({ retainedSalesMinor: 14500, outstandingMinor: 14500, covered: false });
    expect(await worker().completeOrder(o.id)).toBe(false); expect(await balance()).toMatchObject({ available: 0 });
  });
  it("keeps original fourteen-day hold, and rejection after its expiry does not restart it", async () => {
    const o = await setup(1); await deliver(o.id, 14); await receive(o.id, 14500);
    const row = (await f.pool.query("SELECT delivered_at,completion_eligible_at FROM orders WHERE id=$1", [o.id])).rows[0];
    expect(row.completion_eligible_at-row.delivered_at).toBe(14*86400000);
    expect(await worker().completeOrder(o.id)).toBe(false);
    const r = await requested(o);
    // Advance fixture delivery and its original hold together; production never rewrites them.
    await f.pool.query("UPDATE orders SET delivered_at=delivered_at-interval '15 days',completion_eligible_at=completion_eligible_at-interval '15 days' WHERE id=$1", [o.id]);
    await f.pool.query("UPDATE commissions SET eligible_at=eligible_at-interval '15 days' WHERE order_id=$1", [o.id]);
    const eligible = (await f.pool.query("SELECT completion_eligible_at FROM orders WHERE id=$1", [o.id])).rows[0].completion_eligible_at;
    expect(await worker().completeOrder(o.id)).toBe(false);
    await f.returns.reject(r.id, actor()); expect(await balance()).toMatchObject({ available: 4500 });
    expect((await f.pool.query("SELECT completion_eligible_at FROM orders WHERE id=$1", [o.id])).rows[0].completion_eligible_at).toEqual(eligible);
  });
  it("releases an unaffected line, while another line is requested, only with order coverage", async () => {
    const o = await setup(1); const variant = randomUUID(), init = randomUUID(), key = randomUUID();
    await inventoryTransaction(f.pool, async client => {
      await client.query(`INSERT INTO product_variants(id,product_id,sku,price_minor,currency,partner_commission_unit_minor,dropship_price_minor,inventory_external_key,status)
        VALUES($1,$2,'T50-SECOND',10000,'BYN',0,10000,'T50-SECOND','ACTIVE')`, [variant, f.product]);
      await client.query("INSERT INTO inventory_items(variant_id) VALUES($1)", [variant]);
      await client.query("INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at) VALUES($1,$2,'TEST',$3,'TEST',now())", [init, key, actor()]);
      await new NativeInventoryService(f.pool).initialize(client, { actorUserId: actor(), operationKey: key, reason: "TEST", occurredAt: new Date() }, init, [{ variantId: variant, quantity: 2, cost: 16000 }]);
    });
    const input = f.request(); input.items.push({ ...input.items[0]!, variantId: variant });
    const placed = (await f.service.checkout(f.owners[0]!.user, randomUUID(), input)).order;
    const item = (await f.pool.query("SELECT id FROM order_items WHERE order_id=$1 AND variant_id=$2", [placed.id, variant])).rows[0].id;
    await deliver(placed.id); const r = await requested({ id: placed.id, item });
    await receive(placed.id, 14500); await worker().completeOrder(placed.id); expect(await balance()).toMatchObject({ available: 0 });
    await receive(placed.id, 14500); await worker().completeOrder(placed.id); expect(await balance()).toMatchObject({ available: 4500 });
    await f.returns.reject(r.id, actor()); expect(await balance()).toMatchObject({ available: 9000 });
    expect((await money().detail(o.id)).cashMinor).toBe(0);
  });
  it("preserves the paid transfer and appends late-return debt; later earnings offset that debt", async () => {
    const o = await setup(1); await deliver(o.id); await receive(o.id, 14500); await worker().completeOrder(o.id);
    const payout = await payouts().request(f.owners[0]!.user, randomUUID());
    const paid = await payouts().transition(actor(), payout.payout.id, { target: "PAID", externalReference: "TEST:late-transfer" });
    const old = (await f.pool.query("SELECT * FROM ledger_entries WHERE payout_id=$1 ORDER BY id", [paid.id])).rows;
    const r = await requested(o); await f.returns.complete(r.id, actor());
    expect(await balance()).toEqual({ available: -4500, locked: 0 });
    expect(await new PartnerEarningsService(f.pool).list(f.owners[0]!.partner!, { page: 1, limit: 20 })).toMatchObject({ debtAmountMinor: 4500, reversalAmountMinor: 4500 });
    expect(await payouts().detail(paid.id)).toEqual(paid);
    expect((await f.pool.query("SELECT * FROM ledger_entries WHERE payout_id=$1 ORDER BY id", [paid.id])).rows).toEqual(old);
    const next = await place(2); await deliver(next.id); await receive(next.id, 29000); await worker().completeOrder(next.id);
    expect(await balance()).toMatchObject({ available: 4500 });
    const settlement = await payouts().request(f.owners[0]!.user, randomUUID()); expect(settlement.payout.amountMinor).toBe(4500);
    expect(settlement.payout.allocations.reduce((sum, a) => sum+a.amountMinor, 0)).toBe(4500);
  });
  it("rechecks requested payout against payment correction and requested/completed returns before PAID", async () => {
    const o = await setup(2); await deliver(o.id); const cash = await receive(o.id, 29000); await worker().completeOrder(o.id);
    const p = await payouts().request(f.owners[0]!.user, randomUUID());
    const r = await requested(o);
    await expect(payouts().transition(actor(), p.payout.id, { target: "PAID", externalReference: "TEST:blocked" })).rejects.toMatchObject({ code: "PAYOUT_FACTS_CHANGED" });
    await f.returns.reject(r.id, actor());
    await money().record(o.id, actor(), fact(-29000, "CORRECTION", { correctsEntryId: cash.money[0]!.id }), "money");
    await expect(payouts().transition(actor(), p.payout.id, { target: "PAID", externalReference: "TEST:blocked" })).rejects.toMatchObject({ code: "PAYOUT_FACTS_CHANGED" });
    await receive(o.id, 29000); const completed = await requested(o); await f.returns.complete(completed.id, actor());
    await expect(payouts().transition(actor(), p.payout.id, { target: "PAID", externalReference: "TEST:blocked" })).rejects.toMatchObject({ code: "PAYOUT_FACTS_CHANGED" });
    await payouts().transition(actor(), p.payout.id, { target: "REJECTED" }); expect(await balance()).toEqual({ available: 4500, locked: 0 });
  });
  it("requires an actual transfer reference, replays once, rejects altered and reused transfer identities", async () => {
    const o = await setup(1); await deliver(o.id); await receive(o.id, 14500); await worker().completeOrder(o.id);
    const p = await payouts().request(f.owners[0]!.user, randomUUID());
    await expect(payouts().transition(actor(), p.payout.id, { target: "PAID" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await Promise.all([1, 2].map(() => payouts().transition(actor(), p.payout.id, { target: "PAID", externalReference: "TEST:transfer" })));
    await expect(payouts().transition(actor(), p.payout.id, { target: "PAID", externalReference: "TEST:changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const next = await place(1); await deliver(next.id); await receive(next.id, 14500); await worker().completeOrder(next.id);
    const second = await payouts().request(f.owners[0]!.user, randomUUID());
    await expect(payouts().transition(actor(), second.payout.id, { target: "PAID", externalReference: "TEST:transfer" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM ledger_entries WHERE entry_type='PAYOUT_PAID'")).rows[0].n).toBe(1);
  });
  it("serializes receipt, return completion, release and payout request, preserving money/allocations", async () => {
    const o = await setup(3); await deliver(o.id); const r = await requested(o);
    const results = await Promise.allSettled([receive(o.id, 43500), f.returns.complete(r.id, actor()), worker().completeOrder(o.id), payouts().request(f.owners[0]!.user, "race")]);
    expect(results.slice(0, 3).every(row => row.status === "fulfilled")).toBe(true);
    await worker().completeOrder(o.id);
    const state = await money().detail(o.id); expect(state).toMatchObject({ cashMinor: 43500, retainedSalesMinor: 29000, outstandingMinor: 14500, covered: true });
    const requestedPayout = (await f.pool.query("SELECT id,amount_minor FROM payouts WHERE status='REQUESTED'")).rows[0];
    if (requestedPayout) expect(requestedPayout.amount_minor).toBe(9000);
    const b = await balance(); expect(b.available+b.locked).toBe(9000);
    const r2 = await requested(o);
    const obligation = state.obligations[0]!.id;
    const race = await Promise.allSettled([money().record(o.id, actor(), fact(-14500, "REFUND", { obligationId: obligation }), "money"),
      f.returns.complete(r2.id, actor()), worker().completeOrder(o.id), ...(requestedPayout ? [payouts().transition(actor(), requestedPayout.id, { target: "PAID", externalReference: "TEST:race" })] : [])]);
    expect(race.slice(0, 3).every(row => row.status === "fulfilled")).toBe(true);
    expect((await f.pool.query("SELECT reversed_amount_minor FROM commissions WHERE order_id=$1", [o.id])).rows[0].reversed_amount_minor).toBe(9000);
  });
  it("bounds integers exactly, rejects fractional/unsafe inputs, and never adds surplus to markup", async () => {
    const o = await setup(1, 2_000_000_000); await deliver(o.id);
    for (const n of [0, 1.5, 2_000_000_001, Number.MAX_SAFE_INTEGER])
      await expect(money().record(o.id, actor(), fact(n), "money")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await receive(o.id, 2_000_000_000);
    await expect(receive(o.id, 1)).rejects.toMatchObject({ code: "MONEY_LIMIT_EXCEEDED" });
    await worker().completeOrder(o.id); expect(await balance()).toMatchObject({ available: 1_999_990_000 });
    for (const reference of ["4111111111111111", "https://bank.test/x", "secret token", "TEST:4111111111111111"])
      await expect(money().record(o.id, actor(), { ...fact(1), reference }, "money")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("serializes an actual-transfer confirmation with a new Return request and appends any late debt", async () => {
    const o = await setup(2); await deliver(o.id); await receive(o.id, 29000); await worker().completeOrder(o.id);
    const p = await payouts().request(f.owners[0]!.user, randomUUID());
    const outcome = await Promise.allSettled([payouts().transition(actor(), p.payout.id, { target: "PAID", externalReference: "TEST:transfer-return-race" }), requested(o)]);
    expect(outcome[1]!.status).toBe("fulfilled");
    const r = (outcome[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof requested>>>).value;
    await f.returns.complete(r.id, actor());
    const b = await balance();
    if (outcome[0]!.status === "fulfilled") expect(b).toEqual({ available: -4500, locked: 0 });
    else {
      expect(outcome[0]).toMatchObject({ reason: { code: "PAYOUT_FACTS_CHANGED" } });
      expect(b).toEqual({ available: -4500, locked: 9000 });
      await payouts().transition(actor(), p.payout.id, { target: "REJECTED" });
      expect(await balance()).toEqual({ available: 4500, locked: 0 });
    }
  });
  it("migrates T49 Returns by appending missing liabilities while keeping paid allocations, cash and commercial snapshots intact", async () => {
    const o = await setup(1); await deliver(o.id); await receive(o.id, 14500); await worker().completeOrder(o.id);
    const p = await payouts().request(f.owners[0]!.user, randomUUID());
    await payouts().transition(actor(), p.payout.id, { target: "PAID", externalReference: "TEST:migration-transfer" });
    const r = await requested(o); await f.returns.complete(r.id, actor());
    const schema = `t50_cutover_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: disposableUrl() });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const target = new Pool({ connectionString: disposableUrl(), options: `-c search_path=${schema},public` });
    const root = resolve(process.cwd(), "../../packages/db/prisma/migrations");
    try {
      for (const name of (await readdir(root)).filter(name => /^\d/.test(name) && name < "20261016030000_observed_money").sort())
        await target.query(await readFile(join(root, name, "migration.sql"), "utf8"));
      // Clone the representative T49 facts with triggers disabled only in this isolated
      // fixture, as pg_restore does. Restore every guard before applying the migration.
      const tables = ["users", "partners", "legal_documents", "partner_terms_acceptances", "suppliers", "products", "product_variants", "platform_settings",
        "inventory_initializations", "inventory_items", "orders", "order_items", "order_fulfillment_details", "inventory_reservations", "inventory_movements",
        "commissions", "payouts", "payout_allocations", "ledger_entries", "returns", "return_items", "order_money_entries"];
      await target.query("SET session_replication_role=replica");
      for (const table of tables) {
        const rows = (await f.pool.query(`SELECT * FROM ${table}`)).rows;
        const columns = (await target.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position", [schema, table])).rows.map(row => row.column_name as string);
        for (const row of rows) await target.query(`INSERT INTO ${table}(${columns.map(c=>`"${c}"`).join(",")}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(",")})`, columns.map(c => {
          const value = row[c]; return value && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value;
        }));
      }
      await target.query("SET session_replication_role=origin");
      const protectedTables = ["orders", "order_items", "commissions", "payouts", "payout_allocations", "ledger_entries", "order_money_entries", "returns", "return_items"];
      const before = [];
      for (const table of protectedTables) before.push((await target.query(`SELECT to_jsonb(t)-'verified_transfer_reference' AS fact FROM ${table} t ORDER BY id`)).rows);
      const sql = await readFile(join(root, "20261016030000_observed_money", "migration.sql"), "utf8");
      await target.query(sql);
      for (let i=0; i<protectedTables.length; i++) expect((await target.query(`SELECT to_jsonb(t)-'verified_transfer_reference' AS fact FROM ${protectedTables[i]} t ORDER BY id`)).rows).toEqual(before[i]);
      expect((await target.query("SELECT amount_minor,return_id FROM customer_obligations")).rows).toEqual([{ amount_minor: 14500, return_id: r.id }]);
      expect((await target.query("SELECT verified_transfer_reference FROM payouts")).rows).toEqual([{ verified_transfer_reference: null }]);
      await expect(target.query("UPDATE customer_obligations SET amount_minor=1")).rejects.toMatchObject({ code: "23514" });
    } finally { await target.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  it("rolls back all cash/liability effects on late audit failure, and cancellation creates only a liability", async () => {
    const o = await setup(1);
    await f.pool.query(`CREATE FUNCTION fail_t50() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='admin.order.money' THEN RAISE EXCEPTION 'TEST audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_t50 BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_t50()`);
    await expect(receive(o.id, 15000)).rejects.toThrow("TEST audit failure");
    expect(await money().detail(o.id)).toMatchObject({ cashMinor: 0, outstandingMinor: 0 });
    await f.pool.query("DROP TRIGGER fail_t50 ON audit_logs"); await receive(o.id, 15000);
    await f.orders.transition(o.id, actor(), "CANCELLED");
    expect(await money().detail(o.id)).toMatchObject({ cashMinor: 15000, retainedSalesMinor: 0, outstandingMinor: 15000 });
  });
  it("protects admin journals with Session/Admin/CSRF, strict contracts and safe read projections", async () => {
    const o = await setup(1); const url = `/api/v1/admin/orders/${o.id}/finance`;
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    expect((await f.app.inject({ url, headers: f.owners[0]!.headers })).statusCode).toBe(403);
    const headers = f.owners[2]!.headers;
    expect((await f.app.inject({ url, headers })).headers["cache-control"]).toBe("no-store");
    for (const mode of ["money", "expense", "review"]) {
      expect((await f.app.inject({ method: "POST", url: `${url}/${mode}`, headers: f.owners[0]!.headers, payload: fact(100) })).statusCode).toBe(403);
      expect((await f.app.inject({ method: "POST", url: `${url}/${mode}`, headers: { ...headers, "x-csrf-token": "bad" }, payload: fact(100) })).statusCode).toBe(403);
    }
    const payload = fact(14500);
    expect((await f.app.inject({ method: "POST", url: `${url}/money`, headers, payload: { ...payload, confirmed: false } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: `${url}/money`, headers, payload: { ...payload, card: "secret" } })).statusCode).toBe(400);
    const response = await f.app.inject({ method: "POST", url: `${url}/money`, headers, payload });
    expect(response.statusCode).toBe(200); expect(response.json().cashMinor).toBe(14500);
    expect(response.body).not.toContain("recipient");
  });
});
