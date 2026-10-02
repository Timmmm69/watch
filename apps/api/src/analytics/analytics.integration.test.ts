import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsService } from "./analytics.js";

const schema = `analytics_test_${randomUUID().replaceAll("-", "")}`;
const pool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL,
  options: `-c search_path=${schema},public` }) : null;
const tables = ["products", "product_variants", "partners", "partner_terms_acceptances", "orders", "order_items",
  "returns", "return_items", "commissions", "payouts", "attribution_touches", "inventory_items",
  "inventory_reservations", "inventory_sync_runs", "events", "telegram_updates"];
const partner = randomUUID(), otherPartner = randomUUID(), buyer = randomUUID(), supplier = randomUUID(), variant = randomUUID();
const period = { from: "2026-09-07T00:00:00Z", to: "2026-09-28T00:00:00Z" };
let serial = 0;
let service: AnalyticsService;
async function touch(occurred = period.from, expires = new Date(Date.parse(occurred) + 30 * 86400000).toISOString(), seller = partner) {
  const id = randomUUID();
  await pool!.query(`INSERT INTO attribution_touches (id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,occurred_at,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, buyer, seller, randomUUID(), randomUUID().replaceAll("-", "").repeat(2), occurred, expires]);
  return id;
}
async function order(created: string, status = "COMPLETED", eligible = true, touchId: string | null = null, seller = partner,
  settlement: number | null = 600, quantity = 2) {
  const id = randomUUID(), itemId = randomUUID();
  await pool!.query(`INSERT INTO orders (id,public_number,buyer_user_id,supplier_id,attribution_touch_id,partner_id_snapshot,
    commission_eligible_snapshot,status,currency,subtotal_minor,total_minor,sales_terms_document_id,privacy_document_id,
    sales_terms_accepted_at,privacy_acknowledged_at,idempotency_key,request_fingerprint,created_at,shipped_at,delivered_at,completed_at)
    VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::"OrderStatus",'BYN',$9,$9,$10,$10,now(),now(),$1::uuid::text,$11,$12::timestamptz,
      CASE WHEN $8::text IN ('SHIPPED','DELIVERED','COMPLETED','DELIVERY_FAILED') THEN $12::timestamptz END,
      CASE WHEN $8::text IN ('DELIVERED','COMPLETED') THEN $12::timestamptz END,
      CASE WHEN $8::text='COMPLETED' THEN $12::timestamptz+interval '1 day' END)`,
  [id, `W-${String(++serial).padStart(12, "0")}`, buyer, supplier, touchId, touchId ? seller : null, eligible && !!touchId,
    status, quantity * 1000, randomUUID(), "a".repeat(64), created]);
  await pool!.query(`INSERT INTO order_items (id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,
    partner_commission_unit_snapshot_minor,supplier_settlement_unit_snapshot_minor,line_total_minor)
    VALUES ($1::uuid,$2,$3,$1::uuid::text,'Watch',$4::int,1000,100,$5,$4::int*1000)`, [itemId, id, variant, quantity, settlement]);
  return { id, itemId };
}
async function returned(orderId: string, itemId: string, quantity: number, status = "COMPLETED") {
  const id = randomUUID();
  await pool!.query("INSERT INTO returns (id,order_id,status,reason,created_by_admin_user_id) VALUES ($1,$2,$3,'Test',$4)", [id, orderId, status, buyer]);
  await pool!.query("INSERT INTO return_items (id,return_id,order_id,order_item_id,quantity) VALUES ($1,$2,$3,$4,$5)",
    [randomUUID(), id, orderId, itemId, quantity]);
}
describe.skipIf(!pool)("T35 Analytics against PostgreSQL", () => {
  it("returns N/A for empty denominators and no fabricated contribution", async () => {
    expect(await service.summary(period)).toMatchObject({ orders: 0, activeSellingPartners: 0, touchConversionRate: null,
      deliveryRate: null, ordersPerTouch: null, firstSale: { partners: 0, averageSeconds: null },
      contribution: { coverageRate: null, settlementMarginMinor: null, fullContributionMinor: null } });
    expect(await service.dashboard()).toMatchObject({ overdueConfigured: false, actionable: { overdueOrders: 0, inventoryDeficits: 0 } });
  });
  it("uses exact touch cohorts, distinct conversion, expiry and half-open boundaries", async () => {
    const t = await touch(), unused = await touch(), expired = await touch();
    await order("2026-09-07T01:00:00Z", "PLACED", true, t);
    await order("2026-10-01T00:00:00Z", "PLACED", true, t); // Outside order period, inside touch expiry.
    await order("2026-10-07T00:00:00Z", "PLACED", true, t); // At expiry: excluded.
    await order("2026-10-07T00:00:00Z", "PLACED", true, expired);
    const outside = await touch("2026-09-06T23:59:59Z");
    await order("2026-09-08T01:00:00Z", "PLACED", true, outside);
    await touch(period.to);
    const s = await service.summary(period);
    expect(s).toMatchObject({ referralTouches: 3, convertedTouches: 1, referralOrders: 2, touchConversionRate: 1 / 3, ordersPerTouch: 2 / 3 });
    await order("2026-10-02T00:00:00Z", "PLACED", true, unused);
    await order("2026-10-03T00:00:00Z", "PLACED", true, unused);
    expect((await service.summary(period)).ordersPerTouch).toBeGreaterThan(1);
  });
  it("excludes ineligible sellers, distinguishes partial/full/open returns and financial coverage", async () => {
    const t = await touch(), blocked = await touch(period.from, "2026-10-07T00:00:00Z", otherPartner);
    const partial = await order("2026-09-08T00:00:00Z", "COMPLETED", true, t);
    const full = await order("2026-09-09T00:00:00Z", "COMPLETED", true, t);
    await order("2026-09-10T00:00:00Z", "COMPLETED", false, blocked, otherPartner, null);
    await returned(partial.id, partial.itemId, 1);
    await returned(partial.id, partial.itemId, 1, "OPEN");
    await returned(full.id, full.itemId, 2);
    await order("2026-09-11T00:00:00Z", "CANCELLED");
    await order("2026-09-12T00:00:00Z", "DELIVERY_FAILED");
    await pool!.query(`INSERT INTO commissions (id,partner_id,order_id,order_item_id,quantity,unit_amount_minor,gross_amount_minor,reversed_amount_minor,state)
      VALUES ($1,$2,$3,$4,2,100,200,100,'EARNED')`, [randomUUID(), partner, partial.id, partial.itemId]);
    const s = await service.summary(period);
    expect(s).toMatchObject({ orders: 5, retainedCompletedOrders: 2, activeSellingPartners: 1, retainedOrdersPerActivePartner: 1,
      deliveredOrders: 3, shippedOrders: 4, returnedOrders: 2, deliveryRate: 3 / 5, cancellationRate: 1 / 5,
      deliveryFailureRate: 1 / 4, returnRate: 2 / 3, netPartnerCommissionMinor: 100,
      contribution: { retainedUnits: 3, coveredUnits: 1, coverageRate: 1 / 3, coveredSettlementMarginMinor: 300, settlementMarginMinor: null } });
    await pool!.query("UPDATE order_items SET supplier_settlement_unit_snapshot_minor=600 WHERE supplier_settlement_unit_snapshot_minor IS NULL");
    expect((await service.summary(period)).contribution).toMatchObject({ coverageRate: 1, settlementMarginMinor: 1100, fullContributionMinor: null });
  });
  it("uses first acceptance, historical first retained sale and consecutive full local weeks", async () => {
    await pool!.query(`INSERT INTO partner_terms_acceptances (partner_id,legal_document_id,accepted_at)
      VALUES ($1,$2,'2026-09-01T00:00:00Z'),($1,$3,'2026-09-08T00:00:00Z')`, [partner, randomUUID(), randomUUID()]);
    const t = await touch();
    await order("2026-09-08T00:00:00Z", "COMPLETED", true, t);
    await order("2026-09-15T00:00:00Z", "COMPLETED", true, t);
    await order("2026-09-22T00:00:00Z", "COMPLETED", false, t);
    const s = await service.summary(period);
    expect(s.firstSale).toEqual({ partners: 1, averageSeconds: 8 * 86400 });
    expect(s.weeklyRetention).toEqual([{ week: "2026-09-07", activePartners: 1, retainedPartners: 1, rate: 1 },
      { week: "2026-09-14", activePartners: 1, retainedPartners: 0, rate: 0 }]);
    const local = new AnalyticsService(pool!, "BYN", "Europe/Minsk");
    const localPeriod = { from: "2026-09-06T21:00:00Z", to: "2026-09-20T21:00:00Z" };
    expect((await local.summary(localPeriod)).weeklyRetention).toEqual([{ week: "2026-09-07", activePartners: 1, retainedPartners: 1, rate: 1 }]);
    const outside = await order("2026-09-01T00:00:00Z", "COMPLETED", true, t);
    expect((await service.summary(period)).firstSale.partners).toBe(0);
    await returned(outside.id, outside.itemId, 2);
    expect((await service.summary(period)).firstSale.partners).toBe(1);
  });
  it("includes accrued PENDING commission and subtracts completed reversals", async () => {
    const t = await touch();
    const placed = await order("2026-09-08T00:00:00Z", "PLACED", true, t);
    await pool!.query(`INSERT INTO commissions (id,partner_id,order_id,order_item_id,quantity,unit_amount_minor,gross_amount_minor,state)
      VALUES ($1,$2,$3,$4,2,100,200,'PENDING')`, [randomUUID(), partner, placed.id, placed.itemId]);
    expect((await service.summary(period)).netPartnerCommissionMinor).toBe(200);
    await pool!.query("UPDATE commissions SET state='HOLD',reversed_amount_minor=100");
    expect((await service.summary(period)).netPartnerCommissionMinor).toBe(100);
    await pool!.query("UPDATE commissions SET state='VOID',reversed_amount_minor=200");
    expect((await service.summary(period)).netPartnerCommissionMinor).toBe(0);
  });
  it("reports current DB operations and does not keep recovered sync failures actionable", async () => {
    await order("2026-09-08T00:00:00Z", "PLACED");
    await pool!.query(`INSERT INTO inventory_sync_runs (id,provider_key,status,started_at) VALUES ($1,'test','FAILED',now()-interval '1 hour')`, [randomUUID()]);
    await pool!.query("INSERT INTO telegram_updates (update_id,payload,status) VALUES (1,'{}','FAILED')");
    const product = randomUUID();
    await pool!.query("INSERT INTO products (id,supplier_id,title,slug) VALUES ($1,$2,'Watch',$1::uuid::text)", [product, supplier]);
    const stale = randomUUID(), unknown = randomUUID();
    for (const id of [variant, stale, unknown]) await pool!.query(`INSERT INTO product_variants
      (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key) VALUES ($1::uuid,$2,$1::uuid::text,1000,'BYN',0,$1::uuid::text)`, [id, product]);
    await pool!.query(`INSERT INTO inventory_items (variant_id,source_quantity,safety_buffer,source_status,last_successful_sync_at)
      VALUES ($1,0,1,'OK',now()),($2,0,1,'OK',now()-interval '1 day')`, [variant, stale]);
    const shipped = await order("2026-09-08T00:00:00Z", "SHIPPED");
    await pool!.query(`INSERT INTO inventory_reservations (id,order_id,variant_id,quantity) VALUES ($1,$2,$3,1)`, [randomUUID(), shipped.id, variant]);
    await pool!.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,status)
      VALUES ($1::uuid,'test','Order',$2,$1::uuid::text,'{}','FAILED')`, [randomUUID(), shipped.id]);
    const configured = new AnalyticsService(pool!, "BYN", "UTC", 600, 3600);
    expect(await configured.dashboard()).toMatchObject({ summaries: { orders: 2, variants: 3 }, actionable: {
      overdueOrders: 2, placedOrders: 1, reconciliationPending: 1, failedSyncs: 1, failedTelegramUpdates: 1,
      failedEvents: 1, inventoryDeficits: 1, staleInventory: 1, unknownInventory: 1 } });
    await pool!.query("INSERT INTO inventory_sync_runs (id,provider_key,status) VALUES ($1,'test','SUCCESS')", [randomUUID()]);
    expect((await configured.dashboard()).actionable.failedSyncs).toBe(0);
  });
});
beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const table of tables.filter(table => table !== "return_items")) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  const existing = (await pool.query("SELECT to_regclass('public.return_items') AS name")).rows[0].name;
  if (existing) await pool.query("CREATE TABLE return_items (LIKE public.return_items INCLUDING ALL)");
  else {
    await pool.query(`DROP INDEX IF EXISTS ${schema}.returns_status_created_at_id_idx`);
    await pool.query(await readFile(new URL("../../../../packages/db/prisma/migrations/20261002000000_returns/migration.sql", import.meta.url), "utf8"));
  }
  await pool.query(`DROP INDEX IF EXISTS ${schema}.orders_created_at_idx; DROP INDEX IF EXISTS ${schema}.attribution_touches_occurred_at_idx`);
  await pool.query(await readFile(new URL("../../../../packages/db/prisma/migrations/20261004000000_analytics_cohorts/migration.sql", import.meta.url), "utf8"));
  service = new AnalyticsService(pool, "BYN");
});
beforeEach(async () => { if (pool) await pool.query(`TRUNCATE ${tables.join(",")}`); });
afterAll(async () => { if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); } });
