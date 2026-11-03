import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObjectStorage } from "./assets.js";
import { CatalogService } from "./catalog.js";
import { seedDemoCatalog } from "./demo.js";
import { NativeInventoryService } from "../inventory/native.js";

const url = process.env.TEST_DATABASE_URL;
let admin: Pool;
let pool: Pool;
let schema: string;
let storage: ObjectStorage;
let objects: Map<string, Buffer>;

describe.skipIf(!url)("Demo catalog on isolated PostgreSQL schema", () => {
  beforeEach(async () => {
    schema = `demo_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({ connectionString: url! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url!, options: `-c search_path=${schema},public`, max: 1 });
    await pool.query(`SET search_path TO ${schema},public`);
    const root = new URL("../../../../packages/db/prisma/migrations/", import.meta.url);
    for (const name of (await readdir(root)).filter(name => /^\d/.test(name)).sort()) {
      await pool.query(await readFile(new URL(`${name}/migration.sql`, root), "utf8"));
    }
    objects = new Map();
    storage = {
      put: async (key, path) => { objects.set(key, await readFile(path)); },
      get: async key => Readable.from(objects.get(key)!),
      delete: async key => { objects.delete(key); }
    };
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("publishes real catalog cards, images, brand filters and native stock", async () => {
    expect(await seedDemoCatalog(pool, storage)).toEqual({ replayed: false, products: 8 });
    const catalog = new CatalogService(pool, "BYN", undefined, undefined, undefined, true);
    const listing = await catalog.listStorefrontProducts({ page: 1, limit: 20 });
    expect(listing.items).toHaveLength(8);
    expect(listing.items.filter(p => p.availability === "IN_STOCK")).toHaveLength(7);
    expect(listing.items.filter(p => p.availability === "OUT_OF_STOCK")).toHaveLength(1);
    expect(listing.items.every(p => p.gallery.length === 1 && p.gallery[0]?.mediaUrl)).toBe(true);
    expect(objects.size).toBe(8);
    expect((await catalog.listStorefrontProducts({ page: 1, limit: 20, brand: "Casio" })).items).toHaveLength(2);
    expect((await pool.query("SELECT sum(native_on_hand)::int AS units FROM inventory_items")).rows[0].units).toBe(29);
    expect((await pool.query("SELECT is_admin FROM users WHERE telegram_user_id=-690001")).rows[0].is_admin).toBe(false);
  });

  it("replays without resetting edited cards or changed stock", async () => {
    await seedDemoCatalog(pool, storage);
    const row = (await pool.query(`SELECT v.id,p.id AS product_id,u.id AS actor FROM product_variants v
      JOIN products p ON p.id=v.product_id CROSS JOIN users u WHERE v.sku='DEMO-CASIO-A168'`)).rows[0];
    await pool.query("UPDATE products SET title='Edited demo' WHERE id=$1", [row.product_id]);
    await new NativeInventoryService(pool).change({ actorUserId: row.actor, operationKey: randomUUID(),
      reason: "Test adjustment", occurredAt: new Date() }, row.id, "CORRECTION", -1, null);
    expect(await seedDemoCatalog(pool, storage)).toEqual({ replayed: true, products: 8 });
    expect((await pool.query("SELECT native_on_hand FROM inventory_items WHERE variant_id=$1", [row.id])).rows[0].native_on_hand).toBe(7);
    expect((await pool.query("SELECT title FROM products WHERE id=$1", [row.product_id])).rows[0].title).toBe("Edited demo");
    expect(objects.size).toBe(8);
  });

  it("rolls back the entire catalog and cleans uploaded media after storage failure", async () => {
    const put = storage.put;
    let uploads = 0;
    storage.put = async (...args) => { await put(...args); if (++uploads === 2) throw new Error("storage offline"); };
    await expect(seedDemoCatalog(pool, storage)).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int AS count FROM products")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory_authority")).rows[0].count).toBe(0);
    expect(objects.size).toBe(0);
    storage.put = put;
    expect((await seedDemoCatalog(pool, storage)).replayed).toBe(false);
  });

  it("refuses an occupied catalog without changing it", async () => {
    await pool.query("INSERT INTO categories(id,name,slug) VALUES($1,'Existing','existing')", [randomUUID()]);
    await expect(seedDemoCatalog(pool, storage)).rejects.toThrow(/empty catalog/);
    expect((await pool.query("SELECT count(*)::int AS count FROM categories")).rows[0].count).toBe(1);
    expect(objects.size).toBe(0);
  });
});
