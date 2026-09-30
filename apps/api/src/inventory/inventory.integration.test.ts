import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogService, initializePlatformCurrency, seedSupplier } from "../catalog/catalog.js";
import {
  InventoryService,
  noInventoryReservationChecks,
  type InventoryReservationChecks
} from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

const actorUserId = randomUUID();
const categoryIds: string[] = [];
const productIds: string[] = [];
const variantIds: string[] = [];
const syncRunIds: string[] = [];

let platformCurrency = "BYN";
let catalog!: CatalogService;
let inventory!: InventoryService;

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function checksWith(reservations: Record<string, number>, pending: Record<string, number> = {}): InventoryReservationChecks {
  return {
    ...noInventoryReservationChecks,
    async activeReservationsByVariant() {
      return new Map(Object.entries(reservations));
    },
    async reconciliationPendingByVariant() {
      return new Map(Object.entries(pending));
    }
  };
}

beforeAll(async () => {
  if (!pool) return;
  platformCurrency = (await initializePlatformCurrency(pool, process.env.TEST_PLATFORM_CURRENCY ?? "BYN")).platformCurrency;
  await seedSupplier(pool, "Inventory supplier");
  catalog = new CatalogService(pool, platformCurrency);
  inventory = new InventoryService(pool);
  const telegramUserId = (BigInt(Date.now()) * 1000n + BigInt(`0x${randomBytes(4).toString("hex")}`) % 1000n).toString();
  await pool.query(
    "INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, $2, 'Inventory')",
    [actorUserId, telegramUserId]
  );

  const category = await catalog.createCategory(actorUserId, { name: "Инвентаризация", slug: unique("inv-cat"), sortOrder: 9 });
  categoryIds.push(category.id);
  const product = await catalog.createProduct(actorUserId, {
    title: unique("Inventory product"),
    description: "inventory",
    categoryIds: [category.id]
  });
  productIds.push(product.id);
  for (const key of ["ok-key", "stale-key", "missing-key", "uninit-key", "deficit-key"]) {
    const variant = await catalog.createVariant(actorUserId, product.id, {
      sku: unique("sku"),
      priceMinor: 10_000,
      partnerCommissionUnitMinor: 500,
      inventoryExternalKey: key
    });
    variantIds.push(variant.id);
  }
});

afterAll(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id = $1", [actorUserId]);
  await pool.query("UPDATE inventory_items SET last_successful_sync_run_id = NULL WHERE variant_id = ANY($1::uuid[])", [variantIds]);
  await pool.query("DELETE FROM inventory_sync_runs WHERE id = ANY($1::uuid[])", [syncRunIds]);
  await pool.query("DELETE FROM inventory_items WHERE variant_id = ANY($1::uuid[])", [variantIds]);
  await pool.query("DELETE FROM product_variants WHERE id = ANY($1::uuid[])", [variantIds]);
  await pool.query("DELETE FROM products WHERE id = ANY($1::uuid[])", [productIds]);
  await pool.query("DELETE FROM categories WHERE id = ANY($1::uuid[])", [categoryIds]);
  await pool.query("DELETE FROM users WHERE id = $1", [actorUserId]);
  await pool.end();
});

describe.skipIf(!databaseUrl)("Inventory foundation against PostgreSQL", () => {
  it("persists inventory sync runs with the normalized status enum", async () => {
    const run = await pool!.query<{ id: string; status: string; provider_key: string }>(
      `INSERT INTO inventory_sync_runs (id, provider_key, status, details_json, error_summary)
       VALUES ($1, 'fake', 'SUCCESS', '{"applied":0}', NULL) RETURNING id, status, provider_key`,
      [randomUUID()]
    );
    syncRunIds.push(run.rows[0]!.id);
    expect(run.rows[0]).toMatchObject({ status: "SUCCESS", provider_key: "fake" });
    await expect(
      pool!.query(`INSERT INTO inventory_sync_runs (id, provider_key, status) VALUES ($1, 'fake', 'BOGUS')`, [randomUUID()])
    ).rejects.toThrow();
  });

  it("projects source state, freshness, sellable and deficit per Variant", async () => {
    const variantId = variantIds[0]!;
    const run = await pool!.query<{ id: string }>(
      `INSERT INTO inventory_sync_runs (id, provider_key, status, started_at, finished_at)
       VALUES ($1, 'fake', 'SUCCESS', now(), now()) RETURNING id`,
      [randomUUID()]
    );
    syncRunIds.push(run.rows[0]!.id);
    await pool!.query(
      `UPDATE inventory_items
          SET source_quantity = 10, safety_buffer = 2, source_status = 'OK', source_version = 'v1',
              last_successful_sync_at = now(), last_successful_sync_run_id = $2, updated_at = now()
        WHERE variant_id = $1`,
      [variantId, run.rows[0]!.id]
    );

    const result = await inventory.listItems({ page: 1, limit: 100 });
    const item = result.items.find((row) => row.variantId === variantId);
    expect(item).toMatchObject({
      sourceQuantity: 10,
      safetyBuffer: 2,
      sourceStatus: "OK",
      sourceVersion: "v1",
      lastSuccessfulSyncRunId: run.rows[0]!.id,
      activeReservations: 0,
      reconciliationPending: 0,
      sellable: 8,
      availability: "IN_STOCK",
      deficit: false
    });
  });

  it("flags deficits when fresh source quantity cannot cover reservations and buffer", async () => {
    const variantId = variantIds[4]!;
    await pool!.query(
      `UPDATE inventory_items
          SET source_quantity = 5, safety_buffer = 2, source_status = 'OK',
              last_successful_sync_at = now(), updated_at = now()
        WHERE variant_id = $1`,
      [variantId]
    );
    const service = new InventoryService(pool!, checksWith({ [variantId]: 4 }, { [variantId]: 1 }));
    const result = await service.listItems({ page: 1, limit: 100 });
    const item = result.items.find((row) => row.variantId === variantId);
    expect(item).toMatchObject({
      activeReservations: 4,
      reconciliationPending: 1,
      sellable: 0,
      availability: "OUT_OF_STOCK",
      deficit: true
    });
  });

  it("fails closed: stale OK inventory is not sellable and non-OK statuses are UNKNOWN", async () => {
    const staleId = variantIds[1]!;
    await pool!.query(
      `UPDATE inventory_items
          SET source_quantity = 3, source_status = 'OK',
              last_successful_sync_at = now() - interval '1 hour', updated_at = now()
        WHERE variant_id = $1`,
      [staleId]
    );
    await pool!.query(
      `UPDATE inventory_items
          SET source_quantity = 3, source_status = 'MISSING', updated_at = now()
        WHERE variant_id = $1`,
      [variantIds[2]!]
    );
    const result = await inventory.listItems({ page: 1, limit: 100 });
    expect(result.items.find((row) => row.variantId === staleId)).toMatchObject({
      availability: "STALE", sellable: 0, deficit: false
    });
    expect(result.items.find((row) => row.variantId === variantIds[2])).toMatchObject({
      availability: "UNKNOWN", sellable: 0
    });
  });

  it("keeps an untouched Variant UNINITIALIZED and not sellable", async () => {
    const result = await inventory.listItems({ page: 1, limit: 100 });
    const item = result.items.find((row) => row.variantId === variantIds[3]);
    expect(item).toMatchObject({
      sourceStatus: "UNINITIALIZED",
      sourceQuantity: null,
      availability: "UNKNOWN",
      sellable: 0
    });
  });

  it("lists sync runs newest first with pagination", async () => {
    const runs = await inventory.listSyncRuns({ page: 1, limit: 10 });
    expect(runs.items.length).toBeGreaterThanOrEqual(2);
    expect(runs.items.every((run) => run.startedAt instanceof Date)).toBe(true);
    const timestamps = runs.items.map((run) => run.startedAt.getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    const firstPage = await inventory.listSyncRuns({ page: 1, limit: 1 });
    const secondPage = await inventory.listSyncRuns({ page: 2, limit: 1 });
    expect(firstPage.items[0]?.id).not.toBe(secondPage.items[0]?.id);
  });

  it("enforces sync-run referential integrity on inventory items", async () => {
    const variantId = variantIds[0]!;
    await expect(
      pool!.query(
        "UPDATE inventory_items SET last_successful_sync_run_id = $1 WHERE variant_id = $2",
        [randomUUID(), variantId]
      )
    ).rejects.toMatchObject({ code: "23503" });
    const referenced = await pool!.query<{ last_successful_sync_run_id: string }>(
      "SELECT last_successful_sync_run_id FROM inventory_items WHERE variant_id = $1",
      [variantId]
    );
    await expect(
      pool!.query("DELETE FROM inventory_sync_runs WHERE id = $1", [referenced.rows[0]?.last_successful_sync_run_id])
    ).rejects.toMatchObject({ code: "23503" });
  });
});
