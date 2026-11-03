import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { AssetService, type ObjectStorage } from "./assets.js";
import { CatalogService } from "./catalog.js";
import { inventoryTransaction, NativeInventoryService } from "../inventory/native.js";
import { demoCategories, demoWatches } from "./demo-data.js";

const operationKey = "demo-watch-catalog-v1";
const fixtureDirectory = new URL("../../fixtures/demo-catalog/", import.meta.url);

/** Atomic, create-once seed. Replays preserve edits, reservations and remaining stock. */
export async function seedDemoCatalog(pool: Pool, storage: ObjectStorage): Promise<{ replayed: boolean; products: number }> {
  const uploaded: string[] = [];
  const tracked: ObjectStorage = {
    put: async (...args) => { uploaded.push(args[0]); await storage.put(...args); },
    get: key => storage.get(key), delete: key => storage.delete(key)
  };
  try {
    return await inventoryTransaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(1463899203,1)");
      await client.query("SELECT pg_advisory_xact_lock(1463899203,2)");
      const existing = await client.query("SELECT id FROM inventory_initializations WHERE operation_key=$1", [operationKey]);
      if (existing.rowCount) return { replayed: true, products: demoWatches.length };
      // This fixture selects native stock authority: never mix it into a working shop.
      const occupied = await client.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM products)
        OR EXISTS(SELECT 1 FROM orders) OR EXISTS(SELECT 1 FROM inventory_initializations)
        OR EXISTS(SELECT 1 FROM categories) OR EXISTS(SELECT 1 FROM inventory_authority)`);
      if (occupied.rowCount) throw new Error("Demo catalog requires an empty catalog in a separate development database");
      const currency = await client.query("SELECT platform_currency FROM platform_settings WHERE singleton_id=1");
      if (currency.rows[0] && currency.rows[0].platform_currency !== "BYN") throw new Error("Demo prices require BYN");
      await client.query("INSERT INTO platform_settings(platform_currency) VALUES('BYN') ON CONFLICT DO NOTHING");
      await client.query("INSERT INTO suppliers(id,name) VALUES($1,'Демонстрационный поставщик') ON CONFLICT DO NOTHING", [randomUUID()]);
      const actor = randomUUID();
      // Audit identity only: no Admin privileges, Session or Telegram login bypass.
      await client.query("INSERT INTO users(id,telegram_user_id,first_name) VALUES($1,-690001,'Демокаталог')", [actor]);
      const op = { actorUserId: actor, operationKey, reason: "Тестовый каталог: вымышленные цены и остатки", occurredAt: new Date() };
      const native = new NativeInventoryService(pool);
      await native.selectAuthority(client, op);
      const catalog = new CatalogService(pool, "BYN", undefined, undefined, client, true);
      const assets = new AssetService(pool, tracked, client);
      const categories = [];
      for (const [sortOrder, category] of demoCategories.entries()) {
        categories.push(await catalog.createCategory(actor, { ...category, sortOrder }));
      }
      const entries = [];
      const cards = [];
      for (const watch of demoWatches) {
        const product = await catalog.createProduct(actor, {
          title: watch.title, brand: watch.brand, categoryIds: [categories[watch.category]!.id],
          description: `${watch.title} — ${watch.mechanism.toLowerCase()} механизм, цвет: ${watch.color.toLowerCase()}. Демонстрационная карточка для проверки магазина. Фото иллюстративное и может не соответствовать модели; цены, характеристики и остатки тестовые.`,
          specifications: { "Механизм": watch.mechanism, "Цвет": watch.color, "Назначение": "Демонстрация интерфейса" }
        });
        const variant = await catalog.createVariant(actor, product.id, {
          sku: watch.sku, inventoryExternalKey: watch.sku, attributes: { "Цвет": watch.color },
          priceMinor: watch.priceMinor, dropshipPriceMinor: watch.priceMinor,
          partnerCommissionUnitMinor: 0
        });
        const path = fileURLToPath(new URL(watch.photo, fixtureDirectory));
        await assets.createMedia(actor, product.id, {
          type: "IMAGE", purpose: "STOREFRONT", variantId: null,
          path, mimeType: "image/jpeg", sizeBytes: (await stat(path)).size
        });
        entries.push({ variantId: variant.id, quantity: watch.quantity, cost: watch.quantity === 0 ? 0 : null });
        cards.push({ productId: product.id, variantId: variant.id });
      }
      const initializationId = randomUUID();
      await client.query(`INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at)
        VALUES($1,$2,'demo-fixtures-v1',$3,$4,$5)`, [initializationId, operationKey, actor, op.reason, op.occurredAt]);
      await native.initialize(client, op, initializationId, entries);
      for (const card of cards) {
        await catalog.updateVariant(actor, card.variantId, { status: "ACTIVE" });
        await catalog.updateProduct(actor, card.productId, { status: "ACTIVE" });
      }
      return { replayed: false, products: cards.length };
    });
  } catch (error) {
    await Promise.all(uploaded.map(key => storage.delete(key).catch(() => undefined)));
    throw error;
  }
}
