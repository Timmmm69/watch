import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { disposableUrl } from "../../test/dropship-fixture.js";
import { referralFixture, telegramLaunch } from "../../test/referral-fixture.js";
import { CartService } from "../cart/cart.js";
import { AdminOrderService } from "./admin.js";
import { OrderCompletionWorker } from "./completion.js";
import { OrderMoneyService } from "../finance/money.js";
import { PayoutService } from "../finance/payouts.js";
import { PartnerEarningsService } from "../finance/earnings.js";
import { OwnerAnalyticsService } from "../analytics/owner.js";

let f: Awaited<ReturnType<typeof referralFixture>>;
afterEach(async () => { await f?.close(); });
const cart = () => new CartService(f.pool, "BYN");
const worker = () => new OrderCompletionWorker(f.pool);
const money = () => new OrderMoneyService(f.pool);
const actor = () => f.buyer.user;
const fact = (amountMinor: number, extra = {}) => ({ operationKey: randomUUID(), reference: `TEST:${randomUUID().slice(0,8)}:${randomUUID().slice(0,8)}`,
  reason: "TEST ONLY confirmed cash", confirmed: true, occurredAt: new Date().toISOString(), kind: "RECEIPT", amountMinor, ...extra });
async function place(q = 1, key = randomUUID()) {
  await cart().put(f.buyer.user, f.variant, q);
  return (await f.service.checkout(f.buyer.user, key, f.request(q))).order;
}
async function deliver(id: string, hold = 0) {
  const orders = new AdminOrderService(f.pool, hold);
  for (const target of ["CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED"] as const) await orders.transition(id, actor(), target);
}
async function balance() {
  return (await f.pool.query("SELECT COALESCE(sum(amount_minor) FILTER(WHERE bucket='AVAILABLE'),0)::int AS available FROM ledger_entries")).rows[0].available;
}

describe.skipIf(!disposableUrl())("Referral commerce with native PostgreSQL inventory", () => {
  it("creates a partner link, authenticates a signed buyer launch, checks out via API and shows the partner order/commission", async () => {
    f = await referralFixture();
    const link = await f.app.inject({ method: "POST", url: "/api/v1/partner/referral-links", headers: f.owners[0]!.headers, payload: { productId: f.product } });
    expect(link.statusCode).toBe(200);
    const initData = telegramLaunch(link.json().url);
    const launch = await f.app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData } });
    expect(launch.statusCode).toBe(200); expect(launch.json().launchTarget).toContain(f.slug);
    await f.app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData } });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM attribution_touches")).rows[0].n).toBe(1);
    const headers = f.buyer.headers;
    const product = await f.app.inject({ url: `/api/v1/catalog/products/${f.slug}`, headers });
    expect(product.statusCode).toBe(200); expect(product.json().variants[0].priceMinor).toBe(15000);
    const added = await f.app.inject({ method: "PUT", url: `/api/v1/cart/items/${f.variant}`, headers, payload: { quantity: 1 } });
    expect(added.statusCode).toBe(200);
    const post = () => f.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": "buyer-retry" }, payload: f.request() });
    const order = await post(); expect(order.statusCode).toBe(201); expect((await post()).statusCode).toBe(200);
    expect((await f.pool.query("SELECT economic_regime,inventory_mode,partner_id_snapshot FROM orders")).rows[0])
      .toEqual({ economic_regime: "LEGACY_FIXED", inventory_mode: "native", partner_id_snapshot: f.owners[0]!.partner });
    for (const table of ["orders", "commissions", "inventory_reservations"]) expect((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1);
    const partnerOrder = await f.app.inject({ url: `/api/v1/partner/orders/${order.json().publicNumber}`, headers: f.owners[0]!.headers });
    expect(partnerOrder.statusCode).toBe(200); expect(partnerOrder.json().items[0].partnerCommissionUnitSnapshotMinor).toBe(2000);
    expect(JSON.stringify(partnerOrder.json())).not.toContain("Minsk address");
    expect(await new PartnerEarningsService(f.pool).list(f.owners[0]!.partner!, { page: 1, limit: 20 })).toMatchObject({ pendingAmountMinor: 2000 });
  });

  it("keeps retail price equal for two partners and assigns the commission to the last valid click", async () => {
    f = await referralFixture();
    await f.click(0); await f.click(1);
    for (const owner of f.owners) {
      const result = await f.app.inject({ url: `/api/v1/catalog/products/${f.slug}`, headers: owner.headers });
      expect(result.json().variants[0].priceMinor).toBe(15000);
      if (owner.partner) expect(result.json().partnerView.variants[0].commissionUnitMinor).toBe(2000);
    }
    await place(); expect((await f.pool.query("SELECT partner_id FROM commissions")).rows[0].partner_id).toBe(f.owners[1]!.partner);
  });

  it("expires attribution after exactly 30 days; organic and self-referral purchases create no commission", async () => {
    f = await referralFixture(); await f.click();
    const touch = (await f.pool.query("SELECT * FROM attribution_touches")).rows[0];
    expect(touch.expires_at - touch.occurred_at).toBe(30 * 86400000);
    await f.pool.query("UPDATE attribution_touches SET occurred_at=now()-interval '31 days',expires_at=now()-interval '1 day'");
    await place();
    await f.click(0, 1); await cart().put(f.owners[0]!.user, f.variant, 1);
    await f.service.checkout(f.owners[0]!.user, "self", f.request());
    const organic = randomUUID(); await f.pool.query("INSERT INTO users(id,telegram_user_id,first_name) VALUES($1,99,'Organic')", [organic]);
    await cart().put(organic, f.variant, 1); await f.service.checkout(organic, "organic", f.request());
    expect((await f.pool.query("SELECT count(*)::int AS n FROM commissions")).rows[0].n).toBe(0);
  });

  it("serializes concurrent retries and two buyers competing for the last native unit", async () => {
    f = await referralFixture(1); await f.click();
    const second = f.owners[1]!.user;
    await cart().put(f.buyer.user, f.variant, 1); await cart().put(second, f.variant, 1);
    expect((await f.pool.query("SELECT native_reserved_quantity FROM inventory_items")).rows[0].native_reserved_quantity).toBe(0);
    const outcomes = await Promise.allSettled([f.service.checkout(f.buyer.user, "race", f.request()), f.service.checkout(second, "race", f.request())]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect((outcomes.find(x => x.status === "rejected") as PromiseRejectedResult).reason.code).toBe("OUT_OF_STOCK");
    const winner = outcomes[0]!.status === "fulfilled" ? f.buyer.user : second;
    const retry = await Promise.all([f.service.checkout(winner, "race", f.request()), f.service.checkout(winner, "race", f.request())]);
    expect(retry.every(x => !x.created)).toBe(true);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='RESERVE'")).rows[0].n).toBe(1);
  });

  it("requires retail price reconfirmation and snapshots fixed commission and original procurement allocation", async () => {
    f = await referralFixture(); await f.click(); await cart().put(f.buyer.user, f.variant, 1);
    expect((await f.app.inject({ method: "PATCH", url: `/api/v1/admin/variants/${f.variant}`,
      headers: f.buyer.headers, payload: { priceMinor: 16000 } })).statusCode).toBe(200);
    await expect(f.service.checkout(f.buyer.user, "price", f.request())).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='RESERVE'")).rows[0].n).toBe(0);
    const input = f.request(); input.items[0]!.expectedUnitPriceMinor = 16000;
    await f.service.checkout(f.buyer.user, "price", input);
    await f.pool.query("UPDATE product_variants SET price_minor=17000,partner_commission_unit_minor=3000");
    expect((await f.pool.query("SELECT unit_price_minor,partner_commission_unit_snapshot_minor,allocated_procurement_cost_minor FROM order_items")).rows[0])
      .toEqual({ unit_price_minor: 16000, partner_commission_unit_snapshot_minor: 2000, allocated_procurement_cost_minor: 8000 });
    await expect(f.pool.query("UPDATE order_items SET allocated_procurement_cost_minor=0")).rejects.toMatchObject({ code: "23514" });
    await expect(f.pool.query("UPDATE orders SET inventory_mode='external'")).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects client price/commission/attribution injection and the markup checkout contract", async () => {
    f = await referralFixture();
    for (const extra of [{ partnerId: f.owners[0]!.partner }, { attributionTouchId: randomUUID() }, { commissionUnitMinor: 1 }, { priceMinor: 1 }]) {
      const result = await f.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...f.buyer.headers, "idempotency-key": randomUUID() }, payload: { ...f.request(), ...extra } });
      expect(result.statusCode).toBe(400);
    }
    const markup = await f.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...f.owners[0]!.headers, "idempotency-key": "markup" },
      payload: { ...f.request(), items: [{ variantId: f.variant, quantity: 1, expectedDropshipPriceMinor: 10000, customerUnitPriceMinor: 19000 }] } });
    expect(markup.statusCode).toBe(400);
    for (const url of [`/api/v1/admin/variants/${f.variant}`])
      expect((await f.app.inject({ method: "PATCH", url, headers: f.owners[0]!.headers, payload: { priceMinor: 1, partnerCommissionUnitMinor: 1 } })).statusCode).toBe(403);
  });

  for (const blocked of ["partner", "user", "terms"] as const) it(`does not accrue a new commission after ${blocked} eligibility is revoked`, async () => {
    f = await referralFixture(); await f.click();
    if (blocked === "partner") await f.pool.query("UPDATE partners SET status='BLOCKED' WHERE id=$1", [f.owners[0]!.partner]);
    if (blocked === "user") await f.pool.query("UPDATE users SET is_blocked=true WHERE id=$1", [f.owners[0]!.user]);
    if (blocked === "terms") {
      const next = { id: randomUUID(), version: "next" }; f.docs.PARTNER_TERMS = next;
      await f.pool.query("INSERT INTO legal_documents(id,type,version,sha256,content_markdown,effective_at,requires_reacceptance) VALUES($1,'PARTNER_TERMS',$2,$3,'TEST',now(),true)", [next.id, next.version, "a".repeat(64)]);
    }
    await place(); expect((await f.pool.query("SELECT count(*)::int AS n FROM commissions")).rows[0].n).toBe(0);
  });

  it("holds for 14 days and requires actual cash coverage before release and paid payout", async () => {
    f = await referralFixture(); await f.click(); const order = await place();
    await deliver(order.id, 14);
    const times = (await f.pool.query("SELECT delivered_at,completion_eligible_at FROM orders")).rows[0];
    expect(times.completion_eligible_at - times.delivered_at).toBe(14 * 86400000);
    await money().record(order.id, actor(), fact(15000), "money");
    expect(await worker().completeOrder(order.id)).toBe(false); expect(await balance()).toBe(0);
    // A separate order with zero fixture hold exercises the post-hold financial gates.
    const next = await place(); await deliver(next.id);
    expect(await worker().completeOrder(next.id)).toBe(false);
    await money().record(next.id, actor(), fact(10000), "money"); expect(await worker().completeOrder(next.id)).toBe(false);
    await money().record(next.id, actor(), fact(5000), "money");
    expect(await worker().completeOrder(next.id)).toBe(true); expect(await balance()).toBe(2000);
    const payouts = new PayoutService(f.pool, "BYN", f.docs.PARTNER_TERMS, 1);
    const payout = await payouts.request(f.owners[0]!.user, "payout", {});
    await payouts.transition(actor(), payout.payout.id, { target: "PAID", externalReference: "TEST:actual-transfer" });
    expect((await payouts.detail(payout.payout.id)).status).toBe("PAID");
    const item = (await f.pool.query("SELECT id FROM order_items WHERE order_id=$1", [next.id])).rows[0].id;
    const returned = await f.returns.create(actor(), { orderId: next.id, reason: "TEST late return", items: [{ orderItemId: item, quantity: 1 }] });
    await f.returns.complete(returned.id, actor());
    expect(await balance()).toBe(-2000);
    expect((await payouts.detail(payout.payout.id)).status).toBe("PAID");
  });

  it("atomically releases cancelled stock and reverses the pending fixed commission", async () => {
    f = await referralFixture(1); await f.click(); const order = await place();
    await f.orders.transition(order.id, actor(), "CANCELLED"); await f.orders.transition(order.id, actor(), "CANCELLED");
    expect((await f.pool.query("SELECT native_on_hand,native_reserved_quantity,native_free_value_minor FROM inventory_items")).rows[0])
      .toEqual({ native_on_hand: 1, native_reserved_quantity: 0, native_free_value_minor: 8000 });
    expect((await f.pool.query("SELECT reversed_amount_minor,state FROM commissions")).rows[0]).toEqual({ reversed_amount_minor: 2000, state: "VOID" });
  });

  it("preserves attribution snapshots after link changes and rejects a disabled new click", async () => {
    f = await referralFixture(); await f.click(); const order = await place();
    const link = await f.referral.getOrCreate(f.owners[0]!.user, null);
    await f.referral.disable(actor(), link.id, "TEST disable");
    const launch = await f.app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData: telegramLaunch(link.url, 55) } });
    expect(launch.statusCode).toBe(200);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM attribution_touches")).rows[0].n).toBe(1);
    await f.click(1);
    expect((await f.pool.query("SELECT partner_id_snapshot FROM orders WHERE id=$1", [order.id])).rows[0].partner_id_snapshot).toBe(f.owners[0]!.partner);
  });

  it("rolls back all native effects on a late failure and serializes shipment versus cancellation", async () => {
    f = await referralFixture(1); await f.click(); await cart().put(f.buyer.user, f.variant, 1);
    await f.pool.query(`CREATE FUNCTION fail_referral_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='ORDER_CREATED' THEN RAISE EXCEPTION 'TEST late failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_referral_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION fail_referral_event()`);
    await expect(f.service.checkout(f.buyer.user, "late", f.request())).rejects.toThrow("TEST late failure");
    expect((await f.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0);
    expect((await f.pool.query("SELECT native_reserved_quantity FROM inventory_items")).rows[0].native_reserved_quantity).toBe(0);
    await f.pool.query("DROP TRIGGER fail_referral_event ON events");
    const order = await place();
    await f.orders.transition(order.id, actor(), "CONFIRMED"); await f.orders.transition(order.id, actor(), "FULFILLING");
    const outcomes = await Promise.allSettled([f.orders.transition(order.id, actor(), "SHIPPED"), f.orders.transition(order.id, actor(), "CANCELLED")]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const stock = (await f.pool.query("SELECT native_on_hand,native_reserved_quantity FROM inventory_items")).rows[0];
    const status = (await f.pool.query("SELECT status FROM orders")).rows[0].status;
    expect(stock).toEqual({ native_on_hand: status === "SHIPPED" ? 0 : 1, native_reserved_quantity: 0 });
  });

  it("partially and fully returns with immutable reversals, cash liabilities and stock only after saleable inspection", async () => {
    f = await referralFixture(3); await f.click(); const order = await place(3); await deliver(order.id);
    await money().record(order.id, actor(), fact(45000), "money");
    const item = (await f.pool.query("SELECT id FROM order_items")).rows[0].id;
    for (const quantity of [1, 2]) {
      const r = await f.returns.create(actor(), { orderId: order.id, reason: "TEST return", items: [{ orderItemId: item, quantity }] });
      await f.returns.complete(r.id, actor()); await f.returns.complete(r.id, actor());
      const before = (await f.pool.query("SELECT native_on_hand FROM inventory_items")).rows[0].native_on_hand;
      const detail = await f.returns.detail(r.id); expect(detail.items[0]!.physicalAcceptanceAllowed).toBe(true);
      const input = { operationKey: randomUUID(), reason: "TEST physical receipt", items: [{ returnItemId: detail.items[0]!.id, quantity, saleableQuantity: quantity === 1 ? 1 : 1 }] };
      await f.returns.inspect(r.id, actor(), input); await f.returns.inspect(r.id, actor(), input);
      expect((await f.pool.query("SELECT native_on_hand FROM inventory_items")).rows[0].native_on_hand).toBe(before + 1);
    }
    expect((await f.pool.query("SELECT gross_amount_minor,reversed_amount_minor,state FROM commissions")).rows[0])
      .toEqual({ gross_amount_minor: 6000, reversed_amount_minor: 6000, state: "VOID" });
    const finance = await money().detail(order.id); expect(finance).toMatchObject({ outstandingMinor: 45000, retainedSalesMinor: 0 });
    for (const obligation of finance.obligations) await money().record(order.id, actor(), fact(-obligation.outstandingMinor, { kind: "REFUND", obligationId: obligation.id }), "money");
    expect(await money().detail(order.id)).toMatchObject({ cashMinor: 0, outstandingMinor: 0 });
  });

  it("retains historical markup snapshots, visibility, shipment, money and commission processing", async () => {
    f = await referralFixture();
    const { salesTermsDocumentId, salesTermsAccepted, ...input } = f.request();
    const old = (await f.legacyService.checkout(f.owners[0]!.user, "old", {
      ...input, items: [{ variantId: f.variant, quantity: 1, expectedDropshipPriceMinor: 10000, customerUnitPriceMinor: 19000 }],
      partnerTermsDocumentId: f.docs.PARTNER_TERMS.id })).order;
    await deliver(old.id); await money().record(old.id, actor(), fact(19000), "money"); await worker().completeOrder(old.id);
    expect(await balance()).toBe(9000);
    expect(await f.views.getPartnerOrder(f.owners[0]!.partner!, old.publicNumber)).toMatchObject({ economicRegime: "DROPSHIP_MARKUP", items: [{ unitPriceMinor: 19000 }] });
  });

  it("upgrades populated native history without rewriting commercial, stock or financial facts", async () => {
    f = await referralFixture(10, "20261016030000_observed_money");
    const { salesTermsDocumentId, salesTermsAccepted, ...input } = f.request();
    const order = (await f.legacyService.checkout(f.owners[0]!.user, "before-upgrade", {
      ...input, items: [{ variantId: f.variant, quantity: 1, expectedDropshipPriceMinor: 10000, customerUnitPriceMinor: 18000 }],
      partnerTermsDocumentId: f.docs.PARTNER_TERMS.id })).order;
    await deliver(order.id); await money().record(order.id, actor(), fact(18000), "money"); await worker().completeOrder(order.id);
    const tables = ["order_items", "inventory_reservations", "inventory_movements", "commissions", "ledger_entries", "order_money_entries", "inventory_items"];
    const before = await Promise.all(tables.map(table => f.pool.query(`SELECT * FROM ${table} ORDER BY 1`)));
    await f.pool.query(await readFile(new URL("../../../../packages/db/prisma/migrations/20261022000000_referral_native_inventory/migration.sql", import.meta.url), "utf8"));
    for (const [index, table] of tables.entries()) expect((await f.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows).toEqual(before[index]!.rows);
    expect(await f.views.getPartnerOrder(f.owners[0]!.partner!, order.publicNumber)).toMatchObject({ economicRegime: "DROPSHIP_MARKUP" });
    await f.click(); await place();
    expect((await f.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(2);
  });

  it("reports referral and organic sales with eligible fixed commission and truthful owner contribution", async () => {
    f = await referralFixture(); await f.click(); const referred = await place();
    const organicBuyer = f.owners[1]!.user;
    await cart().put(organicBuyer, f.variant, 1);
    const organic = (await f.service.checkout(organicBuyer, "organic-report", f.request())).order;
    for (const order of [referred, organic]) {
      await deliver(order.id); await money().record(order.id, actor(), fact(15000), "money");
      await money().record(order.id, actor(), { operationKey: randomUUID(), reason: "TEST reviewed zero", confirmed: true,
        expenseEntryCount: 0, reviewedTotalMinor: 0 }, "review");
      await worker().completeOrder(order.id);
    }
    const report = await new OwnerAnalyticsService(f.pool, "BYN", 86400).report({ from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" });
    expect(report.cohort).toMatchObject({ orders: 2, retainedRMinor: 30000, retainedDMinor: 28000, markupMinor: 2000,
      contribution: { fullMinor: 12000 } });
    expect(report.drops.find(p => p.partnerId === f.owners[0]!.partner)).toMatchObject({ orders: 1, markupMinor: 2000 });
  });
});
