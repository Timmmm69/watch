import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allowedAdminOrderTransitions, orderStatusSchema } from "@watch/contracts";
import { AdminOrderService } from "./admin.js";
import { CheckoutService } from "./checkout.js";

const url = process.env.TEST_DATABASE_URL;
const schema = `admin_orders_${randomUUID().replaceAll("-", "")}`;
const pool = url ? new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema},public` }) : null;
const buyer = randomUUID(), supplier = randomUUID(), product = randomUUID(), variant = randomUUID();
const docs = { SALES_TERMS: { id: randomUUID(), version: "t23-sales" }, PRIVACY: { id: randomUUID(), version: "t23-privacy" } };
const currency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";
let service: AdminOrderService;
let id: string;
beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const table of ["users", "platform_settings", "suppliers", "partners", "legal_documents", "products", "product_variants",
    "inventory_items", "inventory_sync_runs", "attribution_touches", "partner_terms_acceptances", "events", "audit_logs"])
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  for (const migration of ["20260930100000_cart", "20260930110000_orders"])
    await pool.query(await readFile(new URL(`../../../../packages/db/prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"));
  await pool.query("INSERT INTO platform_settings (singleton_id,platform_currency) VALUES (1,$1)", [currency]);
  await pool.query("INSERT INTO users (id,telegram_user_id,first_name) VALUES ($1,123,'Admin')", [buyer]);
  await pool.query("INSERT INTO suppliers (id,name) VALUES ($1,'Supplier')", [supplier]);
  await pool.query("INSERT INTO products (id,supplier_id,title,slug,status) VALUES ($1,$2,'Watch',$1::uuid::text,'ACTIVE')", [product,supplier]);
  await pool.query(`INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key,status)
    VALUES ($1,$2,'T23',1000,$3,0,'T23','ACTIVE')`, [variant,product,currency]);
  await pool.query("INSERT INTO inventory_items (variant_id,source_quantity,source_status,last_successful_sync_at) VALUES ($1,100,'OK',now())", [variant]);
  for (const [type, doc] of Object.entries(docs)) await pool.query(`INSERT INTO legal_documents
    (id,type,version,sha256,content_markdown,effective_at) VALUES ($1,$2,$3,$4,'Terms',now())`, [doc.id,type,doc.version,randomBytes(32).toString("hex")]);
  service = new AdminOrderService(pool,14,3600);
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE orders,carts,events,audit_logs CASCADE");
  const cart = randomUUID();
  await pool.query("INSERT INTO carts (id,buyer_user_id) VALUES ($1,$2)", [cart,buyer]);
  await pool.query("INSERT INTO cart_items (cart_id,variant_id,quantity) VALUES ($1,$2,1)", [cart,variant]);
  id = (await new CheckoutService(pool,currency,docs).checkout(buyer,randomUUID(), {
    items: [{ variantId: variant, quantity: 1, expectedUnitPriceMinor: 1000 }], recipientName: "Private Buyer",
    phone: "375291234567", address: "Private Address", comment: "Private Comment", salesTermsAccepted: true, privacyAcknowledged: true,
    salesTermsDocumentId: docs.SALES_TERMS.id, privacyDocumentId: docs.PRIVACY.id
  })).order.id;
});
afterAll(async () => { if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); } });

async function advance(...targets: ("CONFIRMED" | "FULFILLING" | "SHIPPED" | "DELIVERED")[]) {
  for (const target of targets) await service.transition(id,buyer,target);
}
async function counts() {
  return (await pool!.query(`SELECT (SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM audit_logs) AS audits`)).rows[0];
}
async function reserve() { return (await pool!.query("SELECT * FROM inventory_reservations WHERE order_id=$1", [id])).rows[0]; }

describe.skipIf(!pool)("Admin Order state machine against PostgreSQL", () => {
  it.each(orderStatusSchema.options)("checks every target from %s against the exact graph", async (from) => {
    for (const to of orderStatusSchema.options) {
      await pool!.query(`UPDATE orders SET status=$2,confirmed_at=NULL,fulfilling_at=NULL,shipped_at=NULL,delivered_at=NULL,
        cancelled_at=NULL,delivery_failed_at=NULL,completed_at=NULL,completion_eligible_at=NULL WHERE id=$1`, [id,from]);
      await pool!.query("UPDATE inventory_reservations SET status='ACTIVE',released_at=NULL WHERE order_id=$1", [id]);
      await pool!.query("DELETE FROM events WHERE type<>'ORDER_CREATED'");
      await pool!.query("TRUNCATE audit_logs");
      if (to === "COMPLETED") await expect(service.transition(id,buyer,to)).rejects.toMatchObject({ code: "SYSTEM_TRANSITION_ONLY" });
      else if (allowedAdminOrderTransitions[from].some((target) => target === to) || (from === to && to !== "PLACED"))
        expect((await service.transition(id,buyer,to)).status).toBe(to);
      else await expect(service.transition(id,buyer,to)).rejects.toMatchObject({ code: "INVALID_ORDER_TRANSITION" });
    }
  });
  it("sets timestamps once and freezes the configured hold on delivery across replays", async () => {
    await advance("CONFIRMED","FULFILLING","SHIPPED","DELIVERED");
    const first = await service.detail(id);
    expect(first.timeline.map((entry) => entry.status)).toEqual(["PLACED","CONFIRMED","FULFILLING","SHIPPED","DELIVERED"]);
    expect(Date.parse(first.completionEligibleAt!) - Date.parse(first.timeline[4]!.at)).toBe(14 * 86400000);
    const initial = await counts();
    const replay = await new AdminOrderService(pool!,30).transition(id,buyer,"DELIVERED");
    expect(replay.completionEligibleAt).toBe(first.completionEligibleAt);
    expect(replay.timeline).toEqual(first.timeline);
    expect(replay.updatedAt).toBe(first.updatedAt);
    expect(await counts()).toEqual(initial);
    expect((await reserve()).status).toBe("ACTIVE");
  });
  it.each([[],["CONFIRMED"],["CONFIRMED","FULFILLING"]] as const)("cancels pre-shipment and releases once from path %j", async (...path) => {
    await advance(...path);
    const cancelled = await service.transition(id,buyer,"CANCELLED","request-t23");
    const reservation = await reserve();
    expect(reservation.status).toBe("RELEASED");
    expect(reservation.released_at.toISOString()).toBe(cancelled.timeline.at(-1)!.at);
    expect(reservation.reconciliation_method).toBeNull();
    const initial = await counts();
    await service.transition(id,buyer,"CANCELLED");
    expect(await counts()).toEqual(initial);
    const events = (await pool!.query("SELECT type,dedupe_key,payload FROM events WHERE type<>'ORDER_CREATED' ORDER BY created_at,type")).rows;
    expect(events.filter((e) => e.type === "ORDER_CANCELLED")).toHaveLength(1);
    expect(events.at(-1)!.payload).not.toHaveProperty("phone");
    const audit = (await pool!.query("SELECT * FROM audit_logs WHERE request_id='request-t23'")).rows[0];
    expect(audit.actor_user_id).toBe(buyer); expect(audit.metadata.toStatus).toBe("CANCELLED");
  });
  it("shipment and failed delivery preserve ACTIVE reservations and emit the exact safe event pair", async () => {
    await advance("CONFIRMED","FULFILLING","SHIPPED");
    await expect(service.transition(id,buyer,"CANCELLED")).rejects.toMatchObject({ code: "INVALID_ORDER_TRANSITION" });
    await service.transition(id,buyer,"DELIVERY_FAILED");
    expect((await reserve()).status).toBe("ACTIVE");
    const events = (await pool!.query("SELECT type,dedupe_key,payload FROM events ORDER BY created_at,type")).rows;
    expect(events.map((e) => e.type)).toEqual(["ORDER_CREATED","ORDER_STATUS_CHANGED","ORDER_STATUS_CHANGED","ORDER_STATUS_CHANGED","ORDER_DELIVERY_FAILED","ORDER_STATUS_CHANGED"]);
    const generic = events.find((e) => e.payload.toStatus === "DELIVERY_FAILED")!;
    expect(Object.keys(generic.payload).sort()).toEqual(["fromStatus","orderId","publicNumber","toStatus","v"]);
    expect(new Set(events.map((e) => e.dedupe_key)).size).toBe(events.length);
    expect(JSON.stringify(events)).not.toMatch(/Private|375291234567/);
  });
  it("rolls back order, timestamps and reservation release when transactional event insertion fails", async () => {
    await pool!.query(`CREATE FUNCTION fail_t23_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='ORDER_CANCELLED' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_t23_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION fail_t23_event()`);
    try {
      await expect(service.transition(id,buyer,"CANCELLED")).rejects.toThrow("injected event failure");
      expect((await service.detail(id)).status).toBe("PLACED");
      expect((await reserve()).status).toBe("ACTIVE");
      expect(await counts()).toEqual({ events: 1, audits: 0 });
    } finally { await pool!.query("DROP TRIGGER fail_t23_event ON events; DROP FUNCTION fail_t23_event()"); }
  });
  it("fails conservatively if a pre-shipment reservation was already consumed", async () => {
    await pool!.query("UPDATE inventory_reservations SET status='CONSUMED',consumed_at=now() WHERE order_id=$1", [id]);
    await expect(service.transition(id,buyer,"CANCELLED")).rejects.toMatchObject({ code: "INTERNAL_INVARIANT_VIOLATION" });
    expect((await service.detail(id)).status).toBe("PLACED");
    expect(await counts()).toEqual({ events: 1, audits: 0 });
  });
  it("rolls back events and cancellation when AuditLog insertion fails", async () => {
    await pool!.query(`CREATE FUNCTION fail_t23_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected audit failure'; END $$;
      CREATE TRIGGER fail_t23_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_t23_audit()`);
    const originalItems = (await pool!.query("SELECT * FROM order_items WHERE order_id=$1", [id])).rows;
    try {
      await expect(service.transition(id,buyer,"CANCELLED")).rejects.toThrow("injected audit failure");
      expect((await service.detail(id)).status).toBe("PLACED");
      expect((await reserve()).status).toBe("ACTIVE");
      expect(await counts()).toEqual({ events: 1,audits: 0 });
      expect((await pool!.query("SELECT * FROM order_items WHERE order_id=$1", [id])).rows).toEqual(originalItems);
    } finally { await pool!.query("DROP TRIGGER fail_t23_audit ON audit_logs; DROP FUNCTION fail_t23_audit()"); }
  });
  it("serializes identical concurrent transitions without duplicate events or audits", async () => {
    const results = await Promise.all([service.transition(id,buyer,"CONFIRMED"),service.transition(id,buyer,"CONFIRMED")]);
    expect(results[0]!.timeline).toEqual(results[1]!.timeline);
    expect(await counts()).toEqual({ events: 2, audits: 1 });
  });
  it.each(["CANCELLED","SHIPPED"] as const)("serializes cancellation/shipment with %s committing first", async (first) => {
    await advance("CONFIRMED","FULFILLING");
    const blocker = await pool!.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [id]);
    const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const firstResult = service.transition(id,buyer,first).catch((error: unknown) => error);
    // Observe the real PostgreSQL waiter before queuing the competing transition.
    const deadline = Date.now() + 3000;
    let waiting = false;
    let secondResult: Promise<unknown> | undefined;
    try {
      while (Date.now() < deadline) {
        waiting = (await pool!.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [blockerPid])).rows[0].waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve,10));
      }
      if (waiting) secondResult = service.transition(id,buyer,first === "CANCELLED" ? "SHIPPED" : "CANCELLED").catch((error: unknown) => error);
    } finally { await blocker.query("COMMIT"); blocker.release(); }
    expect(await firstResult).toMatchObject({ status: first });
    expect(waiting).toBe(true);
    expect(await secondResult).toMatchObject({ code: "INVALID_ORDER_TRANSITION" });
    expect((await reserve()).status).toBe(first === "CANCELLED" ? "RELEASED" : "ACTIVE");
    expect((await service.detail(id)).status).toBe(first);
  });
  it("serves Admin detail snapshots, filters, pagination and operational overdue without cancellation", async () => {
    const detail = await service.detail(id);
    expect(detail.fulfillment).toMatchObject({ recipientName: "Private Buyer", address: "Private Address" });
    expect(detail.items[0]).toMatchObject({ sku: "T23", quantity: 1, lineTotalMinor: 1000 });
    expect(detail.reservations[0]).toMatchObject({ status: "ACTIVE", sourceStatus: "OK" });
    await pool!.query("UPDATE orders SET created_at=now()-interval '2 hours' WHERE id=$1", [id]);
    const query = { page: 1,limit: 20 };
    expect((await service.list({ ...query,overdue: true })).total).toBe(1);
    expect((await service.list({ ...query,number: detail.publicNumber })).total).toBe(1);
    expect((await service.list({ ...query,status: "SHIPPED" })).total).toBe(0);
    expect((await service.list({ ...query,dateFrom: new Date().toISOString() })).total).toBe(0);
    expect((await service.list({ ...query,page: 2 })).items).toHaveLength(0);
    expect((await service.list({ ...query,reconciliationPending: true })).total).toBe(0);
    await advance("CONFIRMED","FULFILLING","SHIPPED");
    expect((await service.list({ ...query,reconciliationPending: true })).total).toBe(1);
    expect((await service.detail(id)).overdue).toBe(false);
    expect((await new AdminOrderService(pool!).list({ ...query,overdue: true })).total).toBe(0);
    await expect(service.detail(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
