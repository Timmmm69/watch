import { randomUUID, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PayoutService } from "./payouts.js";
import { PartnerEarningsService } from "./earnings.js";
import { createOrderCommissions, releaseCommission } from "./commissions.js";
import { OrderCompletionWorker } from "../orders/completion.js";
import { AdminReturnService } from "../returns/returns.js";
import { generatePublicOrderNumber } from "../orders/order-number.js";

const schema = `payout_test_${randomUUID().replaceAll("-", "")}`;
const pool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL,
  max: 12, options: `-c search_path=${schema},public` }) : null;
const user = randomUUID(), partner = randomUUID(), admin = randomUUID(), otherUser = randomUUID(), otherPartner = randomUUID();
const supplier = randomUUID(), product = randomUUID(), variant = randomUUID();
const terms = { id: randomUUID(), version: "t33" }, sales = randomUUID(), privacy = randomUUID(), touch = randomUUID();
let service: PayoutService;

async function commission(amount: number, availableAt = new Date("2026-01-01"), earned = true) {
  const order = randomUUID(), item = randomUUID();
  await pool!.query(`INSERT INTO orders (id,public_number,buyer_user_id,supplier_id,attribution_touch_id,partner_id_snapshot,
    commission_eligible_snapshot,currency,subtotal_minor,total_minor,sales_terms_document_id,privacy_document_id,
    sales_terms_accepted_at,privacy_acknowledged_at,idempotency_key,request_fingerprint,status,completion_eligible_at)
    VALUES ($1::uuid,$2,$3,$4,$5,$6,true,'BYN',10000,10000,$7,$8,now(),now(),$1::text,$9,'DELIVERED',now()-interval '1 day')`,
  [order,generatePublicOrderNumber(),admin,supplier,touch,partner,sales,privacy,"a".repeat(64)]);
  await pool!.query(`INSERT INTO order_items (id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,
    partner_commission_unit_snapshot_minor,line_total_minor) VALUES ($1,$2,$3,'SKU','Watch',2,5000,$4,10000)`,
  [item,order,variant,amount/2]);
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [partner]);
    await createOrderCommissions(client,order,availableAt);
    const id = (await client.query("SELECT id FROM commissions WHERE order_id=$1", [order])).rows[0].id;
    await client.query("UPDATE commissions SET state='HOLD',eligible_at=now()-interval '1 day' WHERE id=$1", [id]);
    if (earned) await releaseCommission(client,id,availableAt);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { id: (await pool!.query("SELECT id FROM commissions WHERE order_id=$1", [order])).rows[0].id as string, order, item };
}
async function balances() {
  return (await pool!.query(`SELECT bucket,SUM(amount_minor)::int AS amount FROM ledger_entries
    WHERE partner_id=$1 GROUP BY bucket ORDER BY bucket::text`, [partner])).rows;
}
async function finalize(id: string, status: "PAID" | "REJECTED") {
  await service.transition(admin,id,{ target: status,...(status === "PAID" ? { externalReference: `transfer-${id}` } : {}) });
}
async function counts() {
  return (await pool!.query(`SELECT (SELECT count(*)::int FROM payouts) AS payouts,
    (SELECT count(*)::int FROM payout_allocations) AS allocations,(SELECT count(*)::int FROM ledger_entries) AS ledger,
    (SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM audit_logs) AS audits`)).rows[0];
}

describe.skipIf(!pool)("T33 payouts against PostgreSQL", () => {
  it("allocates full AVAILABLE FIFO by available_at and UUID, with exact journal and safe event", async () => {
    const late = await commission(3000,new Date("2026-02-01"));
    const a = await commission(2000), b = await commission(2000);
    const result = await service.request(user,"first");
    expect(result).toMatchObject({ created: true,payout: { amountMinor: 7000,currency: "BYN",status: "REQUESTED" } });
    const amounts = Object.fromEntries(result.payout.allocations.map((a) => [a.commissionId,a.amountMinor]));
    expect(amounts).toEqual({ [a.id]: 2000,[b.id]: 2000,[late.id]: 3000 });
    expect(await balances()).toEqual([{ bucket: "AVAILABLE",amount: 0 },{ bucket: "PAYOUT_LOCKED",amount: 7000 },{ bucket: "PENDING",amount: 0 }]);
    const entries = (await pool!.query("SELECT * FROM ledger_entries WHERE payout_id=$1", [result.payout.id])).rows;
    expect(new Set(entries.map((e) => e.transaction_group_id)).size).toBe(1);
    expect(new Set(entries.map((e) => e.idempotency_key)).size).toBe(2);
    expect((await pool!.query("SELECT destination_snapshot FROM payouts WHERE id=$1", [result.payout.id])).rows[0].destination_snapshot).toBeNull();
    expect((await pool!.query("SELECT payload FROM events WHERE type='PAYOUT_REQUESTED'")).rows[0].payload)
      .toEqual({ v: 1,payoutId: result.payout.id,partnerId: partner,amountMinor: 7000,status: "REQUESTED" });
  });

  it("uses UUID to break FIFO ties and allocates only the amount remaining after debt", async () => {
    const history = await commission(10000);
    const paid = await service.request(user,"paid");
    await finalize(paid.payout.id,"PAID");
    const returns = new AdminReturnService(pool!);
    const returned = await returns.create(admin,{ orderId: history.order,reason: "Late return",items: [{ orderItemId: history.item,quantity: 2 }] });
    await returns.complete(returned.id,admin);
    const a = await commission(6000), b = await commission(10000);
    const result = await service.request(user,"after-debt");
    const first = [a,b].sort((a,b) => a.id.localeCompare(b.id))[0]!;
    expect(result.payout.amountMinor).toBe(6000);
    expect(result.payout.allocations).toHaveLength(1);
    expect(result.payout.allocations[0]).toMatchObject({ commissionId: first.id,amountMinor: 6000 });
    expect((await pool!.query("SELECT amount_minor,status FROM payouts WHERE id=$1", [paid.payout.id])).rows[0])
      .toEqual({ amount_minor: 10000,status: "PAID" });
  });

  it("reuses rejected allocations without changing history and projects locked/paid amounts", async () => {
    const c = await commission(8000);
    const first = await service.request(user,"reject");
    const original = (await pool!.query("SELECT * FROM payout_allocations")).rows;
    await finalize(first.payout.id,"REJECTED");
    const second = await service.request(user,"retry-new");
    expect(second.payout.allocations[0]).toMatchObject({ commissionId: c.id,amountMinor: 8000 });
    expect((await pool!.query("SELECT * FROM payout_allocations WHERE payout_id=$1", [first.payout.id])).rows).toEqual(original);
    const earnings = new PartnerEarningsService(pool!);
    expect((await earnings.list(partner,{ page: 1,limit: 20 })).items[0]).toMatchObject({ state: "EARNED",lockedAmountMinor: 8000,paidAmountMinor: 0 });
    await finalize(second.payout.id,"PAID");
    expect((await earnings.list(partner,{ page: 1,limit: 20 })).items[0]).toMatchObject({ state: "EARNED",lockedAmountMinor: 0,paidAmountMinor: 8000 });
    await commission(6000);
    expect((await service.request(user,"new-earned")).payout.allocations.map((a) => a.commissionId)).not.toContain(c.id);
  });

  it("nets negative AVAILABLE after partial paid reversal without reallocating the old earned commission", async () => {
    const old = await commission(10000);
    const paid = await service.request(user,"partial-paid");
    await finalize(paid.payout.id,"PAID");
    const history = (await pool!.query("SELECT * FROM payout_allocations")).rows;
    const returns = new AdminReturnService(pool!);
    const returned = await returns.create(admin,{ orderId: old.order,reason: "Partial late return",items: [{ orderItemId: old.item,quantity: 1 }] });
    await returns.complete(returned.id,admin);
    await expect(service.request(user,"negative")).rejects.toMatchObject({ code: "PAYOUT_NOT_AVAILABLE" });
    const later = await commission(10000,new Date("2026-02-01"));
    const requested = await service.request(user,"debt-netted");
    expect(requested.payout).toMatchObject({ amountMinor: 5000,allocations: [{ commissionId: later.id,amountMinor: 5000 }] });
    expect((await pool!.query("SELECT * FROM payout_allocations WHERE payout_id=$1", [paid.payout.id])).rows).toEqual(history);
    expect((await new PartnerEarningsService(pool!).list(partner,{ page: 1,limit: 20 })).items.find((c) => c.id === old.id))
      .toMatchObject({ state: "EARNED",netEarnedAmountMinor: 5000,paidAmountMinor: 10000,lockedAmountMinor: 0 });
  });

  it("checks idempotency before pending/balance/minimum/eligibility, including finalized retries", async () => {
    await commission(5000);
    const result = await service.request(user,"key");
    const before = await counts();
    await pool!.query("UPDATE partners SET status='BLOCKED' WHERE id=$1", [partner]);
    expect(await new PayoutService(pool!,"BYN",terms,10000).request(user,"key")).toEqual({ payout: result.payout,created: false });
    expect(await counts()).toEqual(before);
    await finalize(result.payout.id,"PAID");
    expect((await service.request(user,"key")).payout.status).toBe("PAID");
    await expect(service.requestSettlement(admin,partner,"key")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("serializes same/different-key competing requests with exactly one lock and event", async () => {
    await commission(10000);
    const results = await Promise.all([service.request(user,"same"),service.request(user,"same")]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]!.payout).toEqual(results[1]!.payout);
    await expect(service.request(user,"different")).rejects.toMatchObject({ code: "PAYOUT_ALREADY_PENDING" });
    expect((await counts()).payouts).toBe(1);
    await finalize(results[0]!.payout.id,"REJECTED");
    const raced = await Promise.allSettled([service.request(user,"one"),service.request(user,"two")]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(raced.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "PAYOUT_ALREADY_PENDING" } });
  });

  it("applies BR-007 and permits audited Admin settlement for a BLOCKED Partner", async () => {
    await commission(5000);
    await pool!.query("UPDATE partners SET status='BLOCKED' WHERE id=$1", [partner]);
    await expect(service.request(user,"blocked")).rejects.toMatchObject({ code: "PARTNER_BLOCKED" });
    const result = await service.requestSettlement(admin,partner,"settlement",{},"request-id");
    expect(result.payout.requestedByUserId).toBe(admin);
    expect((await pool!.query("SELECT actor_user_id,request_id,metadata FROM audit_logs")).rows)
      .toEqual([{ actor_user_id: admin,request_id: "request-id",metadata: { partnerId: partner,amountMinor: 5000 } }]);
    expect((await service.requestSettlement(admin,partner,"settlement")).created).toBe(false);
    expect((await counts()).audits).toBe(1);
  });

  it("requires current terms only when reacceptance is required; rejects globally blocked users", async () => {
    await commission(5000);
    await pool!.query("DELETE FROM partner_terms_acceptances WHERE partner_id=$1", [partner]);
    const newTerms = { id: randomUUID(),version: "required" };
    await pool!.query(`INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at,requires_reacceptance)
      VALUES ($1,'PARTNER_TERMS',$2,$3,'Terms',now(),true)`, [newTerms.id,newTerms.version,randomBytes(32).toString("hex")]);
    await expect(new PayoutService(pool!,"BYN",newTerms).request(user,"stale")).rejects.toMatchObject({ code: "TERMS_REACCEPT_REQUIRED" });
    await pool!.query("UPDATE users SET is_blocked=true WHERE id=$1", [user]);
    await expect(service.request(user,"global")).rejects.toMatchObject({ code: "USER_BLOCKED" });
    await pool!.query("UPDATE users SET is_blocked=false WHERE id=$1", [user]);
    expect((await service.request(user,"nonrequired")).created).toBe(true);
  });

  it("limits new self-service payouts to five per hour while preserving retries", async () => {
    await commission(5000);
    let lastId = "";
    for (let i=0;i<5;i++) {
      lastId = (await service.request(user,`quota-${i}`)).payout.id;
      await finalize(lastId,"REJECTED");
    }
    await expect(service.request(user,"sixth")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect((await service.request(user,"quota-4")).payout).toMatchObject({ id: lastId,status: "REJECTED" });
    expect((await service.requestSettlement(admin,partner,"settlement-after-quota")).created).toBe(true);
  });

  it.each([0,4998,5000])("validates net/minimum boundary %i", async (amount) => {
    if (amount) await commission(amount);
    if (amount >= 5000) expect((await service.request(user,"minimum")).payout.amountMinor).toBe(amount);
    else await expect(service.request(user,"minimum")).rejects.toMatchObject({ code: amount ? "PAYOUT_BELOW_MINIMUM" : "PAYOUT_NOT_AVAILABLE" });
  });

  it("fails closed on configuration mismatch and positive ledger with insufficient coverage", async () => {
    const c = await commission(6000);
    for (const minimum of [0,1.5,2147483648])
      await expect(new PayoutService(pool!,"BYN",terms,minimum).request(user,randomUUID())).rejects.toMatchObject({ code: "PAYOUT_CONFIGURATION_MISSING" });
    await expect(new PayoutService(pool!,"USD",terms).request(user,"wrong-currency")).rejects.toMatchObject({ code: "PAYOUT_CONFIGURATION_MISSING" });
    await pool!.query("UPDATE commissions SET state='HOLD' WHERE id=$1", [c.id]);
    const before = await counts();
    await expect(service.request(user,"invariant")).rejects.toMatchObject({ code: "INTERNAL_INVARIANT_VIOLATION" });
    expect(await counts()).toEqual(before);
  });

  it.each(["ledger_entries","events","audit_logs"])("rolls back payout/allocation/journal on %s insert failure", async (table) => {
    await commission(6000);
    const before = await counts();
    await pool!.query(`CREATE FUNCTION fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected fault'; END; $$;
      CREATE TRIGGER injected_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fault()`);
    try { await expect(service.requestSettlement(admin,partner,"fault")).rejects.toThrow("Injected fault"); }
    finally { await pool!.query(`DROP TRIGGER injected_fault ON ${table}; DROP FUNCTION fault()`); }
    expect(await counts()).toEqual(before);
    expect((await service.requestSettlement(admin,partner,"fault")).created).toBe(true);
  });

  it("enforces allocation immutability, positivity, uniqueness and same-Partner FKs", async () => {
    const c = await commission(6000);
    const result = await service.request(user,"constraints");
    const allocation = result.payout.allocations[0]!;
    for (const sql of ["UPDATE payout_allocations SET amount_minor=1 WHERE id=$1", "DELETE FROM payout_allocations WHERE id=$1"])
      await expect(pool!.query(sql,[allocation.id])).rejects.toMatchObject({ code: "23514" });
    const insert = (partnerId: string, payoutId: string, commissionId: string, amount: number) => pool!.query(`INSERT INTO payout_allocations
      (id,partner_id,payout_id,commission_id,amount_minor) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(),partnerId,payoutId,commissionId,amount]);
    await expect(insert(partner,result.payout.id,c.id,0)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(partner,result.payout.id,c.id,1)).rejects.toMatchObject({ code: "23505" });
    const otherPayout = randomUUID();
    await pool!.query(`INSERT INTO payouts (id,partner_id,amount_minor,currency,idempotency_key,request_fingerprint,requested_by_user_id)
      VALUES ($1::uuid,$2,1,'BYN',$1::text,$3,$4)`, [otherPayout,otherPartner,"a".repeat(64),otherUser]);
    await expect(insert(partner,otherPayout,c.id,1)).rejects.toMatchObject({ constraint: "payout_allocations_payout_partner_fkey" });
    await expect(insert(otherPartner,otherPayout,c.id,1)).rejects.toMatchObject({ constraint: "payout_allocations_commission_partner_fkey" });
    await expect(pool!.query(`INSERT INTO payouts (id,partner_id,amount_minor,currency,idempotency_key,request_fingerprint,requested_by_user_id)
      VALUES ($1::uuid,$2,1,'BYN',$1::text,$3,$4)`, [randomUUID(),partner,"a".repeat(64),user])).rejects.toMatchObject({ code: "23505",constraint: "payouts_one_requested_per_partner" });
  });

  it("serializes release and payout without losing balances or allocations", async () => {
    await commission(6000);
    const hold = await commission(4000,new Date(),false);
    const [requested] = await Promise.all([service.request(user,"release-race"),new OrderCompletionWorker(pool!).completeOrder(hold.order)]);
    expect([6000,10000]).toContain(requested.payout.amountMinor);
    expect(requested.payout.allocations.reduce((sum,a) => sum+a.amountMinor,0)).toBe(requested.payout.amountMinor);
    const available = (await balances()).find((r) => r.bucket === "AVAILABLE").amount;
    expect(available+requested.payout.amountMinor).toBe(10000);
  });

  it("serializes Return completion and payout, preserving historical allocations and debt", async () => {
    const c = await commission(10000);
    const returns = new AdminReturnService(pool!);
    const returned = await returns.create(admin,{ orderId: c.order,reason: "Half",items: [{ orderItemId: c.item,quantity: 1 }] });
    const [requested] = await Promise.all([service.request(user,"return-race"),returns.complete(returned.id,admin)]);
    expect([5000,10000]).toContain(requested.payout.amountMinor);
    expect(requested.payout.allocations.reduce((sum,a) => sum+a.amountMinor,0)).toBe(requested.payout.amountMinor);
    const available = (await balances()).find((r) => r.bucket === "AVAILABLE").amount;
    expect(available+requested.payout.amountMinor).toBe(5000);
    expect((await pool!.query("SELECT reversed_amount_minor FROM commissions WHERE id=$1", [c.id])).rows[0].reversed_amount_minor).toBe(5000);
  });

  it("processes PAID once with deterministic journal, audit and PII-safe event", async () => {
    await commission(6000);
    const requested = await service.request(user,"paid-transition");
    const processed = await service.transition(admin,requested.payout.id,{ target: "PAID",externalReference: "bank-transfer-42",note: "Settled externally" },"transition-request");
    expect(processed).toMatchObject({ id: requested.payout.id,status: "PAID" });
    expect(await balances()).toEqual([{ bucket: "AVAILABLE",amount: 0 },{ bucket: "PAYOUT_LOCKED",amount: 0 },{ bucket: "PENDING",amount: 0 }]);
    expect((await pool!.query(`SELECT bucket,amount_minor,entry_type,idempotency_key FROM ledger_entries
      WHERE payout_id=$1 AND entry_type='PAYOUT_PAID'`, [requested.payout.id])).rows)
      .toEqual([{ bucket: "PAYOUT_LOCKED",amount_minor: -6000,entry_type: "PAYOUT_PAID",idempotency_key: `payout:${requested.payout.id}:paid` }]);
    expect((await pool!.query("SELECT payload FROM events WHERE type='PAYOUT_PAID' AND aggregate_id=$1", [requested.payout.id])).rows[0].payload)
      .toEqual({ v: 1,payoutId: requested.payout.id,partnerId: partner,amountMinor: 6000,status: "PAID" });
    expect((await pool!.query("SELECT actor_user_id,request_id,metadata FROM audit_logs WHERE entity_id=$1", [requested.payout.id])).rows)
      .toEqual([{ actor_user_id: admin,request_id: "transition-request",metadata: { partnerId: partner,amountMinor: 6000,fromStatus: "REQUESTED",toStatus: "PAID" } }]);
    const terminalBeforeRetry = (await pool!.query(`SELECT processed_by_admin_user_id,processed_at,external_reference,note
      FROM payouts WHERE id=$1`, [requested.payout.id])).rows[0];
    const writesBeforeRetry = await counts();
    await expect(service.transition(admin,requested.payout.id,{ target: "PAID",externalReference: "changed",note: "changed" }))
      .resolves.toMatchObject({ status: "PAID" });
    expect((await pool!.query(`SELECT processed_by_admin_user_id,processed_at,external_reference,note
      FROM payouts WHERE id=$1`, [requested.payout.id])).rows[0]).toEqual(terminalBeforeRetry);
    expect(await counts()).toEqual(writesBeforeRetry);
    expect((await pool!.query("SELECT count(*)::int AS count FROM ledger_entries WHERE payout_id=$1 AND entry_type='PAYOUT_PAID'", [requested.payout.id])).rows[0].count).toBe(1);
  });

  it("restores an exact rejection once and retains payout/allocation history", async () => {
    const c = await commission(6000);
    const requested = await service.request(user,"reject-transition");
    const allocations = (await pool!.query("SELECT * FROM payout_allocations WHERE payout_id=$1", [requested.payout.id])).rows;
    await expect(service.transition(admin,requested.payout.id,{ target: "REJECTED",note: "External transfer failed" }))
      .resolves.toMatchObject({ status: "REJECTED" });
    expect(await balances()).toEqual([{ bucket: "AVAILABLE",amount: 6000 },{ bucket: "PAYOUT_LOCKED",amount: 0 },{ bucket: "PENDING",amount: 0 }]);
    expect((await pool!.query("SELECT * FROM payout_allocations WHERE payout_id=$1", [requested.payout.id])).rows).toEqual(allocations);
    expect((await pool!.query(`SELECT bucket,amount_minor,idempotency_key FROM ledger_entries
      WHERE payout_id=$1 AND entry_type='PAYOUT_REJECT' ORDER BY idempotency_key`, [requested.payout.id])).rows)
      .toEqual([
        { bucket: "PAYOUT_LOCKED",amount_minor: -6000,idempotency_key: `payout:${requested.payout.id}:reject` },
        { bucket: "AVAILABLE",amount_minor: 6000,idempotency_key: `payout:${requested.payout.id}:reject:available` },
      ]);
    await expect(service.transition(admin,requested.payout.id,{ target: "REJECTED",note: "changed" })).resolves.toMatchObject({ status: "REJECTED" });
    await expect(service.transition(admin,requested.payout.id,{ target: "PAID",externalReference: "late-transfer" }))
      .rejects.toMatchObject({ code: "PAYOUT_ALREADY_FINALIZED" });
    expect((await pool!.query("SELECT count(*)::int AS count FROM payout_allocations WHERE commission_id=$1", [c.id])).rows[0].count).toBe(1);
  });

  it("validates terminal transition input before writing", async () => {
    await commission(6000);
    const requested = await service.request(user,"transition-validation");
    for (const input of [
      { target: "PAID" }, { target: "PAID",externalReference: "   " },
      { target: "PAID",externalReference: "x".repeat(201) }, { target: "REJECTED",note: "x".repeat(2001) },
      { target: "PAID",externalReference: "ok",unexpected: true },
    ]) await expect(service.transition(admin,requested.payout.id,input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await pool!.query("SELECT status FROM payouts WHERE id=$1", [requested.payout.id])).rows[0].status).toBe("REQUESTED");
  });

  it("serializes equal and opposing concurrent terminal transitions", async () => {
    await commission(6000);
    const same = await service.request(user,"same-transition");
    const bothPaid = await Promise.all(["a","b"].map((reference) =>
      service.transition(admin,same.payout.id,{ target: "PAID",externalReference: reference })));
    expect(bothPaid.map((p) => p.status)).toEqual(["PAID","PAID"]);
    expect((await pool!.query("SELECT count(*)::int AS count FROM ledger_entries WHERE payout_id=$1 AND entry_type='PAYOUT_PAID'", [same.payout.id])).rows[0].count).toBe(1);
    await commission(6000);
    const opposite = await service.request(user,"opposite-transition");
    const outcome = await Promise.allSettled([
      service.transition(admin,opposite.payout.id,{ target: "PAID",externalReference: "first" }),
      service.transition(admin,opposite.payout.id,{ target: "REJECTED",note: "second" }),
    ]);
    expect(outcome.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcome.filter((result) => result.status === "rejected")[0]).toMatchObject({ reason: { code: "PAYOUT_ALREADY_FINALIZED" } });
  });

  it.each(["ledger_entries","events","audit_logs"])("rolls back processing if %s fails", async (table) => {
    await commission(6000);
    const requested = await service.request(user,`processing-fault-${table}`);
    const before = await counts();
    await pool!.query(`CREATE FUNCTION transition_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected transition fault'; END; $$;
      CREATE TRIGGER transition_injected_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION transition_fault()`);
    try {
      await expect(service.transition(admin,requested.payout.id,{ target: "PAID",externalReference: "fault" })).rejects.toThrow("Injected transition fault");
    } finally {
      await pool!.query(`DROP TRIGGER transition_injected_fault ON ${table}; DROP FUNCTION transition_fault()`);
    }
    expect(await counts()).toEqual(before);
    expect((await pool!.query("SELECT status,processed_at FROM payouts WHERE id=$1", [requested.payout.id])).rows[0]).toEqual({ status: "REQUESTED",processed_at: null });
    await expect(service.transition(admin,requested.payout.id,{ target: "PAID",externalReference: "after-fault" })).resolves.toMatchObject({ status: "PAID" });
  });

  it("keeps historical payout reads available and scopes paginated Partner/Admin history", async () => {
    await commission(6000);
    const first = await service.request(user,"history-first");
    await service.transition(admin,first.payout.id,{ target: "REJECTED",note: "first" });
    await commission(6000);
    const second = await service.request(user,"history-second");
    await service.transition(admin,second.payout.id,{ target: "PAID",externalReference: "second" });
    await pool!.query("UPDATE payouts SET requested_at='2026-09-01T00:00:00.000Z' WHERE id IN ($1,$2)", [first.payout.id,second.payout.id]);
    await pool!.query("UPDATE partners SET status='BLOCKED' WHERE id=$1", [partner]);
    await pool!.query("DELETE FROM partner_terms_acceptances WHERE partner_id=$1", [partner]);
    const own = await service.listOwn(user,{ page: 1,limit: 1 });
    expect(own).toMatchObject({ total: 2,page: 1,limit: 1 });
    expect(own.items).toHaveLength(1);
    const ordered = (await pool!.query<{ id: string }>(`SELECT id FROM payouts WHERE id IN ($1,$2)
      ORDER BY id`, [first.payout.id,second.payout.id])).rows.map((row) => row.id);
    expect(own.items[0]!.id).toBe(ordered[0]);
    expect((await service.listOwn(user,{ page: 2,limit: 1 })).items).toMatchObject([{ id: ordered[1] }]);
    expect(await service.listOwn(otherUser,{ page: 1,limit: 100 })).toMatchObject({ items: [],total: 0,page: 1,limit: 100 });
    expect((await service.listOwn(user,{ page: 1,limit: 100,status: "PAID" })).items).toMatchObject([{ id: second.payout.id,status: "PAID" }]);
    expect((await service.listAdmin({ page: 1,limit: 100,status: "REJECTED",partnerId: partner })).items)
      .toMatchObject([{ id: first.payout.id,partnerId: partner,status: "REJECTED" }]);
    const detail = await service.detail(second.payout.id);
    expect(detail).toMatchObject({ id: second.payout.id });
    expect(detail.allocations).toEqual(expect.arrayContaining([expect.objectContaining({ commissionId: expect.any(String) })]));
  });

  it("keeps net ledger balances valid when reject, replacement request and return race", async () => {
    const original = await commission(10000);
    const requested = await service.request(user,"reject-return-race-initial");
    const originalAllocations = (await pool!.query("SELECT * FROM payout_allocations WHERE payout_id=$1", [requested.payout.id])).rows;
    const returns = new AdminReturnService(pool!);
    const returned = await returns.create(admin,{ orderId: original.order,reason: "Concurrent half return",items: [{ orderItemId: original.item,quantity: 1 }] });
    const outcomes = await Promise.allSettled([
      service.transition(admin,requested.payout.id,{ target: "REJECTED",note: "retry funds" }),
      service.request(user,"reject-return-race-replacement"),
      returns.complete(returned.id,admin),
    ]);
    const rejected = outcomes[0]!;
    const replacement = outcomes[1]!;
    const completed = outcomes[2]!;
    expect(rejected).toMatchObject({ status: "fulfilled",value: { status: "REJECTED" } });
    expect(completed).toMatchObject({ status: "fulfilled" });
    if (replacement.status === "rejected") expect(replacement.reason).toMatchObject({ code: "PAYOUT_ALREADY_PENDING" });
    else expect(replacement.value.payout).toMatchObject({ status: "REQUESTED",amountMinor: expect.any(Number) });
    const balance = Object.fromEntries((await balances()).map(({ bucket,amount }) => [bucket,amount]));
    expect(balance.PENDING).toBe(0);
    expect(balance.AVAILABLE + balance.PAYOUT_LOCKED).toBe(5000);
    expect((await pool!.query("SELECT * FROM payout_allocations WHERE payout_id=$1", [requested.payout.id])).rows).toEqual(originalAllocations);
    expect((await pool!.query("SELECT reversed_amount_minor FROM commissions WHERE id=$1", [original.id])).rows[0].reversed_amount_minor).toBe(5000);
  });
});

beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  const root = new URL("../../../../packages/db/prisma/migrations/", import.meta.url);
  for (const migration of (await readdir(root,{ withFileTypes: true })).filter((m) => m.isDirectory()).sort((a,b) => a.name.localeCompare(b.name)))
    await pool.query(await readFile(new URL(`${migration.name}/migration.sql`,root),"utf8"));
  await pool.query("INSERT INTO platform_settings (singleton_id,platform_currency) VALUES (1,'BYN')");
  for (const [id,telegram] of [[user,933330],[admin,933331],[otherUser,933332]])
    await pool.query("INSERT INTO users (id,telegram_user_id,first_name) VALUES ($1,$2,'Test')", [id,telegram]);
  await pool.query("INSERT INTO partners (id,user_id) VALUES ($1,$2),($3,$4)", [partner,user,otherPartner,otherUser]);
  for (const [id,type] of [[terms.id,"PARTNER_TERMS"],[sales,"SALES_TERMS"],[privacy,"PRIVACY"]])
    await pool.query(`INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at)
      VALUES ($1,$2,'t33',$3,'Terms',now())`, [id,type,randomBytes(32).toString("hex")]);
  await pool.query("INSERT INTO suppliers (id,name) VALUES ($1,'Supplier')", [supplier]);
  await pool.query("INSERT INTO products (id,supplier_id,title,slug) VALUES ($1,$2,'Watch','t33')", [product,supplier]);
  await pool.query("INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key) VALUES ($1,$2,'T33',5000,'BYN',0,'T33')", [variant,product]);
  const link = randomUUID();
  await pool.query("INSERT INTO referral_links (id,partner_id,token) VALUES ($1,$2,$3)", [link,partner,randomBytes(18).toString("base64url")]);
  await pool.query(`INSERT INTO attribution_touches (id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+interval '30 days')`, [touch,admin,partner,link,"a".repeat(64)]);
  service = new PayoutService(pool,"BYN",terms);
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE orders,payouts,events,audit_logs CASCADE");
  await pool.query("UPDATE partners SET status='ACTIVE' WHERE id=$1", [partner]);
  await pool.query("UPDATE users SET is_blocked=false WHERE id=$1", [user]);
  await pool.query("INSERT INTO partner_terms_acceptances (partner_id,legal_document_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [partner,terms.id]);
});
afterAll(async () => { if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); } });
