import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssetService, type ObjectStorage } from "./assets.js";
import { CatalogService, initializePlatformCurrency, seedSupplier } from "./catalog.js";
import { ActiveProductInvariantError } from "./invariant.js";

const pool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
const actorId = randomUUID();
const suffix = randomUUID().slice(0, 8);
let categoryId = "";
let productId = "";
let variantId = "";
let assetId = "";
let catalog: CatalogService;
let assets: AssetService;
const deletedKeys: string[] = [];

const storage: ObjectStorage = {
  async put() {}, async get() { return Readable.from([Buffer.from("media")]); },
  async delete(key) { deletedKeys.push(key); }
};

beforeAll(async () => {
  if (!pool) return;
  const currency = (await initializePlatformCurrency(pool, process.env.TEST_PLATFORM_CURRENCY ?? "BYN")).platformCurrency;
  await seedSupplier(pool, "Integration supplier");
  catalog = new CatalogService(pool, currency);
  assets = new AssetService(pool, storage);
  await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, $2, 'Assets')", [actorId, String(BigInt(Date.now()) * 10000n + 1234n)]);
});

afterAll(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id = $1", [actorId]);
  if (productId) await pool.query("DELETE FROM product_assets WHERE product_id = $1", [productId]);
  if (variantId) await pool.query("DELETE FROM inventory_items WHERE variant_id = $1", [variantId]);
  if (variantId) await pool.query("DELETE FROM product_variants WHERE id = $1", [variantId]);
  if (productId) await pool.query("DELETE FROM products WHERE id = $1", [productId]);
  if (categoryId) await pool.query("DELETE FROM categories WHERE id = $1", [categoryId]);
  await pool.query("DELETE FROM users WHERE id = $1", [actorId]);
  await pool.end();
});

describe.skipIf(!pool)("Product assets and continuous ACTIVE invariant", () => {
  it("publishes only after category, active variant and storefront image, then protects each child", async () => {
    const category = await catalog.createCategory(actorId, { name: `Assets ${suffix}`, sortOrder: 0 });
    categoryId = category.id;
    const product = await catalog.createProduct(actorId, { title: `Assets ${suffix}`, categoryIds: [categoryId] });
    productId = product.id;
    const variant = await catalog.createVariant(actorId, productId, {
      sku: `sku-${suffix}`, priceMinor: 1000, partnerCommissionUnitMinor: 100,
      inventoryExternalKey: `ext-${suffix}`
    });
    variantId = variant.id;
    await expect(catalog.updateProduct(actorId, productId, { status: "ACTIVE" }))
      .rejects.toBeInstanceOf(ActiveProductInvariantError);
    await catalog.updateVariant(actorId, variantId, { status: "ACTIVE" });
    await expect(catalog.updateProduct(actorId, productId, { status: "ACTIVE" }))
      .rejects.toBeInstanceOf(ActiveProductInvariantError);
    const image = await assets.createMedia(actorId, productId, {
      type: "IMAGE", purpose: "STOREFRONT", variantId: null, path: "unused",
      mimeType: "image/jpeg", sizeBytes: 4
    });
    assetId = image.id;
    await catalog.updateProduct(actorId, productId, { status: "ACTIVE" });
    const partnerText = await assets.createText(actorId, productId, {
      text: "Partner briefing", purpose: "PARTNER_CONTENT"
    });
    expect(partnerText.text).toBe("Partner briefing");
    const partnerVideo = await assets.createMedia(actorId, productId, {
      type: "VIDEO", purpose: "PARTNER_CONTENT", variantId: null, path: "unused",
      mimeType: "video/mp4", sizeBytes: 4
    });
    const detail = await catalog.getStorefrontProduct(product.slug);
    expect(detail.gallery).toMatchObject([{ id: assetId, mediaUrl: `/api/v1/catalog/assets/${assetId}/media` }]);
    expect(detail.gallery.some((asset) => asset.id === partnerText.id)).toBe(false);
    expect(detail.gallery.some((asset) => asset.id === partnerVideo.id)).toBe(false);
    await expect(assets.media(partnerVideo.id, false)).rejects.toThrow();
    expect((await assets.media(partnerVideo.id, true)).mimeType).toBe("video/mp4");
    await expect(assets.createText(actorId, productId, {
      text: "Wrong variant", purpose: "STOREFRONT", variantId: randomUUID()
    })).rejects.toThrow(/Variant/);
    await expect(assets.createMedia(actorId, productId, {
      type: "IMAGE", purpose: "STOREFRONT", variantId: randomUUID(), path: "unused",
      mimeType: "image/jpeg", sizeBytes: 4
    })).rejects.toThrow(/Variant/);
    expect(deletedKeys).toHaveLength(1);
    await expect(assets.update(actorId, assetId, { status: "ARCHIVED" }))
      .rejects.toBeInstanceOf(ActiveProductInvariantError);
    await expect(assets.update(actorId, assetId, { purpose: "PARTNER_CONTENT" }))
      .rejects.toBeInstanceOf(ActiveProductInvariantError);
    await expect(catalog.updateVariant(actorId, variantId, { status: "ARCHIVED" }))
      .rejects.toBeInstanceOf(ActiveProductInvariantError);
    await expect(catalog.updateCategory(actorId, categoryId, { status: "ARCHIVED" }))
      .rejects.toBeInstanceOf(ActiveProductInvariantError);
    expect((await assets.list(productId)).find((asset) => asset.id === assetId)?.status).toBe("ACTIVE");
  });
});
