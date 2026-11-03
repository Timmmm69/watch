import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { AssetService, type ObjectStorage } from "./assets.js";
import { CatalogService, CatalogValidationError } from "./catalog.js";
import {
  inventoryTransaction,
  NativeInventoryService,
} from "../inventory/native.js";
import { replayOperation, rememberOperation } from "./operations.js";
import { demoCategories, demoWatches } from "./demo-data.js";

/** Owner-triggered, once per shop. Never changes existing products, stock or financial records. */
export async function addOwnerDemo(
  pool: Pool,
  currency: string,
  storage: ObjectStorage,
  actor: string,
  fixtureDirectory: string,
) {
  if (currency !== "BYN")
    throw new CatalogValidationError(
      "Тестовые цены подготовлены в BYN. Валюта магазина не изменялась.",
    );
  const uploaded: string[] = [];
  const tracked: ObjectStorage = {
    put: async (...args) => {
      uploaded.push(args[0]);
      await storage.put(...args);
    },
    get: (key) => storage.get(key),
    delete: (key) => storage.delete(key),
  };
  try {
    return await inventoryTransaction(pool, async (client) => {
      const key = "owner-test-watches-v1",
        request = { version: 1 };
      // The once-per-shop key is shared by all admins; return it without making the second admin the original actor.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('admin-catalog:' || $1::text,0))",
        [key],
      );
      const old = (
        await client.query(
          "SELECT result FROM admin_catalog_operations WHERE operation_key=$1",
          [key],
        )
      ).rows[0];
      if (old) return { ...old.result, replayed: true };
      const collisions = await client.query(
        "SELECT sku FROM product_variants WHERE lower(sku)=ANY($1::text[])",
        [demoWatches.map((w) => w.sku.toLowerCase())],
      );
      if (collisions.rowCount)
        throw new CatalogValidationError(
          "Найдены товары с тестовыми артикулами. Проверьте их перед добавлением; ничего не изменено.",
          { issues: ["В каталоге уже есть тестовые артикулы. Проверьте их."] },
        );
      const native = new NativeInventoryService(pool),
        catalog = new CatalogService(
          pool,
          currency,
          undefined,
          undefined,
          client,
          true,
        ),
        assets = new AssetService(pool, tracked, client);
      const op = {
        actorUserId: actor,
        operationKey: key,
        reason:
          "Тестовый каталог: иллюстративные фото, тестовые цены и остатки",
        occurredAt: new Date(),
      };
      await native.selectAuthority(client, op);
      const categories = [];
      for (const [sortOrder, c] of demoCategories.entries()) {
        const oldCategory = (
          await client.query("SELECT id FROM categories WHERE slug=$1", [
            c.slug,
          ])
        ).rows[0];
        if (oldCategory)
          throw new CatalogValidationError(
            "Категории тестового каталога уже существуют. Проверьте их; ничего не изменено.",
          );
        categories.push(
          await catalog.createCategory(actor, {
            ...c,
            name: `${c.name} · тест`,
            sortOrder,
          }),
        );
      }
      const cards = [],
        entries = [];
      for (const w of demoWatches) {
        const p = await catalog.createProduct(actor, {
          title: `${w.title} · ТЕСТ`,
          brand: w.brand,
          categoryIds: [categories[w.category]!.id],
          description: `${w.title}. ${w.mechanism} механизм, цвет: ${w.color.toLowerCase()}. ТЕСТОВЫЙ ТОВАР. Фото иллюстративное и может не соответствовать точной модели. Цена, характеристики и остаток приведены только для проверки магазина.`,
        });
        const v = await catalog.createVariant(actor, p.id, {
          sku: w.sku,
          inventoryExternalKey: w.sku,
          priceMinor: w.priceMinor,
          dropshipPriceMinor: w.priceMinor,
          partnerCommissionUnitMinor: 0,
          attributes: { Цвет: w.color },
        });
        const path = join(fixtureDirectory, w.photo);
        await assets.createMedia(actor, p.id, {
          type: "IMAGE",
          purpose: "STOREFRONT",
          variantId: null,
          path,
          mimeType: "image/jpeg",
          sizeBytes: (await stat(path)).size,
        });
        cards.push({ id: p.id, variantId: v.id });
        entries.push({
          variantId: v.id,
          quantity: w.quantity,
          cost: w.quantity === 0 ? 0 : null,
        });
      }
      const initialization = randomUUID();
      await client.query(
        "INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at) VALUES($1,$2,'owner-test-catalog',$3,$4,$5)",
        [initialization, key, actor, op.reason, op.occurredAt],
      );
      await native.initialize(client, op, initialization, entries);
      for (const c of cards) {
        await catalog.updateVariant(actor, c.variantId, { status: "ACTIVE" });
        await catalog.updateProduct(actor, c.id, { status: "ACTIVE" });
      }
      const result = {
        products: cards.length,
        ids: cards.map((c) => c.id),
        replayed: false,
      };
      await rememberOperation(client, key, actor, "DEMO", request, result);
      return result;
    });
  } catch (error) {
    await Promise.all(
      uploaded.map((key) => storage.delete(key).catch(() => undefined)),
    );
    throw error;
  }
}
