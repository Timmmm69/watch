import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CatalogService,
  CatalogValidationError,
  initializePlatformCurrency,
  seedSupplier
} from "./catalog.js";
import { ActiveProductInvariantError, type ProductAssetChecks } from "./invariant.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

const assetChecks: ProductAssetChecks = {
  async countActiveStorefrontImages() {
    return 1;
  }
};

let platformCurrency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";
let supplierId = "";
let service!: CatalogService;
let serviceWithAssets!: CatalogService;

const actorUserId = randomUUID();
const categoryIds: string[] = [];
const productIds: string[] = [];
const variantIds: string[] = [];

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

beforeAll(async () => {
  if (!pool) return;
  const initialized = await initializePlatformCurrency(pool, process.env.TEST_PLATFORM_CURRENCY ?? "BYN");
  platformCurrency = initialized.platformCurrency;
  const supplier = await seedSupplier(pool, "Integration supplier");
  supplierId = supplier.supplierId;
  service = new CatalogService(pool, platformCurrency);
  serviceWithAssets = new CatalogService(pool, platformCurrency, assetChecks);
  const telegramUserId = (BigInt(Date.now()) * 1000n + BigInt(`0x${randomBytes(4).toString("hex")}`) % 1000n).toString();
  await pool.query(
    "INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, $2, 'Catalog')",
    [actorUserId, telegramUserId]
  );
});

afterAll(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id = $1", [actorUserId]);
  await pool.query("DELETE FROM inventory_items WHERE variant_id = ANY($1::uuid[])", [variantIds]);
  await pool.query("DELETE FROM product_variants WHERE id = ANY($1::uuid[])", [variantIds]);
  await pool.query("DELETE FROM products WHERE id = ANY($1::uuid[])", [productIds]);
  await pool.query("DELETE FROM categories WHERE id = ANY($1::uuid[])", [categoryIds]);
  await pool.query("DELETE FROM users WHERE id = $1", [actorUserId]);
  await pool.end();
});

describe.skipIf(!databaseUrl)("Catalog foundation against PostgreSQL", () => {
  it("persists the platform currency exactly once and rejects any mutation", async () => {
    const again = await initializePlatformCurrency(pool!, platformCurrency);
    expect(again.created).toBe(false);
    expect(again.platformCurrency).toBe(platformCurrency);
    await expect(initializePlatformCurrency(pool!, platformCurrency === "USD" ? "EUR" : "USD"))
      .rejects.toThrow(/immutable/);
    await expect(pool!.query("UPDATE platform_settings SET platform_currency = 'USD'")).rejects.toThrow();
    await expect(pool!.query("DELETE FROM platform_settings")).rejects.toThrow();
    const persisted = await pool!.query<{ platform_currency: string }>(
      "SELECT platform_currency FROM platform_settings"
    );
    expect(persisted.rows[0]?.platform_currency).toBe(platformCurrency);
  });

  it("allows at most one ACTIVE supplier", async () => {
    const seeded = await Promise.all([
      seedSupplier(pool!, "Concurrent supplier A"),
      seedSupplier(pool!, "Concurrent supplier B")
    ]);
    expect(seeded.map((supplier) => supplier.supplierId)).toEqual([supplierId, supplierId]);
    expect(seeded.every((supplier) => !supplier.created)).toBe(true);
    await expect(
      pool!.query("INSERT INTO suppliers (id, name) VALUES ($1, $2)", [randomUUID(), unique("supplier")])
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("requires the configured currency to equal the persisted currency for readiness", async () => {
    await expect(service.verifyCurrencyConfigured()).resolves.toBeUndefined();
    const mismatched = new CatalogService(pool!, platformCurrency === "USD" ? "EUR" : "USD");
    await expect(mismatched.verifyCurrencyConfigured()).rejects.toThrow(/mismatch/);
  });

  it("creates draft catalog entities with the sole supplier and platform currency", async () => {
    const category = await service.createCategory(actorUserId, { name: "Интеграция", slug: unique("cat"), sortOrder: 5 });
    categoryIds.push(category.id);
    expect(category).toMatchObject({ status: "ACTIVE", sortOrder: 5 });
    expect(category.slug).toContain("cat-");
    await expect(
      service.createCategory(actorUserId, { name: "Duplicate", slug: category.slug, sortOrder: 0 })
    ).rejects.toBeInstanceOf(CatalogValidationError);
    await expect(
      service.createCategory(actorUserId, { name: "Empty", slug: "!!!", sortOrder: 0 })
    ).rejects.toBeInstanceOf(CatalogValidationError);

    await expect(
      service.createProduct(actorUserId, { title: "Unknown", categoryIds: [randomUUID()] })
    ).rejects.toBeInstanceOf(CatalogValidationError);

    const searchToken = unique("watch");
    const product = await service.createProduct(actorUserId, {
      title: searchToken,
      description: "draft",
      brand: "Casio",
      specifications: { case: "steel" },
      categoryIds: [category.id]
    });
    productIds.push(product.id);
    expect(product).toMatchObject({ status: "DRAFT", supplierId, brand: "Casio" });

    const listing = await service.listProducts({ q: searchToken, page: 1, limit: 20 });
    expect(listing.total).toBe(1);
    expect(listing.items[0]?.id).toBe(product.id);

    const variant = await service.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      attributes: { size: "42" },
      priceMinor: 100_000,
      partnerCommissionUnitMinor: 5_000,
      supplierSettlementUnitMinor: 80_000,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(variant.id);
    expect(variant).toMatchObject({ status: "DRAFT", currency: platformCurrency, priceMinor: 100_000 });
    expect(variant.inventory).toMatchObject({
      sourceQuantity: null,
      safetyBuffer: 0,
      sourceStatus: "UNINITIALIZED",
      sourceVersion: null,
      lastSuccessfulSyncAt: null,
      lastSuccessfulSyncRunId: null
    });

    await expect(
      service.createVariant(actorUserId, product.id, {
        sku: variant.sku,
        priceMinor: 1,
        partnerCommissionUnitMinor: 0,
        inventoryExternalKey: unique("key")
      })
    ).rejects.toBeInstanceOf(CatalogValidationError);
    await expect(
      service.createVariant(actorUserId, product.id, {
        sku: unique("SKU"),
        priceMinor: 10_000,
        partnerCommissionUnitMinor: 5_000,
        supplierSettlementUnitMinor: 6_000,
        inventoryExternalKey: unique("key")
      })
    ).rejects.toBeInstanceOf(CatalogValidationError);

    const detail = await service.getProduct(product.id);
    expect(detail.categories).toHaveLength(1);
    expect(detail.categories[0]?.id).toBe(category.id);
    expect(detail.variants[0]?.inventory?.sourceStatus).toBe("UNINITIALIZED");
    await expect(service.getProduct(randomUUID())).rejects.toThrow("Product not found");
  });

  it("rejects Product activation before storefront images exist", async () => {
    const category = await service.createCategory(actorUserId, { name: unique("cat"), sortOrder: 0 });
    categoryIds.push(category.id);
    const product = await service.createProduct(actorUserId, {
      title: unique("blocked activation"),
      categoryIds: [category.id]
    });
    productIds.push(product.id);
    const variant = await service.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      priceMinor: 50_000,
      partnerCommissionUnitMinor: 1_000,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(variant.id);
    await service.updateVariant(actorUserId, variant.id, { status: "ACTIVE" });

    try {
      await service.updateProduct(actorUserId, product.id, { status: "ACTIVE" });
      expect.unreachable("activation must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ActiveProductInvariantError);
      expect((error as ActiveProductInvariantError).invariant.unmet).toEqual(["ACTIVE_STOREFRONT_IMAGE_REQUIRED"]);
    }
    const persisted = await pool!.query<{ status: string }>("SELECT status FROM products WHERE id = $1", [product.id]);
    expect(persisted.rows[0]?.status).toBe("DRAFT");
  });

  it("continuously enforces the ACTIVE Product invariant on related mutations", async () => {
    const categoryA = await serviceWithAssets.createCategory(actorUserId, { name: unique("catA"), sortOrder: 1 });
    const categoryB = await serviceWithAssets.createCategory(actorUserId, { name: unique("catB"), sortOrder: 2 });
    categoryIds.push(categoryA.id, categoryB.id);
    const product = await serviceWithAssets.createProduct(actorUserId, {
      title: unique("invariant product"),
      categoryIds: [categoryA.id]
    });
    productIds.push(product.id);
    const variant = await serviceWithAssets.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      priceMinor: 70_000,
      partnerCommissionUnitMinor: 2_000,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(variant.id);

    await serviceWithAssets.updateVariant(actorUserId, variant.id, { status: "ACTIVE" });
    const activated = await serviceWithAssets.updateProduct(actorUserId, product.id, { status: "ACTIVE" });
    expect(activated.status).toBe("ACTIVE");

    await expect(
      serviceWithAssets.updateCategory(actorUserId, categoryA.id, { status: "ARCHIVED" })
    ).rejects.toBeInstanceOf(ActiveProductInvariantError);

    await serviceWithAssets.updateProduct(actorUserId, product.id, { categoryIds: [categoryA.id, categoryB.id] });
    await serviceWithAssets.updateCategory(actorUserId, categoryA.id, { status: "ARCHIVED" });

    await expect(
      serviceWithAssets.updateVariant(actorUserId, variant.id, { status: "ARCHIVED" })
    ).rejects.toBeInstanceOf(ActiveProductInvariantError);

    const repriced = await serviceWithAssets.updateVariant(actorUserId, variant.id, { priceMinor: 123_456 });
    expect(repriced.priceMinor).toBe(123_456);

    await serviceWithAssets.updateProduct(actorUserId, product.id, { status: "ARCHIVED" });
    const reactivated = await serviceWithAssets.updateProduct(actorUserId, product.id, { status: "ACTIVE" });
    expect(reactivated.status).toBe("ACTIVE");
  });

  it("filters the public catalog by search, category, brand, one SKU price range, and availability", async () => {
    const token = unique("discovery");
    const firstCategory = await serviceWithAssets.createCategory(actorUserId, { name: unique("first"), sortOrder: 1 });
    const secondCategory = await serviceWithAssets.createCategory(actorUserId, { name: unique("second"), sortOrder: 2 });
    categoryIds.push(firstCategory.id, secondCategory.id);
    const first = await serviceWithAssets.createProduct(actorUserId, {
      title: `${token} first`, brand: "Casio", categoryIds: [firstCategory.id]
    });
    const second = await serviceWithAssets.createProduct(actorUserId, {
      title: `${token} second`, brand: "Seiko", categoryIds: [secondCategory.id]
    });
    productIds.push(first.id, second.id);
    const makeVariant = async (productId: string, priceMinor: number) => {
      const variant = await serviceWithAssets.createVariant(actorUserId, productId, {
        sku: unique("SKU"), priceMinor, partnerCommissionUnitMinor: 0,
        inventoryExternalKey: unique("key")
      });
      variantIds.push(variant.id);
      await serviceWithAssets.updateVariant(actorUserId, variant.id, { status: "ACTIVE" });
      return variant.id;
    };
    const firstLow = await makeVariant(first.id, 10_000);
    await makeVariant(first.id, 30_000);
    const secondVariant = await makeVariant(second.id, 20_000);
    await serviceWithAssets.updateProduct(actorUserId, first.id, { status: "ACTIVE" });
    await serviceWithAssets.updateProduct(actorUserId, second.id, { status: "ACTIVE" });
    await pool!.query("UPDATE inventory_items SET source_quantity = 2, source_status = 'OK', last_successful_sync_at = now() WHERE variant_id = $1", [firstLow]);
    await pool!.query("UPDATE inventory_items SET source_quantity = 0, source_status = 'OK', last_successful_sync_at = now() WHERE variant_id = $1", [secondVariant]);

    const all = await serviceWithAssets.listStorefrontProducts({ q: token, page: 1, limit: 1 });
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(1);
    const next = await serviceWithAssets.listStorefrontProducts({ q: token, page: 2, limit: 1 });
    expect(next.total).toBe(2);
    expect(next.items[0]?.id).not.toBe(all.items[0]?.id);
    expect((await serviceWithAssets.listStorefrontProducts({ q: "%", page: 1, limit: 20 })).items).toEqual([]);
    const priced = await serviceWithAssets.listStorefrontProducts({ q: token, minPriceMinor: 15_000, maxPriceMinor: 25_000, page: 1, limit: 20 });
    expect(priced.items.map((item) => item.id)).toEqual([second.id]);
    const category = await serviceWithAssets.listStorefrontProducts({ category: firstCategory.slug, brand: "casio", page: 1, limit: 20 });
    expect(category.items.map((item) => item.id)).toEqual([first.id]);
    expect(category.items[0]?.availability).toBe("IN_STOCK");
    const out = await serviceWithAssets.listStorefrontProducts({ q: token, availability: "OUT_OF_STOCK", page: 1, limit: 20 });
    expect(out.items.map((item) => item.id)).toEqual([second.id]);
    await pool!.query("UPDATE inventory_items SET last_successful_sync_at = now() - interval '601 seconds' WHERE variant_id = $1", [secondVariant]);
    const stale = await serviceWithAssets.getStorefrontProduct(second.slug);
    expect(stale.availability).toBe("STALE");
    expect(stale.variants[0]?.availability).toBe("STALE");
    const staleList = await serviceWithAssets.listStorefrontProducts({ q: token, availability: "STALE", page: 1, limit: 20 });
    expect(staleList.items.map((item) => item.id)).toEqual([second.id]);
    await pool!.query("UPDATE inventory_items SET source_status = 'MISSING', source_quantity = NULL WHERE variant_id = $1", [firstLow]);
    const unknown = await serviceWithAssets.listStorefrontProducts({ q: token, availability: "UNKNOWN", page: 1, limit: 20 });
    expect(unknown.items.map((item) => item.id)).toEqual([first.id]);
  });

  it("rejects invalid status transitions", async () => {
    const product = await service.createProduct(actorUserId, { title: unique("transitions") });
    productIds.push(product.id);
    await expect(
      service.updateProduct(actorUserId, product.id, { status: "ACTIVE" })
    ).rejects.toBeInstanceOf(ActiveProductInvariantError);
    const archived = await service.updateProduct(actorUserId, product.id, { status: "ARCHIVED" });
    expect(archived.status).toBe("ARCHIVED");
    await expect(
      service.updateProduct(actorUserId, product.id, { status: "DRAFT" })
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("resets inventory source state when the external key changes", async () => {
    const product = await service.createProduct(actorUserId, { title: unique("reset product") });
    productIds.push(product.id);
    const variant = await service.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      priceMinor: 30_000,
      partnerCommissionUnitMinor: 1_000,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(variant.id);

    await pool!.query(
      `UPDATE inventory_items
          SET source_quantity = 5, source_status = 'OK', source_version = 'v1', last_successful_sync_at = now()
        WHERE variant_id = $1`,
      [variant.id]
    );

    const reset = await service.updateVariant(actorUserId, variant.id, { inventoryExternalKey: unique("key2") });
    expect(reset.inventory).toMatchObject({
      sourceQuantity: null,
      sourceStatus: "UNINITIALIZED",
      sourceVersion: null,
      lastSuccessfulSyncAt: null,
      lastSuccessfulSyncRunId: null,
      safetyBuffer: 0
    });

    await pool!.query(
      `UPDATE inventory_items
          SET source_quantity = 5, source_status = 'OK', source_version = 'v2', last_successful_sync_at = now()
        WHERE variant_id = $1`,
      [variant.id]
    );
    const untouched = await service.updateVariant(actorUserId, variant.id, { safetyBuffer: 3 });
    expect(untouched.inventory).toMatchObject({
      sourceQuantity: 5,
      sourceStatus: "OK",
      sourceVersion: "v2",
      safetyBuffer: 3
    });
  });

  it("blocks external-key mutation while an ACTIVE reservation exists (BR-019B)", async () => {
    const product = await service.createProduct(actorUserId, { title: unique("reservation product") });
    productIds.push(product.id);
    const variant = await service.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      priceMinor: 30_000,
      partnerCommissionUnitMinor: 1_000,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(variant.id);
    await pool!.query(
      `UPDATE inventory_items
          SET source_quantity = 9, source_status = 'OK', source_version = 'v9', last_successful_sync_at = now()
        WHERE variant_id = $1`,
      [variant.id]
    );

    const salesTermsDocument = randomUUID();
    const privacyDocument = randomUUID();
    for (const [id, type] of [[salesTermsDocument, "SALES_TERMS"], [privacyDocument, "PRIVACY"]] as const) {
      await pool!.query(
        `INSERT INTO legal_documents (id, type, version, sha256, content_markdown, effective_at)
         VALUES ($1, $2, $3, $4, '# order terms', now())`,
        [id, type, unique("v"), randomBytes(32).toString("hex")]
      );
    }
    const orderId = randomUUID();
    await pool!.query(
      `INSERT INTO orders (id, public_number, buyer_user_id, supplier_id, currency, subtotal_minor, total_minor,
          sales_terms_document_id, privacy_document_id, sales_terms_accepted_at, privacy_acknowledged_at,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, 30000, 30000, $6, $7, now(), now(), $8, $9)`,
      [orderId, `W-${randomBytes(6).toString("hex").toUpperCase().slice(0, 12)}`, actorUserId, supplierId,
        platformCurrency, salesTermsDocument, privacyDocument, unique("idem"), randomBytes(32).toString("hex")]
    );
    await pool!.query(
      `INSERT INTO order_items (id, order_id, variant_id, sku_snapshot, title_snapshot, quantity,
          unit_price_minor, partner_commission_unit_snapshot_minor, line_total_minor)
       VALUES ($1, $2, $3, $4, 'Reservation watch', 1, 30000, 1000, 30000)`,
      [randomUUID(), orderId, variant.id, variant.sku]
    );
    await pool!.query(
      "INSERT INTO inventory_reservations (id, order_id, variant_id, quantity) VALUES ($1, $2, $3, 1)",
      [randomUUID(), orderId, variant.id]
    );

    const blocked = await service.updateVariant(actorUserId, variant.id, {
      inventoryExternalKey: unique("blocked-key")
    }).catch((error: unknown) => error as CatalogValidationError);
    expect(blocked).toBeInstanceOf(CatalogValidationError);
    expect((blocked as CatalogValidationError).code).toBe("INVENTORY_EXTERNAL_KEY_IN_USE");
    const unchanged = (await pool!.query<{
      inventory_external_key: string; source_status: string; source_version: string | null;
    }>(
      `SELECT v.inventory_external_key, i.source_status, i.source_version
         FROM product_variants v JOIN inventory_items i ON i.variant_id = v.id
        WHERE v.id = $1`,
      [variant.id]
    )).rows[0]!;
    expect(unchanged.inventory_external_key).toBe(variant.inventoryExternalKey);
    expect(unchanged).toMatchObject({ source_status: "OK", source_version: "v9" });

    const sameKey = await service.updateVariant(actorUserId, variant.id, {
      inventoryExternalKey: variant.inventoryExternalKey
    });
    expect(sameKey.inventoryExternalKey).toBe(variant.inventoryExternalKey);
    expect(sameKey.inventory).toMatchObject({ sourceQuantity: 9, sourceStatus: "OK", sourceVersion: "v9" });

    await pool!.query(
      "UPDATE inventory_reservations SET status = 'RELEASED', released_at = now() WHERE order_id = $1",
      [orderId]
    );
    const releasedKey = unique("released-key");
    const changed = await service.updateVariant(actorUserId, variant.id, {
      inventoryExternalKey: releasedKey
    });
    expect(changed.inventoryExternalKey).toBe(releasedKey);
    expect(changed.inventory).toMatchObject({
      sourceQuantity: null,
      sourceStatus: "UNINITIALIZED",
      sourceVersion: null,
      lastSuccessfulSyncAt: null
    });

    await pool!.query("DELETE FROM inventory_reservations WHERE order_id = $1", [orderId]);
    await pool!.query("DELETE FROM order_items WHERE order_id = $1", [orderId]);
    await pool!.query("DELETE FROM orders WHERE id = $1", [orderId]);
  });

  it("rejects non-platform currency and invalid settlement at DB level", async () => {
    const product = await service.createProduct(actorUserId, { title: unique("db checks") });
    productIds.push(product.id);
    const wrongCurrency = platformCurrency === "USD" ? "EUR" : "USD";
    await expect(
      pool!.query(
        `INSERT INTO product_variants
           (id, product_id, sku, price_minor, currency, partner_commission_unit_minor, inventory_external_key)
         VALUES ($1, $2, $3, 1000, $4, 100, $5)`,
        [randomUUID(), product.id, unique("SKU"), wrongCurrency, unique("key")]
      )
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      pool!.query(
        `INSERT INTO product_variants
           (id, product_id, sku, price_minor, currency, partner_commission_unit_minor, supplier_settlement_unit_minor, inventory_external_key)
         VALUES ($1, $2, $3, 1000, $4, 500, 600, $5)`,
        [randomUUID(), product.id, unique("SKU"), platformCurrency, unique("key")]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("serves only ACTIVE storefront projections without partner fields", async () => {
    const activeCategory = await serviceWithAssets.createCategory(actorUserId, { name: unique("store cat"), sortOrder: 1 });
    const archivedCategory = await serviceWithAssets.createCategory(actorUserId, { name: unique("arch cat"), sortOrder: 2 });
    categoryIds.push(activeCategory.id, archivedCategory.id);
    await serviceWithAssets.updateCategory(actorUserId, archivedCategory.id, { status: "ARCHIVED" });

    const activeProduct = await serviceWithAssets.createProduct(actorUserId, {
      title: unique("store product"),
      categoryIds: [activeCategory.id]
    });
    productIds.push(activeProduct.id);
    const activeVariant = await serviceWithAssets.createVariant(actorUserId, activeProduct.id, {
      sku: unique("SKU"),
      priceMinor: 44_400,
      partnerCommissionUnitMinor: 2_000,
      supplierSettlementUnitMinor: 30_000,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(activeVariant.id);
    await serviceWithAssets.updateVariant(actorUserId, activeVariant.id, { status: "ACTIVE" });
    await serviceWithAssets.updateProduct(actorUserId, activeProduct.id, { status: "ACTIVE" });

    const draftProduct = await serviceWithAssets.createProduct(actorUserId, { title: unique("draft product") });
    productIds.push(draftProduct.id);

    const categories = await serviceWithAssets.listStorefrontCategories();
    expect(categories.items.some((item) => item.id === activeCategory.id)).toBe(true);
    expect(categories.items.some((item) => item.id === archivedCategory.id)).toBe(false);

    const products = await serviceWithAssets.listStorefrontProducts({ page: 1, limit: 100 });
    const card = products.items.find((item) => item.slug === activeProduct.slug);
    expect(card).toMatchObject({ priceFromMinor: 44_400, priceToMinor: 44_400, currency: platformCurrency });
    expect(products.items.some((item) => item.slug === draftProduct.slug)).toBe(false);

    const detail = await serviceWithAssets.getStorefrontProduct(activeProduct.slug);
    expect(detail.variants[0]).toMatchObject({ id: activeVariant.id, priceMinor: 44_400, currency: platformCurrency });
    expect(detail.categories.map((item) => item.id)).toEqual([activeCategory.id]);
    for (const partnerField of ["partnerCommissionUnitMinor", "supplierSettlementUnitMinor", "inventoryExternalKey", "status"]) {
      expect(partnerField in (detail.variants[0] ?? {})).toBe(false);
    }
    await expect(serviceWithAssets.getStorefrontProduct(draftProduct.slug)).rejects.toThrow("Product not found");
  });

  it("adds partnerView for Partner users without leaking Partner-only content to Buyers", async () => {
    const category = await serviceWithAssets.createCategory(actorUserId, { name: unique("partner cat"), sortOrder: 1 });
    categoryIds.push(category.id);
    const product = await serviceWithAssets.createProduct(actorUserId, {
      title: unique("partner product"),
      categoryIds: [category.id]
    });
    productIds.push(product.id);
    const variantA = await serviceWithAssets.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      priceMinor: 50_000,
      partnerCommissionUnitMinor: 5_000,
      inventoryExternalKey: unique("key")
    });
    const variantB = await serviceWithAssets.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      priceMinor: 60_000,
      partnerCommissionUnitMinor: 0,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(variantA.id, variantB.id);
    await serviceWithAssets.updateVariant(actorUserId, variantA.id, { status: "ACTIVE" });
    await serviceWithAssets.updateVariant(actorUserId, variantB.id, { status: "ACTIVE" });
    await serviceWithAssets.updateProduct(actorUserId, product.id, { status: "ACTIVE" });

    await pool!.query(
      `INSERT INTO product_assets (id, product_id, type, purpose, text_content, status)
       VALUES ($1, $2, 'TEXT', 'STOREFRONT', $3, 'ACTIVE'),
              ($4, $2, 'TEXT', 'PARTNER_CONTENT', $5, 'ACTIVE')`,
      [randomUUID(), product.id, "Storefront text", randomUUID(), "Partner content text"]
    );

    const buyerCtx = { partner: null as { id: string; status: "ACTIVE" | "BLOCKED" } | null, userBlocked: false, partnerTermsReacceptRequired: false };
    const buyerList = await serviceWithAssets.listStorefrontProducts({ page: 1, limit: 20 }, buyerCtx);
    const buyerCard = buyerList.items.find((item) => item.id === product.id)!;
    expect(buyerCard.partnerView).toBeUndefined();
    expect(buyerCard.gallery.some((asset) => asset.text === "Partner content text")).toBe(false);

    const buyerDetail = await serviceWithAssets.getStorefrontProduct(product.slug, buyerCtx);
    expect(buyerDetail.partnerView).toBeUndefined();
    expect(buyerDetail.gallery.some((asset) => asset.text === "Partner content text")).toBe(false);

    const activePartner = { id: randomUUID(), status: "ACTIVE" as const };
    const activeCtx = { partner: activePartner, userBlocked: false, partnerTermsReacceptRequired: false };
    const partnerList = await serviceWithAssets.listStorefrontProducts({ page: 1, limit: 20 }, activeCtx);
    const partnerCard = partnerList.items.find((item) => item.id === product.id)!;
    expect(partnerCard.partnerView).toEqual({
      commissionFromMinor: 0,
      commissionToMinor: 5_000,
      referralEligible: true,
      readOnlyReason: null
    });

    const partnerDetail = await serviceWithAssets.getStorefrontProduct(product.slug, activeCtx);
    expect(partnerDetail.partnerView).toMatchObject({ referralEligible: true, readOnlyReason: null });
    expect(partnerDetail.partnerView!.variants).toHaveLength(2);
    expect(partnerDetail.partnerView!.variants.find((v) => v.id === variantA.id)).toMatchObject({
      commissionUnitMinor: 5_000, referralEligible: true, readOnlyReason: null
    });
    expect(partnerDetail.partnerView!.variants.find((v) => v.id === variantB.id)).toMatchObject({
      commissionUnitMinor: 0, referralEligible: true, readOnlyReason: null
    });
    expect(partnerDetail.partnerView!.assets.some((asset) => asset.text === "Partner content text")).toBe(true);

    const blockedCtx = { partner: { id: randomUUID(), status: "BLOCKED" as const }, userBlocked: false, partnerTermsReacceptRequired: false };
    const blockedList = await serviceWithAssets.listStorefrontProducts({ page: 1, limit: 20 }, blockedCtx);
    expect(blockedList.items.find((item) => item.id === product.id)?.partnerView).toMatchObject({
      referralEligible: false, readOnlyReason: "PARTNER_BLOCKED"
    });

    const staleCtx = { partner: { id: randomUUID(), status: "ACTIVE" as const }, userBlocked: false, partnerTermsReacceptRequired: true };
    const staleList = await serviceWithAssets.listStorefrontProducts({ page: 1, limit: 20 }, staleCtx);
    expect(staleList.items.find((item) => item.id === product.id)?.partnerView).toMatchObject({
      referralEligible: false, readOnlyReason: "TERMS_REACCEPT_REQUIRED"
    });

    await pool!.query("DELETE FROM product_assets WHERE product_id = $1", [product.id]);
  });

  it("serializes category archive against product membership change", async () => {
    const categoryA = await serviceWithAssets.createCategory(actorUserId, { name: unique("raceA"), sortOrder: 1 });
    const categoryB = await serviceWithAssets.createCategory(actorUserId, { name: unique("raceB"), sortOrder: 2 });
    categoryIds.push(categoryA.id, categoryB.id);
    const product = await serviceWithAssets.createProduct(actorUserId, {
      title: unique("race product"),
      categoryIds: [categoryA.id]
    });
    productIds.push(product.id);
    const variant = await serviceWithAssets.createVariant(actorUserId, product.id, {
      sku: unique("SKU"),
      priceMinor: 20_000,
      partnerCommissionUnitMinor: 500,
      inventoryExternalKey: unique("key")
    });
    variantIds.push(variant.id);
    await serviceWithAssets.updateVariant(actorUserId, variant.id, { status: "ACTIVE" });
    await serviceWithAssets.updateProduct(actorUserId, product.id, { status: "ACTIVE" });

    const results = await Promise.allSettled([
      serviceWithAssets.updateCategory(actorUserId, categoryA.id, { status: "ARCHIVED" }),
      serviceWithAssets.updateProduct(actorUserId, product.id, { categoryIds: [categoryB.id] })
    ]);
    expect(results.every((result) => result.status === "fulfilled" || result.reason instanceof ActiveProductInvariantError))
      .toBe(true);

    const persisted = await pool!.query<{ status: string; active_categories: number }>(
      `SELECT p.status,
              (SELECT COUNT(*)::int FROM product_categories pc
                 JOIN categories c ON c.id = pc.category_id
                WHERE pc.product_id = p.id AND c.status = 'ACTIVE') AS active_categories
         FROM products p WHERE p.id = $1`,
      [product.id]
    );
    expect(persisted.rows[0]?.status).toBe("ACTIVE");
    expect(persisted.rows[0]?.active_categories).toBe(1);
  });

  it("writes audit rows for catalog mutations", async () => {
    const result = await pool!.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE actor_user_id = $1 AND entity_type = ANY($2)",
      [actorUserId, ["category", "product", "variant"]]
    );
    expect(result.rows[0]?.count ?? 0).toBeGreaterThan(0);
  });
});
