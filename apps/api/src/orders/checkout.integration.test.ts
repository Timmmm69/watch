import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CheckoutService } from "./checkout.js";
import { CartService } from "../cart/cart.js";
import { CatalogService } from "../catalog/catalog.js";
import { InventoryService } from "../inventory/service.js";
import { ReferralService } from "../referral/referral.js";
import { LegalDocuments } from "../legal/legal.js";
import { createApp } from "../app.js";
import { SessionStore, hashSessionToken } from "../auth/session.js";
import { deriveCsrfToken } from "../auth/middleware.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `checkout_test_${randomUUID().replaceAll("-", "")}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema},public` }) : null;
const buyers = [randomUUID(), randomUUID()];
const partnerUser = randomUUID(), partner = randomUUID(), touch = randomUUID(), supplier = randomUUID(), product = randomUUID();
const variants = [randomUUID(), randomUUID()].sort();
const docs = { SALES_TERMS: { id: randomUUID(), version: "checkout-sales" },
  PRIVACY: { id: randomUUID(), version: "checkout-privacy" }, PARTNER_TERMS: { id: randomUUID(), version: "checkout-partner" } };
const currency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";
let service: CheckoutService;
function request(items = [{ variantId: variants[0]!, quantity: 1, expectedUnitPriceMinor: 1000 }]) {
  return { items, recipientName: "Buyer Name", phone: "+375 (29) 123-45-67", address: "Minsk, address", comment: "Private comment",
    salesTermsDocumentId: docs.SALES_TERMS.id, privacyDocumentId: docs.PRIVACY.id, salesTermsAccepted: true, privacyAcknowledged: true };
}
beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const table of ["users", "sessions", "referral_links", "platform_settings", "suppliers", "partners", "partner_terms_acceptances", "legal_documents",
    "products", "product_variants", "inventory_items", "inventory_sync_runs", "attribution_touches", "events"]) {
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  for (const migration of ["20260930100000_cart", "20260930110000_orders"]) {
    await pool.query(await readFile(new URL(`../../../../packages/db/prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"));
  }
  await pool.query("INSERT INTO platform_settings (singleton_id, platform_currency) VALUES (1,$1)", [currency]);
  for (const id of [...buyers, partnerUser]) await pool.query("INSERT INTO users (id,telegram_user_id,first_name) VALUES ($1,$2,'Buyer')",
    [id, String(BigInt(`0x${id.replaceAll("-", "").slice(0, 15)}`))]);
  await pool.query("INSERT INTO suppliers (id,name) VALUES ($1,'Checkout supplier')", [supplier]);
  await pool.query("INSERT INTO products (id,supplier_id,title,slug,status) VALUES ($1,$2,'Watch',$1::uuid::text,'ACTIVE')", [product, supplier]);
  for (const id of variants) {
    await pool.query(`INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,
      supplier_settlement_unit_minor,inventory_external_key,status,attributes) VALUES ($1,$2,$1::uuid::text,1000,$3,100,500,$1::uuid::text,'ACTIVE','{"size":"M"}')`, [id, product, currency]);
    await pool.query("INSERT INTO inventory_items (variant_id,source_quantity,source_status,last_successful_sync_at) VALUES ($1,10,'OK',now())", [id]);
  }
  await pool.query("INSERT INTO partners (id,user_id) VALUES ($1,$2)", [partner, partnerUser]);
  for (const [type, doc] of Object.entries(docs)) await pool.query(`INSERT INTO legal_documents
    (id,type,version,sha256,content_markdown,effective_at,requires_reacceptance) VALUES ($1,$2,$3,$4,'# terms',now(),true)`,
  [doc.id, type, doc.version, randomBytes(32).toString("hex")]);
  service = new CheckoutService(pool, currency, docs);
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE orders, carts, events, attribution_touches, referral_links, sessions, partner_terms_acceptances CASCADE");
  await pool.query("UPDATE users SET is_blocked=false");
  await pool.query("UPDATE partners SET status='ACTIVE', user_id=$1", [partnerUser]);
  await pool.query("UPDATE products SET status='ACTIVE', title='Watch'");
  await pool.query("UPDATE product_variants SET status='ACTIVE', price_minor=1000, partner_commission_unit_minor=100, supplier_settlement_unit_minor=500");
  await pool.query("UPDATE inventory_items SET source_quantity=10, safety_buffer=0, source_status='OK', last_successful_sync_at=now()");
  await pool.query("INSERT INTO partner_terms_acceptances (partner_id,legal_document_id) VALUES ($1,$2)", [partner, docs.PARTNER_TERMS.id]);
  for (const buyer of buyers) {
    const cart = randomUUID();
    await pool.query("INSERT INTO carts (id,buyer_user_id) VALUES ($1,$2)", [cart, buyer]);
    await pool.query("INSERT INTO cart_items (cart_id,variant_id,quantity) VALUES ($1,$2,1)", [cart, variants[0]]);
  }
});
afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});
async function noSideEffects() {
  for (const table of ["orders", "order_items", "order_fulfillment_details", "inventory_reservations", "events"]) {
    expect((await pool!.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
  }
  expect((await pool!.query("SELECT count(*)::int AS count FROM cart_items")).rows[0].count).toBe(2);
}
async function addTouch() {
  await pool!.query(`INSERT INTO attribution_touches (id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+interval '30 days')`, [touch, buyers[0], partner, randomUUID(), randomBytes(32).toString("hex")]);
}

// Observe an actual PostgreSQL lock wait, so these tests cannot pass with sequential requests.
async function waitForBlocker(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool!.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid]);
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No PostgreSQL waiter observed for blocker ${pid}`);
}

async function mutationFirst(lock: string, change: string, input = request()) {
  const writer = await pool!.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN");
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await writer.query(lock); await writer.query(change);
    pending = service.checkout(buyers[0]!, "race", input).then((value) => ({ value }), (error: unknown) => ({ error }));
    await waitForBlocker(pid);
    await writer.query("COMMIT");
    return await pending;
  } finally {
    await writer.query("ROLLBACK"); writer.release(); await pending;
  }
}

const productLock = `SELECT id FROM products WHERE id='${product}' FOR UPDATE`;
const variantLock = `${productLock}; SELECT id FROM product_variants WHERE id='${variants[0]}' FOR UPDATE`;
const partnerLock = `SELECT id FROM partners WHERE id='${partner}' FOR UPDATE`;
const inventoryLock = `SELECT id FROM product_variants ORDER BY id FOR UPDATE; SELECT variant_id FROM inventory_items ORDER BY variant_id FOR UPDATE`;
const races = [
  { name: "Product archive", lock: productLock, change: "UPDATE products SET status='ARCHIVED'", code: "CART_CHANGED" },
  { name: "Variant archive", lock: variantLock, change: "UPDATE product_variants SET status='ARCHIVED'", code: "CART_CHANGED" },
  { name: "price", lock: variantLock, change: "UPDATE product_variants SET price_minor=2000", code: "PRICE_CHANGED" },
  { name: "commission and settlement", lock: variantLock,
    change: "UPDATE product_variants SET partner_commission_unit_minor=200,supplier_settlement_unit_minor=800", code: null },
  { name: "Partner block", lock: partnerLock, change: "UPDATE partners SET status='BLOCKED'", code: null },
  { name: "inventory source apply", lock: inventoryLock, change: "UPDATE inventory_items SET source_quantity=0,source_version='new',last_successful_sync_at=now()", code: "OUT_OF_STOCK" }
];

describe.skipIf(!databaseUrl)("Atomic checkout against PostgreSQL", () => {
  it.each(races)("$name first makes waiting checkout observe the committed state", async ({ lock, change, code, name }) => {
    await addTouch();
    const outcome = await mutationFirst(lock, change);
    if (code) {
      expect(outcome).toMatchObject({ error: { code, ...(code === "CART_CHANGED" ? { details: { reason: "ITEM_UNAVAILABLE", affectedVariantIds: [variants[0]] } } : {}) } });
      await noSideEffects();
    } else {
      expect(outcome).toMatchObject({ value: { created: true } });
      if (name === "Partner block") expect((await pool!.query("SELECT commission_eligible_snapshot FROM orders")).rows[0].commission_eligible_snapshot).toBe(false);
      else expect((await pool!.query("SELECT * FROM order_items")).rows[0]).toMatchObject({ partner_commission_unit_snapshot_minor: 200, supplier_settlement_unit_snapshot_minor: 800 });
    }
  });
  it.each(races)("checkout first serializes $name behind the complete old snapshot", async ({ lock, change }) => {
    await addTouch();
    const gate = await pool!.connect(), writer = await pool!.connect();
    let checkout: Promise<unknown> | undefined, mutation: Promise<unknown> | undefined;
    try {
      await gate.query("BEGIN");
      const gatePid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await gate.query("SELECT variant_id FROM inventory_items ORDER BY variant_id FOR UPDATE");
      checkout = service.checkout(buyers[0]!, "checkout-first", request()).then((value) => ({ value }), (error: unknown) => ({ error }));
      const checkoutPid = await waitForBlocker(gatePid);
      mutation = (async () => { await writer.query("BEGIN"); await writer.query(lock); await writer.query(change); await writer.query("COMMIT"); })();
      const mutationOutcome = mutation.then(() => ({ ok: true }), (error: unknown) => ({ error }));
      await waitForBlocker(checkoutPid);
      await gate.query("COMMIT");
      expect(await checkout).toMatchObject({ value: { created: true } });
      expect(await mutationOutcome).toEqual({ ok: true });
      expect((await pool!.query("SELECT commission_eligible_snapshot FROM orders")).rows[0].commission_eligible_snapshot).toBe(true);
      expect((await pool!.query("SELECT * FROM order_items")).rows[0]).toMatchObject({ unit_price_minor: 1000,
        partner_commission_unit_snapshot_minor: 100, supplier_settlement_unit_snapshot_minor: 500 });
      expect((await pool!.query("SELECT count(*)::int AS count FROM inventory_reservations WHERE status='ACTIVE'")).rows[0].count).toBe(1);
    } finally {
      await gate.query("ROLLBACK"); gate.release();
      await checkout; await mutation?.catch(() => undefined); await writer.query("ROLLBACK"); writer.release();
    }
  });
  it("Cart mutation first is observed by waiting checkout without losing its new quantity", async () => {
    expect(await mutationFirst("SELECT id FROM carts ORDER BY id FOR UPDATE", "UPDATE cart_items SET quantity=2"))
      .toMatchObject({ error: { code: "CART_CHANGED" } });
    await noSideEffects();
    expect((await new CartService(pool!, currency).read(buyers[0]!)).items[0]!.quantity).toBe(2);
  });
  it("Cart mutation after checkout waits and keeps the newly added line after Cart clear", async () => {
    const gate = await pool!.connect(); let checkout: Promise<unknown> | undefined, mutation: Promise<unknown> | undefined;
    try {
      await gate.query("BEGIN");
      const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await gate.query(productLock);
      checkout = service.checkout(buyers[0]!, "cart-first", request()).then((value) => ({ value }), (error: unknown) => ({ error }));
      const checkoutPid = await waitForBlocker(pid);
      mutation = new CartService(pool!, currency).put(buyers[0]!, variants[0]!, 2);
      const outcome = mutation.then((value) => ({ value }), (error: unknown) => ({ error }));
      await waitForBlocker(checkoutPid); await gate.query("COMMIT");
      expect(await checkout).toMatchObject({ value: { created: true } });
      expect(await outcome).toMatchObject({ value: { items: [{ quantity: 2 }] } });
      expect((await pool!.query("SELECT quantity FROM order_items")).rows[0].quantity).toBe(1);
      expect((await new CartService(pool!, currency).read(buyers[0]!)).items[0]!.quantity).toBe(2);
    } finally { await gate.query("ROLLBACK"); gate.release(); await checkout; await mutation?.catch(() => undefined); }
  });
  it.each([true, false])("referral touch and checkout follow Buyer commit order: touch first=%s", async (touchFirst) => {
    const link = randomUUID(), linkToken = randomBytes(24).toString("base64url");
    await pool!.query("INSERT INTO referral_links (id,token,partner_id) VALUES ($1,$2,$3)", [link, linkToken, partner]);
    const referral = new ReferralService(pool!, new LegalDocuments(pool!, docs), "test_bot");
    const launch = await pool!.connect(), gate = await pool!.connect();
    let checkout: Promise<unknown> | undefined, attribution: Promise<unknown> | undefined;
    try {
      await launch.query("BEGIN");
      await gate.query("BEGIN");
      const launchPid = (await launch.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const gatePid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const buyerLock = "SELECT id FROM users WHERE id=$1 FOR UPDATE";
      const applyTouch = () => referral.processLaunch(launch, { id: buyers[0]!, telegramUserId: "42", firstName: "Buyer", lastName: null,
        username: null, languageCode: null, isAdmin: false, isBlocked: false }, { telegramUserId: "42", firstName: "Buyer", lastName: null,
        username: null, languageCode: null, startParam: `r_${linkToken}`, replayIdentity: randomBytes(32).toString("hex") });
      if (touchFirst) {
        await launch.query(buyerLock, [buyers[0]]); await applyTouch();
        checkout = service.checkout(buyers[0]!, "touch-race", request()).then((value) => ({ value }), (error: unknown) => ({ error }));
        await waitForBlocker(launchPid); await launch.query("COMMIT");
      } else {
        await gate.query(productLock);
        checkout = service.checkout(buyers[0]!, "touch-race", request()).then((value) => ({ value }), (error: unknown) => ({ error }));
        const checkoutPid = await waitForBlocker(gatePid);
        attribution = (async () => { await launch.query(buyerLock, [buyers[0]]); await applyTouch(); await launch.query("COMMIT"); })();
        const outcome = attribution.then(() => ({ ok: true }), (error: unknown) => ({ error }));
        await waitForBlocker(checkoutPid); await gate.query("COMMIT"); expect(await outcome).toEqual({ ok: true });
      }
      expect(await checkout).toMatchObject({ value: { created: true } });
      const snapshot = (await pool!.query("SELECT attribution_touch_id,commission_eligible_snapshot FROM orders")).rows[0];
      const newTouch = (await pool!.query("SELECT id FROM attribution_touches")).rows[0].id;
      expect(snapshot).toEqual({ attribution_touch_id: touchFirst ? newTouch : null, commission_eligible_snapshot: touchFirst });
    } finally {
      await gate.query("ROLLBACK"); gate.release(); await checkout; await attribution?.catch(() => undefined);
      await launch.query("ROLLBACK"); launch.release();
    }
  });
  it("concurrent different fingerprints with one key produce exactly one winner and one conflict", async () => {
    const results = await Promise.allSettled([request(), { ...request(), address: "Other address" }]
      .map((input) => service.checkout(buyers[0]!, "conflict-race", input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "IDEMPOTENCY_CONFLICT" } });
    for (const table of ["orders", "order_items", "inventory_reservations", "events"]) {
      expect((await pool!.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(1);
    }
  });
  it("opposite multi-line request orders use deterministic locks and never partially reserve", async () => {
    await pool!.query("UPDATE inventory_items SET source_quantity=1");
    await pool!.query("INSERT INTO cart_items (cart_id,variant_id,quantity) SELECT id,$1,1 FROM carts", [variants[1]]);
    const lines = variants.map((variantId) => ({ variantId, quantity: 1, expectedUnitPriceMinor: 1000 }));
    const results = await Promise.allSettled(buyers.map((buyer, index) => service.checkout(buyer, "multi-line", request(index ? [...lines].reverse() : lines))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "OUT_OF_STOCK" } });
    expect((await pool!.query("SELECT count(*)::int AS count FROM orders")).rows[0].count).toBe(1);
    expect((await pool!.query("SELECT variant_id,SUM(quantity)::int AS quantity FROM inventory_reservations GROUP BY variant_id ORDER BY variant_id")).rows)
      .toEqual(variants.map((variant_id) => ({ variant_id, quantity: 1 })));
    const loser = buyers[results.findIndex((result) => result.status === "rejected")]!;
    expect((await new CartService(pool!, currency).read(loser)).items).toHaveLength(2);
  });
  it("real sessions isolate CSRF, Cart ownership and same-key Orders across Buyers", async () => {
    const secret = Buffer.alloc(32, 9);
    const sessions = buyers.map((buyer) => ({ buyer, id: randomUUID(), token: randomBytes(32).toString("base64url") }));
    for (const session of sessions) await pool!.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",
      [session.id, session.buyer, hashSessionToken(session.token)]);
    const app = createApp({ logger: false, checkReadiness: async () => undefined, checkout: service,
      auth: { store: new SessionStore(pool!, new Set()), csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set() } });
    const headers = (index: number) => ({ cookie: `watch_session=${sessions[index]!.token}`, origin: "https://app.example",
      "x-csrf-token": deriveCsrfToken(secret, sessions[index]!.id), "idempotency-key": "shared-key" });
    try {
      expect((await app.inject({ method: "POST", url: "/api/v1/orders", payload: request(),
        headers: { ...headers(1), "x-csrf-token": headers(0)["x-csrf-token"] } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/orders", payload: { ...request(), buyerUserId: buyers[0] }, headers: headers(1) })).statusCode).toBe(400);
      await noSideEffects();
      const first = await app.inject({ method: "POST", url: "/api/v1/orders", payload: request(), headers: headers(0) });
      expect(first.statusCode).toBe(201);
      expect((await new CartService(pool!, currency).read(buyers[1]!)).items).toHaveLength(1);
      const second = await app.inject({ method: "POST", url: "/api/v1/orders", payload: request(), headers: headers(1) });
      expect(second.statusCode).toBe(201); expect(second.json().id).not.toBe(first.json().id);
      const replay = await app.inject({ method: "POST", url: "/api/v1/orders", payload: request(), headers: headers(1) });
      expect(replay.statusCode).toBe(200); expect(replay.json().id).toBe(second.json().id);
      expect((await pool!.query("SELECT count(*)::int AS count FROM events")).rows[0].count).toBe(2);
    } finally { await app.close(); }
  });
  it("creates all snapshots, ACTIVE reservation, legal evidence and one safe event, then clears only this Buyer's Cart", async () => {
    await addTouch();
    const result = await service.checkout(buyers[0]!, "success", request());
    expect(result.created).toBe(true);
    expect(result.order).toMatchObject({ status: "PLACED", totalMinor: 1000, currency });
    expect(result.order.salesTermsAcceptedAt).toBe(result.order.createdAt);
    expect(result.order.privacyAcknowledgedAt).toBe(result.order.createdAt);
    const order = (await pool!.query("SELECT * FROM orders")).rows[0];
    expect(order).toMatchObject({ attribution_touch_id: touch, partner_id_snapshot: partner, commission_eligible_snapshot: true });
    expect((await pool!.query("SELECT * FROM order_items")).rows[0]).toMatchObject({ sku_snapshot: variants[0], title_snapshot: "Watch",
      attributes_snapshot: { size: "M" }, unit_price_minor: 1000, partner_commission_unit_snapshot_minor: 100, supplier_settlement_unit_snapshot_minor: 500 });
    expect((await pool!.query("SELECT * FROM inventory_reservations")).rows[0]).toMatchObject({ status: "ACTIVE", quantity: 1 });
    expect((await pool!.query("SELECT * FROM order_fulfillment_details")).rows[0]).toMatchObject({ phone: "375291234567", comment: "Private comment" });
    expect((await pool!.query("SELECT type,payload FROM events")).rows).toEqual([{ type: "ORDER_CREATED", payload: {
      v: 1, orderId: order.id, publicNumber: order.public_number, partnerIdSnapshot: partner, commissionEligibleSnapshot: true } }]);
    expect((await new CartService(pool!, currency).read(buyers[0]!)).items).toEqual([]);
    expect((await new CartService(pool!, currency).read(buyers[1]!)).items).toHaveLength(1);
    expect((await pool!.query("SELECT source_quantity FROM inventory_items WHERE variant_id=$1", [variants[0]])).rows[0].source_quantity).toBe(10);
  });
  it("serializes concurrent same-key requests before the cleared Cart, canonical replay, and conflicting fingerprints", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => service.checkout(buyers[0]!, "same", request())));
    expect(new Set(results.map((result) => result.order.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await service.checkout(buyers[0]!, "same", { ...request(), phone: "375291234567", recipientName: " Buyer Name " })).created).toBe(false);
    expect((await new CheckoutService(pool!, currency, {}).checkout(buyers[0]!, "same", request())).order.id).toBe(results[0]!.order.id);
    await expect(service.checkout(buyers[0]!, "same", { ...request(), address: "Other address" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    for (const table of ["orders", "inventory_reservations", "events"]) expect((await pool!.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(1);
  });
  it("reloads the whole commercial snapshot after waiting for an Admin Product/Variant mutation", async () => {
    const admin = await pool!.connect();
    let pending: ReturnType<CheckoutService["checkout"]> | undefined;
    try {
      await admin.query("BEGIN");
      const pid = (await admin.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await admin.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [product]);
      await admin.query("SELECT id FROM product_variants WHERE id=$1 FOR UPDATE", [variants[0]]);
      await admin.query("UPDATE products SET title='New watch' WHERE id=$1", [product]);
      await admin.query("UPDATE product_variants SET price_minor=2000, partner_commission_unit_minor=200, supplier_settlement_unit_minor=800 WHERE id=$1", [variants[0]]);
      pending = service.checkout(buyers[0]!, "new-price", request());
      // Attach the rejection handler while PostgreSQL is blocked so no unhandled promise escapes.
      const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if ((await pool!.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await admin.query("COMMIT");
      expect(await outcome).toMatchObject({ error: { code: "PRICE_CHANGED" } });
      await noSideEffects();
      await service.checkout(buyers[0]!, "new-price", request([{ variantId: variants[0]!, quantity: 1, expectedUnitPriceMinor: 2000 }]));
      expect((await pool!.query("SELECT * FROM order_items")).rows[0]).toMatchObject({ title_snapshot: "New watch", unit_price_minor: 2000,
        partner_commission_unit_snapshot_minor: 200, supplier_settlement_unit_snapshot_minor: 800 });
    } finally {
      await admin.query("ROLLBACK"); admin.release();
      if (pending) await pending.catch(() => undefined);
    }
  });
  it("never oversells the last unit across Buyers; all availability projections deduct the reservation", async () => {
    await pool!.query("UPDATE inventory_items SET source_quantity=1 WHERE variant_id=$1", [variants[0]]);
    const results = await Promise.allSettled(buyers.map((buyer) => service.checkout(buyer, "last-unit", request())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "OUT_OF_STOCK" } });
    expect((await pool!.query("SELECT SUM(quantity)::int AS quantity FROM inventory_reservations")).rows[0].quantity).toBe(1);
    const loser = buyers[results.findIndex((result) => result.status === "rejected")]!;
    expect((await new CartService(pool!, currency).read(loser)).items[0]!.issues).toContain("OUT_OF_STOCK");
    await expect(new CartService(pool!, currency).put(loser, variants[0]!, 1)).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
    expect((await new CatalogService(pool!, currency).getStorefrontProduct(product)).variants.find((row) => row.id === variants[0])!.availability).toBe("OUT_OF_STOCK");
    const items = await new InventoryService(pool!).listItems({ page: 1, limit: 20 });
    expect(items.items.find((row) => row.variantId === variants[0])).toMatchObject({ activeReservations: 1, sellable: 0 });
  });
  it.each([
    ["UPDATE products SET status='ARCHIVED'", "CART_CHANGED"],
    ["UPDATE product_variants SET status='ARCHIVED'", "CART_CHANGED"],
    ["UPDATE product_variants SET price_minor=2000", "PRICE_CHANGED"],
    ["UPDATE cart_items SET quantity=2", "CART_CHANGED"],
    ["UPDATE inventory_items SET source_status='MISSING'", "INVENTORY_UNKNOWN"],
    ["UPDATE inventory_items SET last_successful_sync_at=now()-interval '601 seconds'", "INVENTORY_STALE"],
    ["UPDATE inventory_items SET safety_buffer=10", "OUT_OF_STOCK"],
    ["UPDATE product_variants SET partner_commission_unit_minor=2147483647, supplier_settlement_unit_minor=NULL; UPDATE cart_items SET quantity=2", "ORDER_TOTAL_LIMIT_EXCEEDED"],
    ["UPDATE product_variants SET price_minor=2147483647, partner_commission_unit_minor=0, supplier_settlement_unit_minor=2147483647; UPDATE cart_items SET quantity=2", "ORDER_TOTAL_LIMIT_EXCEEDED"]
  ])("rolls back %s with %s", async (sql, code) => {
    await pool!.query(sql);
    const input = request();
    if (code === "ORDER_TOTAL_LIMIT_EXCEEDED") {
      input.items[0]!.quantity = 2;
      if (sql.includes("price_minor=")) input.items[0]!.expectedUnitPriceMinor = 2147483647;
    }
    await expect(service.checkout(buyers[0]!, "failure", input)).rejects.toMatchObject({ code,
      ...(code === "CART_CHANGED" && sql.includes("ARCHIVED") ? { details: { reason: "ITEM_UNAVAILABLE", affectedVariantIds: [variants[0]] } } : {}) });
    await noSideEffects();
  });
  it("rejects aggregate totals above the guard before writing anything", async () => {
    await pool!.query("UPDATE product_variants SET price_minor=1100000000");
    await pool!.query("INSERT INTO cart_items (cart_id,variant_id,quantity) SELECT id,$2,1 FROM carts WHERE buyer_user_id=$1", [buyers[0], variants[1]]);
    await expect(service.checkout(buyers[0]!, "total", request(variants.map((id) => ({ variantId: id, quantity: 1, expectedUnitPriceMinor: 1_100_000_000 })))))
      .rejects.toMatchObject({ code: "ORDER_TOTAL_LIMIT_EXCEEDED" });
    expect((await pool!.query("SELECT count(*)::int AS count FROM orders")).rows[0].count).toBe(0);
    expect((await pool!.query("SELECT count(*)::int AS count FROM inventory_reservations")).rows[0].count).toBe(0);
  });
  it("rejects stale/missing/mistyped/future legal artifacts and absent acknowledgements with no side effects", async () => {
    await expect(service.checkout(buyers[0]!, "legal", { ...request(), salesTermsDocumentId: docs.PRIVACY.id })).rejects.toMatchObject({ code: "TERMS_VERSION_CHANGED" });
    await expect(service.checkout(buyers[0]!, "legal", { ...request(), privacyAcknowledged: false })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(new CheckoutService(pool!, currency, {}).checkout(buyers[0]!, "legal", request())).rejects.toMatchObject({ code: "TERMS_VERSION_CHANGED" });
    await expect(new CheckoutService(pool!, currency, { ...docs, SALES_TERMS: docs.PRIVACY }).checkout(buyers[0]!, "legal", request())).rejects.toMatchObject({ code: "TERMS_VERSION_CHANGED" });
    const future = randomUUID();
    await pool!.query(`INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at)
      VALUES ($1,'SALES_TERMS',$1::uuid::text,$2,'future',now()+interval '1 day')`, [future, randomBytes(32).toString("hex")]);
    await expect(new CheckoutService(pool!, currency, { ...docs, SALES_TERMS: { id: future, version: future } })
      .checkout(buyers[0]!, "legal", { ...request(), salesTermsDocumentId: future })).rejects.toMatchObject({ code: "TERMS_VERSION_CHANGED" });
    await noSideEffects();
  });
  it.each(["blocked-partner", "blocked-user", "stale-terms", "expired", "self"])("preserves appropriate attribution without commission: %s", async (state) => {
    await addTouch();
    if (state === "blocked-partner") await pool!.query("UPDATE partners SET status='BLOCKED'");
    if (state === "blocked-user") await pool!.query("UPDATE users SET is_blocked=true WHERE id=$1", [partnerUser]);
    if (state === "stale-terms") await pool!.query("DELETE FROM partner_terms_acceptances");
    if (state === "expired") await pool!.query("UPDATE attribution_touches SET occurred_at=now()-interval '31 days', expires_at=now()-interval '1 day'");
    if (state === "self") await pool!.query("UPDATE partners SET user_id=$1", [buyers[0]]);
    await service.checkout(buyers[0]!, "attribution", request());
    expect((await pool!.query("SELECT attribution_touch_id,commission_eligible_snapshot FROM orders")).rows[0])
      .toEqual({ attribution_touch_id: state === "expired" ? null : touch, commission_eligible_snapshot: false });
  });
  it("uses the shared BR-007 predicate when the current Partner Terms do not require reacceptance", async () => {
    await addTouch();
    await pool!.query("DELETE FROM partner_terms_acceptances");
    const id = randomUUID();
    await pool!.query(`INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at,requires_reacceptance)
      VALUES ($1,'PARTNER_TERMS',$1::uuid::text,$2,'optional reacceptance',now(),false)`, [id, randomBytes(32).toString("hex")]);
    await new CheckoutService(pool!, currency, { ...docs, PARTNER_TERMS: { id, version: id } }).checkout(buyers[0]!, "terms", request());
    expect((await pool!.query("SELECT commission_eligible_snapshot FROM orders")).rows[0].commission_eligible_snapshot).toBe(true);
  });
  it("rolls back the entire transaction on an Event insert failure", async () => {
    await pool!.query(`CREATE FUNCTION ${schema}.reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test event failure'; END $$`);
    await pool!.query(`CREATE TRIGGER reject_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_event()`);
    try {
      await expect(service.checkout(buyers[0]!, "rollback", request())).rejects.toThrow("test event failure");
      await noSideEffects();
    } finally { await pool!.query("DROP TRIGGER reject_event ON events"); }
    expect((await service.checkout(buyers[0]!, "rollback", request())).created).toBe(true);
  });
});
