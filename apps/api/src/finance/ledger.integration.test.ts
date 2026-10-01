import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabaseReady } from "@watch/db";
import { generatePublicOrderNumber } from "../orders/order-number.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `ledger_test_${randomUUID().replaceAll("-", "")}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` }) : null;
const currency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";
const user = randomUUID();
const otherUser = randomUUID();
const partner = randomUUID();
const otherPartner = randomUUID();
const supplier = randomUUID();
const product = randomUUID();
const variant = randomUUID();
const link = randomUUID();
const touch = randomUUID();
const legal = randomUUID();
let order: string;
let item: string;
let commission: string;
let payout: string;

async function makeItem(eligible = true, unit = 100, quantity = 2) {
  const orderId = randomUUID();
  const itemId = randomUUID();
  await pool!.query(`INSERT INTO orders (id, public_number, buyer_user_id, supplier_id,
    attribution_touch_id, partner_id_snapshot, commission_eligible_snapshot, currency,
    subtotal_minor, total_minor, sales_terms_document_id, privacy_document_id,
    sales_terms_accepted_at, privacy_acknowledged_at, idempotency_key, request_fingerprint)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1000,1000,$9,$9,now(),now(),$11,$10)`,
  [orderId, generatePublicOrderNumber(), user, supplier, touch, partner, eligible, currency, legal, "a".repeat(64), orderId]);
  await pool!.query(`INSERT INTO order_items (id, order_id, variant_id, sku_snapshot, title_snapshot,
    quantity, unit_price_minor, partner_commission_unit_snapshot_minor, line_total_minor)
    VALUES ($1,$2,$3,'SKU','Watch',$4,0,$5,0)`, [itemId, orderId, variant, quantity, unit]);
  return { orderId, itemId };
}

async function makeCommission(orderId = order, itemId = item, overrides: {
  partner?: string; quantity?: number; unit?: number; gross?: number; reversed?: number;
} = {}) {
  const id = randomUUID();
  await pool!.query(`INSERT INTO commissions (id, partner_id, order_id, order_item_id,
    quantity, unit_amount_minor, gross_amount_minor, reversed_amount_minor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [id, overrides.partner ?? partner, orderId, itemId, overrides.quantity ?? 2,
    overrides.unit ?? 100, overrides.gross ?? 200, overrides.reversed ?? 0]);
  return id;
}

async function makePayout(partnerId = partner, payoutCurrency = currency, status = "REQUESTED", key = randomUUID()) {
  const id = randomUUID();
  await pool!.query(`INSERT INTO payouts (id, partner_id, amount_minor, currency, status,
    idempotency_key, request_fingerprint, requested_by_user_id)
    VALUES ($1,$2,200,$3,$4,$5,$6,$7)`, [id, partnerId, payoutCurrency, status, key, "a".repeat(64), user]);
  return id;
}

async function append(type: string, bucket: string, amount: number, overrides: {
  partner?: string; commission?: string | null; payout?: string | null; key?: string;
} = {}) {
  const id = randomUUID();
  const isCommission = type.startsWith("COMMISSION_");
  await pool!.query(`INSERT INTO ledger_entries (id, partner_id, commission_id, payout_id,
    entry_type, bucket, amount_minor, transaction_group_id, idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, overrides.partner ?? partner,
    overrides.commission === undefined ? (isCommission ? commission : null) : overrides.commission,
    overrides.payout === undefined ? (isCommission ? null : payout) : overrides.payout,
    type, bucket, amount, randomUUID(), overrides.key ?? randomUUID()]);
  return id;
}

beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  // Replay every real migration into an empty isolated schema, including custom SQL.
  const migrations = new URL("../../../../packages/db/prisma/migrations/", import.meta.url);
  const directories = (await readdir(migrations, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const directory of directories) {
    await pool.query(await readFile(new URL(`${directory.name}/migration.sql`, migrations), "utf8"));
  }
  await pool.query("INSERT INTO platform_settings (singleton_id, platform_currency) VALUES (1,$1)", [currency]);
  await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1,1,'User'),($2,2,'Other')", [user, otherUser]);
  await pool.query("INSERT INTO partners (id, user_id) VALUES ($1,$2),($3,$4)", [partner, user, otherPartner, otherUser]);
  await pool.query("INSERT INTO suppliers (id, name) VALUES ($1,'Supplier')", [supplier]);
  await pool.query("INSERT INTO products (id, supplier_id, slug, title) VALUES ($1,$2,'watch','Watch')", [product, supplier]);
  await pool.query("INSERT INTO product_variants (id, product_id, sku, price_minor, currency, partner_commission_unit_minor, inventory_external_key) VALUES ($1,$2,'SKU',1000,$3,100,'SKU')", [variant, product, currency]);
  await pool.query("INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at) VALUES ($1,'SALES_TERMS','1',$2,'Terms',now())", [legal, "a".repeat(64)]);
  await pool.query("INSERT INTO referral_links (id,partner_id,token) VALUES ($1,$2,'ref123')", [link, partner]);
  await pool.query(`INSERT INTO attribution_touches (id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+interval '30 days')`, [touch, user, partner, link, "a".repeat(64)]);
  ({ orderId: order, itemId: item } = await makeItem());
  commission = await makeCommission();
  payout = await makePayout();
}, 30_000);

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe.skipIf(!databaseUrl)("Commission/Ledger migrations on real PostgreSQL", () => {
  it("stores one positive snapshotted Commission and rejects cross-Order/Partner and missing references", async () => {
    const row = (await pool!.query("SELECT * FROM commissions WHERE id=$1", [commission])).rows[0];
    expect(row).toMatchObject({ quantity: 2, unit_amount_minor: 100, gross_amount_minor: 200, reversed_amount_minor: 0, state: "PENDING", eligible_at: null, available_at: null });
    await expect(makeCommission()).rejects.toMatchObject({ code: "23505" });
    const other = await makeItem();
    await expect(makeCommission(other.orderId, other.itemId, { partner: otherPartner })).rejects.toMatchObject({ code: "23503" });
    await expect(makeCommission(other.orderId, item)).rejects.toMatchObject({ code: "23514" });
    await expect(makeCommission(other.orderId, randomUUID())).rejects.toMatchObject({ code: "23514" });
    await expect(makeCommission(randomUUID(), other.itemId)).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects ineligible and zero-unit lines and changed quantity/unit snapshots", async () => {
    for (const [eligible, unit] of [[false, 100], [true, 0]] as const) {
      const line = await makeItem(eligible, unit);
      await expect(makeCommission(line.orderId, line.itemId)).rejects.toMatchObject({ code: "23514" });
    }
    const line = await makeItem();
    await expect(makeCommission(line.orderId, line.itemId, { quantity: 1, gross: 100 })).rejects.toMatchObject({ code: "23514" });
    await expect(makeCommission(line.orderId, line.itemId, { unit: 50, gross: 100 })).rejects.toMatchObject({ code: "23514" });
    await expect(pool!.query("UPDATE commissions SET unit_amount_minor=50,gross_amount_minor=100 WHERE id=$1", [commission])).rejects.toMatchObject({ code: "23514" });
  });

  it("checks positive amounts, exact bigint gross arithmetic and reversal bounds", async () => {
    const line = await makeItem();
    for (const overrides of [{ quantity: 0 }, { unit: 0 }, { gross: 0 }, { gross: 201 }, { reversed: -1 }, { reversed: 201 }]) {
      await expect(makeCommission(line.orderId, line.itemId, overrides)).rejects.toMatchObject({ code: "23514" });
    }
    const large = await makeItem(true, 2_147_483_647, 2_147_483_647);
    await expect(makeCommission(large.orderId, large.itemId, { unit: 2_147_483_647, quantity: 2_147_483_647, gross: 1 })).rejects.toMatchObject({ code: "23514", constraint: "commissions_gross_amount_check" });
    await pool!.query("UPDATE commissions SET reversed_amount_minor=200,state='VOID' WHERE id=$1", [commission]);
    await expect(pool!.query("UPDATE commissions SET reversed_amount_minor=201 WHERE id=$1", [commission])).rejects.toMatchObject({ code: "23514" });
  });

  const allowed: Record<string, string[]> = {
    COMMISSION_CREATE: ["PENDING:1"],
    COMMISSION_RELEASE: ["PENDING:-1", "AVAILABLE:1"],
    COMMISSION_REVERSAL: ["PENDING:-1", "AVAILABLE:-1"],
    PAYOUT_LOCK: ["AVAILABLE:-1", "PAYOUT_LOCKED:1"],
    PAYOUT_PAID: ["PAYOUT_LOCKED:-1"],
    PAYOUT_REJECT: ["PAYOUT_LOCKED:-1", "AVAILABLE:1"]
  };
  for (const [type, combinations] of Object.entries(allowed)) {
    it(`enforces every bucket/sign combination for ${type}`, async () => {
      for (const bucket of ["PENDING", "AVAILABLE", "PAYOUT_LOCKED"]) {
        for (const amount of [-1, 0, 1]) {
          const result = append(type, bucket, amount);
          if (combinations.includes(`${bucket}:${amount}`)) await expect(result).resolves.toBeTypeOf("string");
          else await expect(result).rejects.toMatchObject({ code: "23514" });
        }
      }
    });
  }

  it("requires exactly the correct financial reference and rejects cross-Partner ledger rows", async () => {
    for (const [type, bucket, amount] of [["COMMISSION_CREATE", "PENDING", 1], ["PAYOUT_LOCK", "AVAILABLE", -1]] as const) {
      await expect(append(type, bucket, amount, { commission: null, payout: null })).rejects.toMatchObject({ code: "23514" });
      await expect(append(type, bucket, amount, { commission, payout })).rejects.toMatchObject({ code: "23514" });
      await expect(append(type, bucket, amount, { commission: type.startsWith("PAYOUT") ? commission : null, payout: type.startsWith("PAYOUT") ? null : payout })).rejects.toMatchObject({ code: "23514" });
      await expect(append(type, bucket, amount, { partner: otherPartner })).rejects.toMatchObject({ code: "23503" });
    }
    await expect(append("COMMISSION_CREATE", "PENDING", 1, { commission: randomUUID() })).rejects.toMatchObject({ code: "23503" });
    await expect(append("PAYOUT_PAID", "PAYOUT_LOCKED", -1, { payout: randomUUID() })).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces idempotency including concurrent inserts", async () => {
    const key = randomUUID();
    const attempts = await Promise.allSettled([append("COMMISSION_CREATE", "PENDING", 1, { key }), append("COMMISSION_CREATE", "PENDING", 1, { key })]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({ reason: { code: "23505" } });
    expect((await pool!.query("SELECT count(*)::int AS count FROM ledger_entries WHERE idempotency_key=$1", [key])).rows[0].count).toBe(1);
  });

  it("unconditionally rejects updates/deletes including no-op, metadata and identity changes", async () => {
    const id = await append("COMMISSION_CREATE", "PENDING", 10);
    for (const sql of [
      "UPDATE ledger_entries SET amount_minor=11 WHERE id=$1",
      "UPDATE ledger_entries SET amount_minor=amount_minor WHERE id=$1",
      "UPDATE ledger_entries SET metadata='{}' WHERE id=$1",
      "UPDATE ledger_entries SET id=gen_random_uuid() WHERE id=$1",
      "DELETE FROM ledger_entries WHERE id=$1"
    ]) await expect(pool!.query(sql, [id])).rejects.toMatchObject({ code: "23514", message: "LedgerEntry is append-only" });
    expect((await pool!.query("SELECT amount_minor,metadata FROM ledger_entries WHERE id=$1", [id])).rows[0]).toEqual({ amount_minor: 10, metadata: null });
    await expect(pool!.query("DELETE FROM commissions WHERE id=$1", [commission])).rejects.toMatchObject({ constraint: "ledger_entries_commission_partner_fkey" });
    await expect(pool!.query("DELETE FROM payouts WHERE id=$1", [payout])).rejects.toMatchObject({ constraint: "ledger_entries_payout_partner_fkey" });
  });

  it("inherits the single immutable currency, rejects foreign currency and protects settings", async () => {
    const foreign = currency === "USD" ? "EUR" : "USD";
    await expect(makePayout(otherPartner, foreign)).rejects.toMatchObject({ code: "23503" });
    const line = await makeItem();
    await expect(pool!.query("UPDATE orders SET currency=$1 WHERE id=$2", [foreign, line.orderId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool!.query("UPDATE platform_settings SET platform_currency=$1", [foreign])).rejects.toThrow(/immutable/);
    await expect(pool!.query("DELETE FROM platform_settings")).rejects.toThrow(/immutable/);
    expect((await pool!.query("SELECT currency FROM orders WHERE id=$1", [order])).rows[0].currency).toBe(currency);
    const columns = (await pool!.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('commissions','ledger_entries')", [schema])).rows;
    expect(columns.some((column) => column.column_name === "currency")).toBe(false);
  });

  it("keeps Payout foundation uniqueness and Return foundation relationships/indexes", async () => {
    await expect(makePayout()).rejects.toMatchObject({ code: "23505" });
    const key = randomUUID();
    await makePayout(partner, currency, "REJECTED", key);
    await expect(makePayout(partner, currency, "PAID", key)).rejects.toMatchObject({ code: "23505" });
    const id = randomUUID();
    await pool!.query("INSERT INTO returns (id,order_id,reason,created_by_admin_user_id) VALUES ($1,$2,'Return',$3)", [id, order, user]);
    await expect(pool!.query("INSERT INTO returns (id,order_id,reason,created_by_admin_user_id) VALUES ($1,$2,'Return',$3)", [randomUUID(), randomUUID(), user])).rejects.toMatchObject({ code: "23503" });
    expect((await pool!.query("SELECT status FROM returns WHERE id=$1", [id])).rows[0].status).toBe("OPEN");
    const indexes = (await pool!.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1", [schema])).rows.map((row) => row.indexname);
    for (const index of ["commissions_partner_id_state_created_at_idx", "commissions_order_id_idx", "ledger_entries_partner_id_bucket_created_at_idx", "ledger_entries_commission_id_created_at_idx", "ledger_entries_payout_id_created_at_idx", "ledger_entries_transaction_group_id_idx", "returns_order_id_status_idx", "returns_status_created_at_id_idx"]) expect(indexes).toContain(index);
    const columns = (await pool!.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='return_items'", [schema])).rows.map((row) => row.column_name);
    for (const column of ["id", "return_id", "order_id", "order_item_id", "quantity"]) expect(columns).toContain(column);
  });

  it("requires the financial migration before readiness succeeds", async () => {
    await pool!.query("CREATE TABLE _prisma_migrations (migration_name text, finished_at timestamptz, rolled_back_at timestamptz)");
    const migrations = new URL("../../../../packages/db/prisma/migrations/", import.meta.url);
    for (const directory of (await readdir(migrations, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      if (directory.name !== "20261001000000_commission_ledger") await pool!.query("INSERT INTO _prisma_migrations VALUES ($1,now(),NULL)", [directory.name]);
    }
    await expect(checkDatabaseReady(pool!)).rejects.toThrow("Commission/Ledger migration has not been applied");
    await pool!.query("INSERT INTO _prisma_migrations VALUES ('20261001000000_commission_ledger',now(),NULL)");
    await expect(checkDatabaseReady(pool!)).resolves.toBeUndefined();
  });
});
