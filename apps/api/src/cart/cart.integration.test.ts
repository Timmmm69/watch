import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cartResponseSchema } from "@watch/contracts";
import { initializePlatformCurrency, seedSupplier } from "../catalog/catalog.js";
import { CartService } from "./cart.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `cart_test_${randomUUID().replaceAll("-", "")}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema},public` }) : null;
const buyer = randomUUID(); const otherBuyer = randomUUID(); const product = randomUUID();
const variants = Array.from({ length: 101 }, () => randomUUID());
let service: CartService;

beforeAll(async () => {
  if (!pool) return;
  // Isolate the 101-SKU fixture from other integration suites' paginated catalog/inventory reads.
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const table of ["users", "platform_settings", "suppliers", "products", "product_variants", "inventory_items"]) {
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await pool.query(await readFile(new URL("../../../../packages/db/prisma/migrations/20260930100000_cart/migration.sql", import.meta.url), "utf8"));
  const { platformCurrency } = await initializePlatformCurrency(pool, process.env.TEST_PLATFORM_CURRENCY ?? "BYN");
  const { supplierId } = await seedSupplier(pool, "Integration supplier");
  service = new CartService(pool, platformCurrency);
  for (const id of [buyer, otherBuyer]) await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, $2, 'Cart')",
    [id, String(BigInt(`0x${id.replaceAll("-", "").slice(0, 15)}`))]);
  await pool.query("INSERT INTO products (id, supplier_id, title, slug, status) VALUES ($1, $2, 'Cart watch', $3, 'ACTIVE')", [product, supplierId, product]);
  await pool.query(`INSERT INTO product_variants (id, product_id, sku, price_minor, currency, partner_commission_unit_minor, inventory_external_key, status)
    SELECT id, $2, id::text, 1000, $3, 0, id::text, 'ACTIVE' FROM unnest($1::uuid[]) id`, [variants, product, platformCurrency]);
  await pool.query(`INSERT INTO inventory_items (variant_id, source_quantity, safety_buffer, source_status, last_successful_sync_at)
    SELECT id, 120, 20, 'OK', now() FROM unnest($1::uuid[]) id`, [variants]);
});
afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

async function blockedBy(client: PoolClient) {
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await pool!.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected a real PostgreSQL Cart lock waiter");
}

describe.skipIf(!databaseUrl)("Cart against real PostgreSQL", () => {
  it("lazily creates exactly one persistent Cart under concurrency and isolates Buyers", async () => {
    const carts = await Promise.all(Array.from({ length: 8 }, () => service.read(buyer)));
    expect(new Set(carts.map((cart) => cart.id)).size).toBe(1);
    expect((await service.read(otherBuyer)).id).not.toBe(carts[0]!.id);
    await service.put(buyer, variants[0]!, 1);
    expect((await service.read(otherBuyer)).items).toEqual([]);
    const empty = await service.clear(buyer);
    expect(empty.id).toBe(carts[0]!.id); expect(empty.canCheckout).toBe(false);
  });
  it("enforces DB constraints, cascade and business FK restrictions", async () => {
    const cart = await service.read(buyer);
    for (const quantity of [0, 100]) await expect(pool!.query("INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1,$2,$3)", [cart.id, variants[0], quantity])).rejects.toThrow();
    await expect(pool!.query("INSERT INTO carts (id, buyer_user_id) VALUES ($1,$2)", [randomUUID(), buyer])).rejects.toThrow();
    await service.put(buyer, variants[0]!, 1);
    await expect(pool!.query("DELETE FROM product_variants WHERE id=$1", [variants[0]])).rejects.toThrow();
    await expect(pool!.query("DELETE FROM users WHERE id=$1", [buyer])).rejects.toThrow();
    const other = await service.put(otherBuyer, variants[0]!, 1);
    await pool!.query("DELETE FROM carts WHERE id=$1", [other.id]);
    expect((await pool!.query("SELECT 1 FROM cart_items WHERE cart_id=$1", [other.id])).rowCount).toBe(0);
  });
  it("sets absolute quantity idempotently, rejects malformed quantities and never reserves inventory", async () => {
    const before = (await pool!.query("SELECT * FROM inventory_items WHERE variant_id=$1", [variants[0]])).rows;
    for (const quantity of [0, 100, 1.5]) await expect(service.put(buyer, variants[0]!, quantity)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await service.put(buyer, variants[0]!, 99); const cart = await service.put(buyer, variants[0]!, 99);
    expect(cart.items).toHaveLength(1); expect(cart.items[0]!.quantity).toBe(99);
    expect((await pool!.query("SELECT * FROM inventory_items WHERE variant_id=$1", [variants[0]])).rows).toEqual(before);
    expect(cartResponseSchema.safeParse(cart).success).toBe(true);
  });
  it("projects live prices with exact arithmetic beyond PostgreSQL INTEGER without persisting money", async () => {
    await pool!.query("UPDATE product_variants SET price_minor=2147483647 WHERE id=$1", [variants[0]]);
    const cart = await service.read(buyer);
    expect(cart.items[0]!.lineTotalMinor).toBe(2147483647 * 99);
    expect(cart.totalMinor).toBe(2147483647 * 99);
    expect(cartResponseSchema.safeParse(cart).success).toBe(true);
    expect(JSON.stringify(cart)).not.toMatch(/sourceQuantity|source_quantity|sellable|safetyBuffer|commission|settlement/);
    await pool!.query("UPDATE product_variants SET price_minor=1000 WHERE id=$1", [variants[0]]);
  });
  it("keeps blocked lines visible, revalidates availability and rolls back failed edits", async () => {
    await service.put(buyer, variants[0]!, 2);
    for (const [sql, code] of [
      ["source_status='MISSING'", "INVENTORY_UNKNOWN"],
      ["source_status='OK', last_successful_sync_at=now()-interval '11 minutes'", "INVENTORY_STALE"],
      ["last_successful_sync_at=now(), source_quantity=21", "OUT_OF_STOCK"]
    ]) {
      await pool!.query(`UPDATE inventory_items SET ${sql} WHERE variant_id=$1`, [variants[0]]);
      const cart = await service.read(buyer);
      expect(cart.items[0]!.issues).toContain(code); expect(cart.canCheckout).toBe(false);
      await expect(service.put(buyer, variants[0]!, 2)).rejects.toMatchObject({ code });
      expect((await service.read(buyer)).items[0]!.quantity).toBe(2);
    }
    await service.put(buyer, variants[0]!, 1);
    await pool!.query("UPDATE inventory_items SET source_quantity=120 WHERE variant_id=$1", [variants[0]]);
    for (const [table, code] of [["products", "PRODUCT_NOT_ACTIVE"], ["product_variants", "VARIANT_NOT_ACTIVE"]]) {
      const id = table === "products" ? product : variants[0];
      await pool!.query(`UPDATE ${table} SET status='ARCHIVED' WHERE id=$1`, [id]);
      expect((await service.read(buyer)).items[0]!.issues).toContain("ITEM_UNAVAILABLE");
      await expect(service.put(buyer, variants[0]!, 1)).rejects.toMatchObject({ code });
      await pool!.query(`UPDATE ${table} SET status='ACTIVE' WHERE id=$1`, [id]);
    }
    await expect(service.put(buyer, randomUUID(), 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("enforces the 100-line limit even for racing additions and permits editing at the limit", async () => {
    const cart = await service.clear(buyer);
    await pool!.query("INSERT INTO cart_items (cart_id, variant_id, quantity) SELECT $1, id, 1 FROM unnest($2::uuid[]) id", [cart.id, variants.slice(0, 99)]);
    const results = await Promise.allSettled(variants.slice(99).map((id) => service.put(buyer, id, 1)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CART_LINE_LIMIT_EXCEEDED" } });
    expect((await service.put(buyer, variants[0]!, 99)).items).toHaveLength(100);
    expect((await service.read(buyer)).items.find((line) => line.variantId === variants[0])!.quantity).toBe(99);
  });
  it("serializes concurrent PUTs without losing other lines", async () => {
    await service.clear(buyer);
    await Promise.all(variants.slice(0, 8).map((id) => service.put(buyer, id, 1)));
    expect((await service.read(buyer)).items).toHaveLength(8);
    await Promise.all([service.put(buyer, variants[0]!, 2), service.put(buyer, variants[0]!, 3)]);
    expect((await service.read(buyer)).items.find((line) => line.variantId === variants[0])!.quantity).toBeOneOf([2, 3]);
  });
  it("waits for a checkout-style Cart lock and observes the committed clear before applying PUT", async () => {
    const cart = await service.read(buyer);
    const locked = await pool!.connect(); let pending: Promise<unknown> | undefined;
    try {
      await locked.query("BEGIN");
      await locked.query("SELECT id FROM carts WHERE id=$1 FOR UPDATE", [cart.id]);
      pending = service.put(buyer, variants[0]!, 4);
      await blockedBy(locked);
      await locked.query("DELETE FROM cart_items WHERE cart_id=$1", [cart.id]);
      await locked.query("COMMIT");
      await pending;
      const result = await service.read(buyer);
      expect(result.items).toHaveLength(1); expect(result.items[0]!.quantity).toBe(4);
    } finally { await locked.query("ROLLBACK"); locked.release(); await pending; }
  });
  it("PUT, DELETE item and clear all wait on the same Cart lock; repeated removal is safe", async () => {
    for (const action of [() => service.put(buyer, variants[0]!, 1), () => service.remove(buyer, variants[0]!), () => service.clear(buyer)]) {
      const cart = await service.read(buyer); const locked = await pool!.connect(); let pending: Promise<unknown> | undefined;
      try {
        await locked.query("BEGIN"); await locked.query("SELECT id FROM carts WHERE id=$1 FOR UPDATE", [cart.id]);
        pending = action(); await blockedBy(locked); await locked.query("COMMIT"); await pending;
      } finally { await locked.query("ROLLBACK"); locked.release(); await pending; }
    }
    const first = await service.remove(buyer, variants[0]!); const second = await service.remove(buyer, variants[0]!);
    expect(first).toEqual(second); expect(await service.clear(buyer)).toEqual(first);
  });
});
