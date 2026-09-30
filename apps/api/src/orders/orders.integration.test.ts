import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePublicOrderNumber, insertWithPublicNumberRetry } from "./order-number.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `orders_test_${randomUUID().replaceAll("-", "")}`;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` })
  : null;

const buyer = randomUUID();
const otherBuyer = randomUUID();
const partnerUserA = randomUUID();
const partnerUserB = randomUUID();
const admin = randomUUID();
const supplier = randomUUID();
const partnerA = randomUUID();
const partnerB = randomUUID();
const salesTerms = randomUUID();
const privacy = randomUUID();
const touch = randomUUID();
const variants = [randomUUID(), randomUUID()];
const syncRun = randomUUID();
let currency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";

interface OrderOverrides {
  publicNumber?: string;
  buyerUserId?: string;
  attributionTouchId?: string | null;
  partnerIdSnapshot?: string | null;
  commissionEligibleSnapshot?: boolean;
  status?: string;
  currency?: string;
  subtotalMinor?: number;
  totalMinor?: number;
  salesTermsDocumentId?: string;
  privacyDocumentId?: string;
  idempotencyKey?: string;
}

interface StoredOrder {
  id: string;
  public_number: string;
  buyer_user_id: string;
  supplier_id: string;
  attribution_touch_id: string | null;
  partner_id_snapshot: string | null;
  commission_eligible_snapshot: boolean;
  status: string;
  currency: string;
  subtotal_minor: number;
  total_minor: number;
  sales_terms_document_id: string;
  privacy_document_id: string;
  sales_terms_accepted_at: Date;
  privacy_acknowledged_at: Date;
  idempotency_key: string;
  request_fingerprint: string;
  completion_eligible_at: Date | null;
  confirmed_at: Date | null;
  fulfilling_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  delivery_failed_at: Date | null;
}

async function insertOrder(overrides: OrderOverrides = {}): Promise<StoredOrder> {
  const row: StoredOrder = {
    id: randomUUID(),
    public_number: overrides.publicNumber ?? generatePublicOrderNumber(),
    buyer_user_id: overrides.buyerUserId ?? buyer,
    supplier_id: supplier,
    attribution_touch_id: overrides.attributionTouchId === undefined ? touch : overrides.attributionTouchId,
    partner_id_snapshot: overrides.partnerIdSnapshot === undefined ? partnerA : overrides.partnerIdSnapshot,
    commission_eligible_snapshot: overrides.commissionEligibleSnapshot ?? true,
    status: overrides.status ?? "PLACED",
    currency: overrides.currency ?? currency,
    subtotal_minor: overrides.subtotalMinor ?? 112_000,
    total_minor: overrides.totalMinor ?? 112_000,
    sales_terms_document_id: overrides.salesTermsDocumentId ?? salesTerms,
    privacy_document_id: overrides.privacyDocumentId ?? privacy,
    sales_terms_accepted_at: new Date(),
    privacy_acknowledged_at: new Date(),
    idempotency_key: overrides.idempotencyKey ?? randomUUID(),
    request_fingerprint: randomBytes(32).toString("hex"),
    completion_eligible_at: null,
    confirmed_at: null,
    fulfilling_at: null,
    shipped_at: null,
    delivered_at: null,
    completed_at: null,
    cancelled_at: null,
    delivery_failed_at: null
  };
  await pool!.query(
    `INSERT INTO orders (id, public_number, buyer_user_id, supplier_id, attribution_touch_id, partner_id_snapshot,
        commission_eligible_snapshot, status, currency, subtotal_minor, total_minor, sales_terms_document_id,
        privacy_document_id, sales_terms_accepted_at, privacy_acknowledged_at, idempotency_key, request_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      row.id, row.public_number, row.buyer_user_id, row.supplier_id, row.attribution_touch_id,
      row.partner_id_snapshot, row.commission_eligible_snapshot, row.status, row.currency,
      row.subtotal_minor, row.total_minor, row.sales_terms_document_id, row.privacy_document_id,
      row.sales_terms_accepted_at, row.privacy_acknowledged_at, row.idempotency_key, row.request_fingerprint
    ]
  );
  return row;
}

interface ItemOverrides {
  quantity?: number;
  unitPriceMinor?: number;
  commissionMinor?: number;
  settlementMinor?: number | null;
  lineTotalMinor?: number;
}

async function insertOrderItem(orderId: string, variantId: string, overrides: ItemOverrides = {}) {
  const quantity = overrides.quantity ?? 2;
  const unitPriceMinor = overrides.unitPriceMinor ?? 50_000;
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO order_items (id, order_id, variant_id, sku_snapshot, title_snapshot, attributes_snapshot,
        quantity, unit_price_minor, partner_commission_unit_snapshot_minor, supplier_settlement_unit_snapshot_minor, line_total_minor)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, orderId, variantId, `SKU-${variantId.slice(0, 8)}`, "Snapshot watch", { dial: "silver" },
      quantity, unitPriceMinor, overrides.commissionMinor ?? 3_000,
      overrides.settlementMinor === undefined ? 45_000 : overrides.settlementMinor,
      overrides.lineTotalMinor ?? unitPriceMinor * quantity
    ]
  );
  return id;
}

interface ReservationOverrides {
  status?: string;
  releasedAt?: Date | null;
  consumedAt?: Date | null;
  method?: string | null;
  reference?: string | null;
  sourceVersion?: string | null;
  syncRunId?: string | null;
  adminId?: string | null;
  reconciledAt?: Date | null;
}

async function insertReservation(
  orderId: string,
  variantId: string,
  quantity = 1,
  overrides: ReservationOverrides = {}
) {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_reservations (id, order_id, variant_id, quantity, status,
        reconciliation_method, reconciliation_reference, reconciliation_source_version,
        reconciliation_inventory_sync_run_id, reconciled_by_admin_user_id, reconciled_at, released_at, consumed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id, orderId, variantId, quantity, overrides.status ?? "ACTIVE",
      overrides.method ?? null, overrides.reference ?? null, overrides.sourceVersion ?? null,
      overrides.syncRunId ?? null, overrides.adminId ?? null,
      overrides.reconciledAt ?? null, overrides.releasedAt ?? null, overrides.consumedAt ?? null
    ]
  );
  return id;
}

beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const table of [
    "users", "platform_settings", "suppliers", "partners", "legal_documents",
    "attribution_touches", "product_variants", "inventory_sync_runs"
  ]) {
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await pool.query(await readFile(new URL("../../../../packages/db/prisma/migrations/20260930110000_orders/migration.sql", import.meta.url), "utf8"));
  currency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";
  await pool.query("INSERT INTO platform_settings (singleton_id, platform_currency) VALUES (1, $1)", [currency]);
  for (const [id, name] of [
    [buyer, "Buyer"], [otherBuyer, "Other buyer"], [partnerUserA, "Partner A"], [partnerUserB, "Partner B"], [admin, "Admin"]
  ]) {
    await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, $2, $3)",
      [id, String(BigInt(`0x${id.replaceAll("-", "").slice(0, 15)}`)), name]);
  }
  await pool.query("INSERT INTO suppliers (id, name) VALUES ($1, 'Order supplier')", [supplier]);
  await pool.query("INSERT INTO partners (id, user_id) VALUES ($1, $2), ($3, $4)", [partnerA, partnerUserA, partnerB, partnerUserB]);
  for (const [id, type] of [[salesTerms, "SALES_TERMS"], [privacy, "PRIVACY"]] as const) {
    await pool.query(
      `INSERT INTO legal_documents (id, type, version, sha256, content_markdown, effective_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, type, randomUUID(), randomBytes(32).toString("hex"), "# terms"]
    );
  }
  await pool.query(
    `INSERT INTO attribution_touches (id, buyer_user_id, partner_id, referral_link_id, source_fingerprint, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
    [touch, buyer, partnerA, randomUUID(), randomBytes(32).toString("hex")]
  );
  await pool.query(
    `INSERT INTO product_variants (id, product_id, sku, price_minor, currency, partner_commission_unit_minor,
        supplier_settlement_unit_minor, inventory_external_key, status)
     VALUES ($1, $2, $3, 50000, $4, 3000, 45000, $5, 'ACTIVE'), ($6, $2, $7, 12000, $4, 0, NULL, $8, 'ACTIVE')`,
    [variants[0], randomUUID(), variants[0], currency, variants[0], variants[1], variants[1], variants[1]]
  );
  await pool.query("INSERT INTO inventory_sync_runs (id, provider_key, status) VALUES ($1, 'fake', 'SUCCESS')", [syncRun]);
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe.skipIf(!databaseUrl)("Order persistence against real PostgreSQL", () => {
  it("stores an attributed Order with immutable snapshots, fulfillment details and ACTIVE reservations", async () => {
    const order = await insertOrder();
    await pool!.query(
      `INSERT INTO order_fulfillment_details (order_id, recipient_name, phone, address, comment)
       VALUES ($1, 'Иван', '+375291234567', 'Минск, ул. Тестовая 1', 'позвонить заранее')`,
      [order.id]
    );
    const itemA = await insertOrderItem(order.id, variants[0]!);
    await insertOrderItem(order.id, variants[1]!, { quantity: 1, unitPriceMinor: 12_000, commissionMinor: 0, settlementMinor: null, lineTotalMinor: 12_000 });
    await insertReservation(order.id, variants[0]!, 2);
    await insertReservation(order.id, variants[1]!, 1);

    const stored = (await pool!.query<StoredOrder & { created_at: Date; updated_at: Date }>(
      "SELECT * FROM orders WHERE id = $1", [order.id]
    )).rows[0]!;
    expect(stored).toMatchObject({
      status: "PLACED",
      currency,
      subtotal_minor: 112_000,
      total_minor: 112_000,
      commission_eligible_snapshot: true,
      partner_id_snapshot: partnerA
    });
    expect(stored.public_number).toMatch(/^W-[0-9A-HJKMNP-TV-Z]{12}$/);
    for (const field of ["completion_eligible_at", "confirmed_at", "fulfilling_at", "shipped_at", "delivered_at", "completed_at", "cancelled_at", "delivery_failed_at"] as const) {
      expect(stored[field]).toBeNull();
    }
    expect(stored.request_fingerprint).toHaveLength(64);

    const items = (await pool!.query<{
      id: string; sku_snapshot: string; title_snapshot: string; attributes_snapshot: Record<string, unknown>;
      quantity: number; unit_price_minor: number; partner_commission_unit_snapshot_minor: number;
      supplier_settlement_unit_snapshot_minor: number | null; line_total_minor: number;
    }>("SELECT * FROM order_items WHERE order_id = $1 ORDER BY variant_id", [order.id])).rows;
    expect(items).toHaveLength(2);
    const snapshot = items.find((item) => item.id === itemA)!;
    expect(snapshot).toMatchObject({
      sku_snapshot: `SKU-${variants[0]!.slice(0, 8)}`,
      title_snapshot: "Snapshot watch",
      quantity: 2, unit_price_minor: 50_000,
      partner_commission_unit_snapshot_minor: 3_000,
      supplier_settlement_unit_snapshot_minor: 45_000,
      line_total_minor: 100_000
    });
    expect(snapshot.attributes_snapshot).toEqual({ dial: "silver" });
    expect(items.reduce((sum, item) => sum + item.line_total_minor, 0)).toBe(stored.subtotal_minor);

    const reservations = (await pool!.query<{
      status: string; released_at: Date | null; consumed_at: Date | null;
      reconciliation_method: string | null; reconciled_at: Date | null; reconciled_by_admin_user_id: string | null;
    }>("SELECT * FROM inventory_reservations WHERE order_id = $1", [order.id])).rows;
    expect(reservations).toHaveLength(2);
    for (const reservation of reservations) {
      expect(reservation).toMatchObject({
        status: "ACTIVE", released_at: null, consumed_at: null,
        reconciliation_method: null, reconciled_at: null, reconciled_by_admin_user_id: null
      });
    }
  });

  it("binds attribution touch and Partner snapshot as one composite relationship", async () => {
    await expect(insertOrder({ attributionTouchId: touch, partnerIdSnapshot: partnerB })).rejects.toThrow();
    await expect(insertOrder({ attributionTouchId: null, partnerIdSnapshot: null, commissionEligibleSnapshot: true })).rejects.toThrow();
    await expect(insertOrder({ attributionTouchId: touch, partnerIdSnapshot: null })).rejects.toThrow();
    await expect(insertOrder({ attributionTouchId: null, partnerIdSnapshot: partnerA })).rejects.toThrow();
    await expect(insertOrder({ attributionTouchId: randomUUID(), partnerIdSnapshot: partnerA })).rejects.toThrow();
    const unattributed = await insertOrder({ attributionTouchId: null, partnerIdSnapshot: null, commissionEligibleSnapshot: false });
    expect(unattributed.partner_id_snapshot).toBeNull();
    const attributed = await insertOrder({});
    expect(attributed.partner_id_snapshot).toBe(partnerA);
  });

  it("stores idempotency identity per Buyer and rejects duplicate keys", async () => {
    const key = `idem-${randomUUID()}`;
    const first = await insertOrder({ idempotencyKey: key });
    await expect(insertOrder({ idempotencyKey: key })).rejects.toMatchObject({
      code: "23505", constraint: "orders_buyer_idempotency_key"
    });
    const otherBuyerOrder = await insertOrder({ buyerUserId: otherBuyer, idempotencyKey: key });
    expect(otherBuyerOrder.buyer_user_id).toBe(otherBuyer);
    const secondKey = await insertOrder({ idempotencyKey: `idem-${randomUUID()}` });
    expect(secondKey.id).not.toBe(first.id);
  });

  it("enforces platform currency identity and checked money guards", async () => {
    await expect(insertOrder({ currency: currency === "USD" ? "EUR" : "USD" })).rejects.toThrow();
    await expect(insertOrder({ subtotalMinor: -1, totalMinor: -1 })).rejects.toThrow();
    await expect(insertOrder({ subtotalMinor: 2_000_000_001, totalMinor: 2_000_000_001 })).rejects.toThrow();
    await expect(insertOrder({ totalMinor: 111_999 })).rejects.toThrow();
    const order = await insertOrder({});
    await expect(insertOrderItem(order.id, variants[0]!, { lineTotalMinor: 99_999 })).rejects.toThrow();
    await expect(insertOrderItem(order.id, variants[0]!, { quantity: 0, lineTotalMinor: 0 })).rejects.toThrow();
    await expect(insertOrderItem(order.id, variants[0]!, { unitPriceMinor: -1, lineTotalMinor: -2 })).rejects.toThrow();
  });

  it("generates display-safe public numbers and retries inserts on uniqueness collisions", async () => {
    const existing = await insertOrder({});
    await expect(insertOrder({ publicNumber: existing.public_number })).rejects.toMatchObject({
      code: "23505", constraint: "orders_public_number_key"
    });
    for (const malformed of ["W-ABC", "X-000000000000", "w-000000000000", "W-0000000000000", "W-0O0000000000"]) {
      await expect(insertOrder({ publicNumber: malformed })).rejects.toThrow();
    }
    let attempt = 0;
    const numbers = [existing.public_number, existing.public_number, generatePublicOrderNumber()];
    const inserted = await insertWithPublicNumberRetry(
      async (publicNumber) => {
        attempt += 1;
        return insertOrder({ publicNumber, idempotencyKey: `retry-${randomUUID()}` }).then(() => publicNumber);
      },
      () => numbers[Math.min(attempt, numbers.length - 1)]!,
      5
    );
    expect(attempt).toBe(3);
    expect(inserted).toMatch(/^W-[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(inserted).not.toBe(existing.public_number);
  });

  it("keeps order items and reservations composite-consistent", async () => {
    const orderA = await insertOrder({});
    const orderB = await insertOrder({});
    await insertOrderItem(orderA.id, variants[0]!);
    await expect(insertOrderItem(orderA.id, variants[0]!)).rejects.toMatchObject({ constraint: "order_items_order_id_variant_id_key" });
    await expect(insertOrderItem(orderA.id, variants[1]!, { quantity: 0, lineTotalMinor: 0 })).rejects.toThrow(/quantity/);
    await insertReservation(orderA.id, variants[0]!, 2);
    await expect(insertReservation(orderA.id, variants[0]!, 1)).rejects.toMatchObject({ constraint: "inventory_reservations_order_id_variant_id_key" });
    await expect(insertReservation(orderA.id, variants[1]!, 1)).rejects.toThrow();
    await insertOrderItem(orderB.id, variants[0]!, { quantity: 1, unitPriceMinor: 50_000, lineTotalMinor: 50_000 });
    await insertReservation(orderB.id, variants[0]!, 1);
    const holds = (await pool!.query<{ count: number }>(
      "SELECT SUM(quantity)::int AS count FROM inventory_reservations WHERE order_id = ANY($1::uuid[]) AND variant_id = $2 AND status = 'ACTIVE'",
      [[orderA.id, orderB.id], variants[0]]
    )).rows[0]!;
    expect(holds.count).toBe(3);
  });

  it("enforces reservation state and reconciliation evidence guards", async () => {
    const order = await insertOrder({});
    await insertOrderItem(order.id, variants[0]!);
    await insertOrderItem(order.id, variants[1]!, { quantity: 1, unitPriceMinor: 12_000, lineTotalMinor: 12_000, commissionMinor: 0, settlementMinor: null });
    await expect(insertReservation(order.id, variants[0]!, 1, { status: "RELEASED", releasedAt: null })).rejects.toThrow(/state/);
    await expect(insertReservation(order.id, variants[0]!, 1, { status: "RELEASED", releasedAt: new Date(), consumedAt: new Date() })).rejects.toThrow(/state/);
    await expect(insertReservation(order.id, variants[0]!, 1, { status: "RELEASED", releasedAt: new Date() })).resolves.toBeDefined();
    await expect(insertReservation(order.id, variants[1]!, 1, {
      status: "CONSUMED", consumedAt: new Date(),
      method: "MANUAL", syncRunId: syncRun, adminId: null, reconciledAt: new Date()
    })).rejects.toThrow(/manual_admin/);
    await expect(insertReservation(order.id, variants[1]!, 1, {
      status: "CONSUMED", consumedAt: new Date(),
      method: "MANUAL", syncRunId: syncRun, adminId: admin, reconciledAt: null
    })).rejects.toThrow(/reconciliation/);
    await insertReservation(order.id, variants[1]!, 1, {
      status: "CONSUMED", consumedAt: new Date(),
      method: "MANUAL", syncRunId: syncRun, adminId: admin, reconciledAt: new Date(), reference: "sheet check", sourceVersion: "v3"
    });
    const manual = (await pool!.query<{ reconciliation_inventory_sync_run_id: string; reconciliation_source_version: string | null }>(
      "SELECT * FROM inventory_reservations WHERE order_id = $1 AND variant_id = $2", [order.id, variants[1]]
    )).rows[0]!;
    expect(manual.reconciliation_inventory_sync_run_id).toBe(syncRun);
    expect(manual.reconciliation_source_version).toBe("v3");
  });

  it("stores one fulfillment detail per order with audited redaction invariants", async () => {
    const order = await insertOrder({});
    await expect(pool!.query("INSERT INTO order_fulfillment_details (order_id) VALUES ($1)", [randomUUID()])).rejects.toThrow();
    await pool!.query(
      "INSERT INTO order_fulfillment_details (order_id, recipient_name, phone, address, comment) VALUES ($1, 'Иван', '+375291234567', 'Минск', 'до 18')",
      [order.id]
    );
    await expect(pool!.query(
      "INSERT INTO order_fulfillment_details (order_id, recipient_name) VALUES ($1, 'Мария')", [order.id]
    )).rejects.toThrow();
    await expect(pool!.query(
      "UPDATE order_fulfillment_details SET redacted_at = now(), redacted_by_admin_user_id = $1 WHERE order_id = $2",
      [admin, order.id]
    )).rejects.toThrow(/redacted/);
    await expect(pool!.query(
      `UPDATE order_fulfillment_details
         SET recipient_name = NULL, phone = NULL, address = NULL, comment = NULL,
             redacted_at = now(), redacted_by_admin_user_id = $1
       WHERE order_id = $2`,
      [admin, order.id]
    )).resolves.toBeDefined();
    const redacted = (await pool!.query<{
      recipient_name: string | null; phone: string | null; address: string | null;
      redacted_at: Date | null; redacted_by_admin_user_id: string | null;
    }>("SELECT * FROM order_fulfillment_details WHERE order_id = $1", [order.id])).rows[0]!;
    expect(redacted).toMatchObject({
      recipient_name: null, phone: null, address: null,
      redacted_by_admin_user_id: admin
    });
    expect(redacted.redacted_at).not.toBeNull();
  });

  it("protects business history with RESTRICT deletes", async () => {
    const order = await insertOrder({});
    await insertOrderItem(order.id, variants[0]!);
    await insertReservation(order.id, variants[0]!, 2);
    for (const [sql, id] of [
      ["DELETE FROM users WHERE id = $1", buyer],
      ["DELETE FROM suppliers WHERE id = $1", supplier],
      ["DELETE FROM partners WHERE id = $1", partnerA],
      ["DELETE FROM legal_documents WHERE id = $1", salesTerms],
      ["DELETE FROM attribution_touches WHERE id = $1", touch],
      ["DELETE FROM orders WHERE id = $1", order.id]
    ]) {
      await expect(pool!.query(sql, [id])).rejects.toThrow();
    }
    await pool!.query("DELETE FROM inventory_reservations WHERE order_id = $1", [order.id]);
    await pool!.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);
    await expect(pool!.query("DELETE FROM orders WHERE id = $1", [order.id])).resolves.toBeDefined();
  });

  it("creates the partial DELIVERED completion-worker index", async () => {
    const indexes = (await pool!.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'orders_completion_worker_idx'",
      [schema]
    )).rows;
    expect(indexes).toHaveLength(1);
    const indexdef = indexes[0]!.indexdef;
    expect(indexdef).toContain("orders_completion_worker_idx");
    expect(indexdef).toContain("(completion_eligible_at, id)");
    expect(indexdef).toContain("DELIVERED");
    const order = await insertOrder({});
    await pool!.query(
      "UPDATE orders SET status = 'DELIVERED', delivered_at = now(), completion_eligible_at = now() WHERE id = $1",
      [order.id]
    );
    const client = await pool!.connect();
    try {
      await client.query("SET enable_seqscan = off");
      await client.query("SET enable_sort = off");
      const planned = await client.query(
        "EXPLAIN (FORMAT JSON) SELECT id FROM orders WHERE status = 'DELIVERED' AND completion_eligible_at <= now() ORDER BY completion_eligible_at, id LIMIT 5"
      );
      expect(JSON.stringify(planned)).toContain("orders_completion_worker_idx");
    } finally {
      client.release();
    }
  });
});
