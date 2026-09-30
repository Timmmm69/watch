import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  assertActiveProductInvariant,
  type CategoryStatus,
  type ProductAssetChecks,
  type ProductStatus,
  type VariantStatus,
  databaseAssetChecks
} from "./invariant.js";

export class CatalogValidationError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

export class CatalogNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogNotFoundError";
  }
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  status: CategoryStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryCreateInput {
  name: string;
  slug?: string | undefined;
  sortOrder: number;
}

export interface CategoryUpdateInput {
  name?: string | undefined;
  slug?: string | undefined;
  sortOrder?: number | undefined;
  status?: CategoryStatus | undefined;
}

export interface ProductSummary {
  id: string;
  supplierId: string;
  title: string;
  slug: string;
  description: string;
  brand: string | null;
  specifications: Record<string, unknown>;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductCreateInput {
  title: string;
  description?: string | undefined;
  brand?: string | null | undefined;
  specifications?: Record<string, unknown> | undefined;
  categoryIds?: string[] | undefined;
}

export interface ProductUpdateInput {
  title?: string | undefined;
  description?: string | undefined;
  brand?: string | null | undefined;
  specifications?: Record<string, unknown> | undefined;
  categoryIds?: string[] | undefined;
  status?: ProductStatus | undefined;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  attributes: Record<string, unknown>;
  priceMinor: number;
  currency: string;
  partnerCommissionUnitMinor: number;
  supplierSettlementUnitMinor: number | null;
  inventoryExternalKey: string;
  status: VariantStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface VariantInventoryState {
  sourceQuantity: number | null;
  safetyBuffer: number;
  sourceStatus: "UNINITIALIZED" | "OK" | "MISSING" | "INVALID";
  sourceVersion: string | null;
  lastSuccessfulSyncAt: Date | null;
  lastSuccessfulSyncRunId: string | null;
}

export interface AdminVariant extends Variant {
  inventory: VariantInventoryState | null;
}

export interface AdminProduct extends ProductSummary {
  categories: Category[];
  variants: AdminVariant[];
  assets: StorefrontAsset[];
}

export interface VariantCreateInput {
  sku: string;
  attributes?: Record<string, unknown> | undefined;
  priceMinor: number;
  partnerCommissionUnitMinor: number;
  supplierSettlementUnitMinor?: number | null | undefined;
  inventoryExternalKey: string;
}

export interface VariantUpdateInput {
  attributes?: Record<string, unknown> | undefined;
  priceMinor?: number | undefined;
  partnerCommissionUnitMinor?: number | undefined;
  supplierSettlementUnitMinor?: number | null | undefined;
  inventoryExternalKey?: string | undefined;
  status?: VariantStatus | undefined;
  safetyBuffer?: number | undefined;
}

export interface StorefrontCategory {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
}

export interface StorefrontProductCard {
  id: string;
  title: string;
  slug: string;
  description: string;
  brand: string | null;
  priceFromMinor: number | null;
  priceToMinor: number | null;
  currency: string;
  gallery: StorefrontAsset[];
}

export interface StorefrontAsset {
  id: string;
  type: "IMAGE" | "VIDEO" | "TEXT";
  purpose: "STOREFRONT" | "PARTNER_CONTENT";
  status: "ACTIVE" | "ARCHIVED";
  variantId: string | null;
  text: string | null;
  mediaUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sortOrder: number;
}

export interface StorefrontVariant {
  id: string;
  sku: string;
  attributes: Record<string, unknown>;
  priceMinor: number;
  currency: string;
}

export interface StorefrontProduct extends StorefrontProductCard {
  categories: StorefrontCategory[];
  variants: StorefrontVariant[];
}

export interface Page {
  page: number;
  limit: number;
}

export interface Paginated<T> extends Page {
  items: T[];
  total: number;
}

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
  status: CategoryStatus;
  created_at: Date;
  updated_at: Date;
}

interface ProductRow {
  id: string;
  supplier_id: string;
  title: string;
  slug: string;
  description: string;
  brand: string | null;
  specifications: Record<string, unknown>;
  status: ProductStatus;
  created_at: Date;
  updated_at: Date;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  attributes: Record<string, unknown>;
  price_minor: number;
  currency: string;
  partner_commission_unit_minor: number;
  supplier_settlement_unit_minor: number | null;
  inventory_external_key: string;
  status: VariantStatus;
  created_at: Date;
  updated_at: Date;
}

interface AssetRow {
  id: string; product_id: string; variant_id: string | null;
  type: "IMAGE" | "VIDEO" | "TEXT"; text_content: string | null;
  purpose: "STOREFRONT" | "PARTNER_CONTENT"; status: "ACTIVE" | "ARCHIVED";
  storage_key: string | null; mime_type: string | null; size_bytes: number | null; sort_order: number;
}

function mapAsset(row: AssetRow): StorefrontAsset {
  return { id: row.id, type: row.type, purpose: row.purpose, status: row.status,
    variantId: row.variant_id, sizeBytes: row.size_bytes,
    text: row.text_content, mediaUrl: row.storage_key ? `/api/v1/catalog/assets/${row.id}/media` : null,
    mimeType: row.mime_type, sortOrder: row.sort_order };
}

interface InventoryRow {
  variant_id: string;
  source_quantity: number | null;
  safety_buffer: number;
  source_status: VariantInventoryState["sourceStatus"];
  source_version: string | null;
  last_attempt_at: Date | null;
  last_successful_sync_at: Date | null;
  last_successful_sync_run_id: string | null;
}

type InventoryStateRow = Pick<InventoryRow,
  "source_quantity" | "safety_buffer" | "source_status" | "source_version" |
  "last_successful_sync_at" | "last_successful_sync_run_id">;

interface VariantWithInventoryRow extends VariantRow {
  inventory_variant_id: string | null;
  source_quantity: number | null;
  safety_buffer: number;
  source_status: VariantInventoryState["sourceStatus"];
  source_version: string | null;
  last_attempt_at: Date | null;
  last_successful_sync_at: Date | null;
  last_successful_sync_run_id: string | null;
}

const RETRY = Symbol("catalog-membership-retry");
const MAX_RETRIES = 3;

export function normalizeSlug(input: string, maxLength: number): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

export function generateSlug(source: string, prefix: string, maxLength: number): string {
  const normalized = normalizeSlug(source, maxLength);
  return normalized.length > 0 ? normalized : `${prefix}-${randomBytes(6).toString("hex")}`;
}

export function canTransitionProductStatus(from: ProductStatus, to: ProductStatus): boolean {
  if (from === to) return true;
  if (from === "DRAFT") return to === "ACTIVE" || to === "ARCHIVED";
  if (from === "ACTIVE") return to === "ARCHIVED";
  return to === "ACTIVE";
}

export function canTransitionVariantStatus(from: VariantStatus, to: VariantStatus): boolean {
  if (from === to) return true;
  if (from === "DRAFT") return to === "ACTIVE" || to === "ARCHIVED";
  if (from === "ACTIVE") return to === "ARCHIVED";
  return to === "ACTIVE";
}

export function settlementWithinPrice(
  priceMinor: number,
  partnerCommissionUnitMinor: number,
  supplierSettlementUnitMinor: number | null
): boolean {
  if (supplierSettlementUnitMinor === null) return true;
  return supplierSettlementUnitMinor + partnerCommissionUnitMinor <= priceMinor;
}

export async function initializePlatformCurrency(
  pool: Pool,
  currency: string
): Promise<{ created: boolean; platformCurrency: string }> {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Platform currency must be a 3-letter ISO 4217 code");
  }
  const inserted = await pool.query(
    "INSERT INTO platform_settings (platform_currency) VALUES ($1) ON CONFLICT DO NOTHING",
    [currency]
  );
  const existing = await pool.query<{ platform_currency: string }>(
    "SELECT platform_currency FROM platform_settings WHERE singleton_id = 1"
  );
  const persisted = existing.rows[0]?.platform_currency;
  if (!persisted) throw new Error("Platform currency initialization failed");
  if (persisted !== currency) {
    throw new Error(
      `Persisted platform currency ${persisted} does not match PLATFORM_CURRENCY ${currency}; the persisted value is immutable`
    );
  }
  return { created: inserted.rowCount === 1, platformCurrency: persisted };
}

export async function seedSupplier(
  pool: Pool,
  name: string
): Promise<{ created: boolean; supplierId: string; name: string; status: "ACTIVE" | "INACTIVE" }> {
  const inserted = await pool.query<{ id: string; name: string; status: "ACTIVE" | "INACTIVE" }>(
    "INSERT INTO suppliers (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, name, status",
    [randomUUID(), name]
  );
  const created = inserted.rows[0];
  if (created) return { created: true, supplierId: created.id, name: created.name, status: created.status };
  const active = await pool.query<{ id: string; name: string; status: "ACTIVE" | "INACTIVE" }>(
    "SELECT id, name, status FROM suppliers WHERE status = 'ACTIVE'"
  );
  const existing = active.rows[0];
  if (!existing) throw new Error("Supplier seed failed");
  return { created: false, supplierId: existing.id, name: existing.name, status: existing.status };
}

function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id, name: row.name, slug: row.slug, sortOrder: row.sort_order,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapProduct(row: ProductRow): ProductSummary {
  return {
    id: row.id, supplierId: row.supplier_id, title: row.title, slug: row.slug,
    description: row.description, brand: row.brand, specifications: row.specifications,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapVariant(row: VariantRow): Variant {
  return {
    id: row.id, productId: row.product_id, sku: row.sku, attributes: row.attributes,
    priceMinor: row.price_minor, currency: row.currency,
    partnerCommissionUnitMinor: row.partner_commission_unit_minor,
    supplierSettlementUnitMinor: row.supplier_settlement_unit_minor,
    inventoryExternalKey: row.inventory_external_key, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapInventory(row: InventoryStateRow): VariantInventoryState {
  return {
    sourceQuantity: row.source_quantity, safetyBuffer: row.safety_buffer,
    sourceStatus: row.source_status, sourceVersion: row.source_version,
    lastSuccessfulSyncAt: row.last_successful_sync_at, lastSuccessfulSyncRunId: row.last_successful_sync_run_id
  };
}

function sanitizeSearch(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "23505";
}

export class CatalogService {
  constructor(
    private readonly pool: Pool,
    private readonly platformCurrency: string,
    private readonly assetChecks: ProductAssetChecks = databaseAssetChecks
  ) {}

  async verifyCurrencyConfigured(): Promise<void> {
    const result = await this.pool.query<{ platform_currency: string }>(
      "SELECT platform_currency FROM platform_settings WHERE singleton_id = 1"
    );
    const persisted = result.rows[0]?.platform_currency;
    if (!persisted) {
      throw new Error("platform_settings.platform_currency is not initialized; run catalog:bootstrap");
    }
    if (persisted !== this.platformCurrency) {
      throw new Error(
        `PLATFORM_CURRENCY mismatch: configured ${this.platformCurrency}, persisted ${persisted}`
      );
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async withMembershipRetry<T>(fn: () => Promise<T | typeof RETRY>): Promise<T> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const result = await fn();
      if (result !== RETRY) return result as T;
    }
    throw new Error("Concurrent category membership change; retry limit exceeded");
  }

  private rethrowUniqueViolation(error: unknown, message: string): never {
    if (isUniqueViolation(error)) {
      throw new CatalogValidationError(message, {
        constraint: typeof error === "object" && error !== null && "constraint" in error
          ? (error as { constraint?: string }).constraint ?? null
          : null
      });
    }
    throw error;
  }

  private async audit(
    client: PoolClient,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)",
      [randomUUID(), actorUserId, action, entityType, entityId, metadata ?? null]
    );
  }

  private async lockProduct(client: PoolClient, productId: string): Promise<ProductRow> {
    const result = await client.query<ProductRow>("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId]);
    const row = result.rows[0];
    if (!row) throw new CatalogNotFoundError("Product not found");
    return row;
  }

  private async lockCategory(client: PoolClient, categoryId: string): Promise<CategoryRow> {
    const result = await client.query<CategoryRow>("SELECT * FROM categories WHERE id = $1 FOR UPDATE", [categoryId]);
    const row = result.rows[0];
    if (!row) throw new CatalogNotFoundError("Category not found");
    return row;
  }

  private async lockVariant(client: PoolClient, variantId: string): Promise<VariantRow> {
    const result = await client.query<VariantRow>("SELECT * FROM product_variants WHERE id = $1 FOR UPDATE", [variantId]);
    const row = result.rows[0];
    if (!row) throw new CatalogNotFoundError("Variant not found");
    return row;
  }

  private async lockInventoryItem(client: PoolClient, variantId: string): Promise<InventoryRow> {
    const result = await client.query<InventoryRow>(
      "SELECT * FROM inventory_items WHERE variant_id = $1 FOR UPDATE",
      [variantId]
    );
    const row = result.rows[0];
    if (!row) throw new CatalogNotFoundError("Inventory item not found");
    return row;
  }

  private async lockProductsByIds(client: PoolClient, productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    await client.query("SELECT id FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [productIds]);
  }

  private async lockCategoriesByIds(client: PoolClient, categoryIds: string[]): Promise<CategoryRow[]> {
    if (categoryIds.length === 0) return [];
    const result = await client.query<CategoryRow>(
      "SELECT * FROM categories WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [categoryIds]
    );
    return result.rows;
  }

  private async affectedActiveProductIds(client: PoolClient, categoryId: string): Promise<string[]> {
    const result = await client.query<{ id: string }>(
      `SELECT p.id
         FROM products p
         JOIN product_categories pc ON pc.product_id = p.id
        WHERE pc.category_id = $1 AND p.status = 'ACTIVE'
        ORDER BY p.id`,
      [categoryId]
    );
    return result.rows.map((row) => row.id);
  }

  private async productCategoryIds(client: PoolClient, productId: string): Promise<string[]> {
    const result = await client.query<{ category_id: string }>(
      "SELECT category_id FROM product_categories WHERE product_id = $1",
      [productId]
    );
    return result.rows.map((row) => row.category_id);
  }

  private async soleActiveSupplierId(client: PoolClient): Promise<string> {
    const result = await client.query<{ id: string }>(
      "SELECT id FROM suppliers WHERE status = 'ACTIVE' ORDER BY created_at, id LIMIT 1"
    );
    const id = result.rows[0]?.id;
    if (!id) {
      throw new CatalogValidationError("No ACTIVE supplier is provisioned", { reason: "SUPPLIER_MISSING" });
    }
    return id;
  }

  private async categoryExists(client: PoolClient, categoryIds: string[]): Promise<string[]> {
    if (categoryIds.length === 0) return [];
    const result = await client.query<{ id: string }>(
      "SELECT id FROM categories WHERE id = ANY($1::uuid[])",
      [categoryIds]
    );
    return result.rows.map((row) => row.id);
  }

  async listCategories(query: Page & { status?: CategoryStatus | undefined }): Promise<Paginated<Category>> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}::"CategoryStatus"`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM categories ${where}`,
      values
    );
    const items = await this.pool.query<CategoryRow>(
      `SELECT * FROM categories ${where} ORDER BY sort_order, id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit, (query.page - 1) * query.limit]
    );
    return {
      items: items.rows.map(mapCategory),
      page: query.page,
      limit: query.limit,
      total: total.rows[0]?.count ?? 0
    };
  }

  async createCategory(actorUserId: string, input: CategoryCreateInput): Promise<Category> {
    const slug = input.slug !== undefined ? normalizeSlug(input.slug, 140) : generateSlug(input.name, "category", 140);
    if (slug.length === 0) {
      throw new CatalogValidationError("Slug must contain latin letters or digits", { field: "slug" });
    }
    return this.withClient(async (client) => {
      const inserted = await client.query<CategoryRow>(
        `INSERT INTO categories (id, name, slug, sort_order)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [randomUUID(), input.name, slug, input.sortOrder]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Category creation failed");
      await this.audit(client, actorUserId, "admin.category.create", "category", row.id, { slug: row.slug });
      return mapCategory(row);
    }).catch((error: unknown) => this.rethrowUniqueViolation(error, "Slug already in use"));
  }

  async updateCategory(actorUserId: string, categoryId: string, input: CategoryUpdateInput): Promise<Category> {
    return this.withMembershipRetry(async () => {
      try {
        return await this.withClient(async (client) => {
          const preliminary = await this.affectedActiveProductIds(client, categoryId);
          const current = await this.lockCategory(client, categoryId);
          await this.lockProductsByIds(client, preliminary);
          const recheck = await this.affectedActiveProductIds(client, categoryId);
          if (!sameIdSet(preliminary, recheck)) return RETRY;

          const sets: string[] = [];
          const values: unknown[] = [];
          const apply = (column: string, value: unknown) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
          };
          if (input.name !== undefined) apply("name", input.name);
          if (input.slug !== undefined) {
            const slug = normalizeSlug(input.slug, 140);
            if (slug.length === 0) {
              throw new CatalogValidationError("Slug must contain latin letters or digits", { field: "slug" });
            }
            apply("slug", slug);
          }
          if (input.sortOrder !== undefined) apply("sort_order", input.sortOrder);
          if (input.status !== undefined && input.status !== current.status) apply("status", input.status);
          let updated = current;
          if (sets.length > 0) {
            sets.push("updated_at = now()");
            const result = await client.query<CategoryRow>(
              `UPDATE categories SET ${sets.join(", ")} WHERE id = $${values.length + 1} RETURNING *`,
              [...values, categoryId]
            );
            updated = result.rows[0] ?? current;
          }
          for (const productId of recheck) {
            await assertActiveProductInvariant(client, productId, this.assetChecks);
          }
          await this.audit(client, actorUserId, "admin.category.update", "category", categoryId, {
            status: input.status ?? null
          });
          return mapCategory(updated);
        });
      } catch (error) {
        this.rethrowUniqueViolation(error, "Slug already in use");
      }
    });
  }

  async listProducts(query: Page & { q?: string | undefined; status?: ProductStatus | undefined }): Promise<Paginated<ProductSummary>> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}::"ProductStatus"`);
    }
    if (query.q) {
      values.push(sanitizeSearch(query.q));
      const position = values.length;
      conditions.push(
        `(title ILIKE $${position} ESCAPE '\\' OR slug ILIKE $${position} ESCAPE '\\' OR brand ILIKE $${position} ESCAPE '\\')`
      );
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM products ${where}`,
      values
    );
    const items = await this.pool.query<ProductRow>(
      `SELECT * FROM products ${where} ORDER BY updated_at DESC, id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit, (query.page - 1) * query.limit]
    );
    return {
      items: items.rows.map(mapProduct),
      page: query.page,
      limit: query.limit,
      total: total.rows[0]?.count ?? 0
    };
  }

  async getProduct(productId: string): Promise<AdminProduct> {
    return this.withClient(async (client) => {
      const result = await client.query<ProductRow>("SELECT * FROM products WHERE id = $1", [productId]);
      const product = result.rows[0];
      if (!product) throw new CatalogNotFoundError("Product not found");
      const categories = await client.query<CategoryRow>(
        `SELECT c.* FROM product_categories pc
           JOIN categories c ON c.id = pc.category_id
          WHERE pc.product_id = $1
          ORDER BY c.sort_order, c.id`,
        [productId]
      );
      const variants = await client.query<VariantWithInventoryRow>(
        `SELECT v.*, i.variant_id AS inventory_variant_id, i.source_quantity, i.safety_buffer, i.source_status,
                i.source_version, i.last_attempt_at, i.last_successful_sync_at, i.last_successful_sync_run_id
           FROM product_variants v
           LEFT JOIN inventory_items i ON i.variant_id = v.id
          WHERE v.product_id = $1
          ORDER BY v.created_at, v.id`,
        [productId]
      );
      const assets = await client.query<AssetRow>(
        "SELECT * FROM product_assets WHERE product_id = $1 ORDER BY sort_order, created_at, id", [productId]
      );
      return {
        ...mapProduct(product),
        categories: categories.rows.map(mapCategory),
        variants: variants.rows.map((row) => ({
          ...mapVariant(row),
          inventory: row.inventory_variant_id === null ? null : mapInventory(row)
        })),
        assets: assets.rows.map(mapAsset)
      };
    });
  }

  async createProduct(actorUserId: string, input: ProductCreateInput): Promise<ProductSummary> {
    return this.withClient(async (client) => {
      const supplierId = await this.soleActiveSupplierId(client);
      const categoryIds = [...new Set(input.categoryIds ?? [])];
      if (categoryIds.length > 0) {
        const found = await this.categoryExists(client, categoryIds);
        if (found.length !== categoryIds.length) {
          const foundIds = new Set(found);
          throw new CatalogValidationError("Unknown category IDs", {
            unknownCategoryIds: categoryIds.filter((id) => !foundIds.has(id))
          });
        }
      }
      let slug = generateSlug(input.title, "product", 220);
      const collision = await client.query("SELECT 1 FROM products WHERE slug = $1", [slug]);
      if (collision.rows.length > 0) {
        slug = `${slug.slice(0, 210)}-${randomBytes(3).toString("hex")}`;
      }
      const inserted = await client.query<ProductRow>(
        `INSERT INTO products (id, supplier_id, title, slug, description, brand, specifications)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          randomUUID(), supplierId, input.title, slug,
          input.description ?? "", input.brand ?? null,
          input.specifications ?? {}
        ]
      );
      const product = inserted.rows[0];
      if (!product) throw new Error("Product creation failed");
      for (const categoryId of categoryIds) {
        await client.query(
          "INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)",
          [product.id, categoryId]
        );
      }
      await this.audit(client, actorUserId, "admin.product.create", "product", product.id, { slug: product.slug });
      return mapProduct(product);
    }).catch((error: unknown) => this.rethrowUniqueViolation(error, "Slug already in use"));
  }

  async updateProduct(actorUserId: string, productId: string, input: ProductUpdateInput): Promise<ProductSummary> {
    return this.withMembershipRetry(async () => {
      try {
        return await this.withClient(async (client) => {
          const coreInvolved = input.title !== undefined || input.description !== undefined ||
            input.brand !== undefined || input.specifications !== undefined;
          const membershipInvolved = input.categoryIds !== undefined || input.status !== undefined;
          if (!coreInvolved && !membershipInvolved) {
            const current = await this.lockProduct(client, productId);
            return mapProduct(current);
          }

          const currentCategoryIds = await this.productCategoryIds(client, productId);
          const requestedCategoryIds = input.categoryIds !== undefined
            ? [...new Set(input.categoryIds)]
            : currentCategoryIds;
          const unionCategoryIds = [...new Set([...currentCategoryIds, ...requestedCategoryIds])];
          const lockedCategories = await this.lockCategoriesByIds(client, unionCategoryIds);
          const product = await this.lockProduct(client, productId);
          const rereadCategoryIds = await this.productCategoryIds(client, productId);
          if (!sameIdSet(currentCategoryIds, rereadCategoryIds)) return RETRY;

          const sets: string[] = [];
          const values: unknown[] = [];
          const apply = (column: string, value: unknown) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
          };
          if (input.title !== undefined) apply("title", input.title);
          if (input.description !== undefined) apply("description", input.description);
          if (input.brand !== undefined) apply("brand", input.brand);
          if (input.specifications !== undefined) apply("specifications", input.specifications);
          if (input.status !== undefined && input.status !== product.status) {
            if (!canTransitionProductStatus(product.status, input.status)) {
              throw new CatalogValidationError(
                `Product status transition ${product.status} to ${input.status} is not allowed`,
                { from: product.status, to: input.status }
              );
            }
            apply("status", input.status);
          }

          if (input.categoryIds !== undefined) {
            const lockedIds = new Set(lockedCategories.map((row) => row.id));
            if (requestedCategoryIds.some((id) => !lockedIds.has(id))) {
              throw new CatalogValidationError("Unknown category IDs", {
                unknownCategoryIds: requestedCategoryIds.filter((id) => !lockedIds.has(id))
              });
            }
            await client.query("DELETE FROM product_categories WHERE product_id = $1", [productId]);
            for (const categoryId of requestedCategoryIds) {
              await client.query(
                "INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)",
                [productId, categoryId]
              );
            }
          }

          let updated = product;
          if (sets.length > 0) {
            sets.push("updated_at = now()");
            const result = await client.query<ProductRow>(
              `UPDATE products SET ${sets.join(", ")} WHERE id = $${values.length + 1} RETURNING *`,
              [...values, productId]
            );
            updated = result.rows[0] ?? product;
          }

          if (updated.status === "ACTIVE") {
            await assertActiveProductInvariant(client, productId, this.assetChecks);
          }
          await this.audit(client, actorUserId, "admin.product.update", "product", productId, {
            status: input.status ?? null,
            categoryIds: input.categoryIds ?? null
          });
          return mapProduct(updated);
        });
      } catch (error) {
        this.rethrowUniqueViolation(error, "Slug already in use");
      }
    });
  }

  async createVariant(actorUserId: string, productId: string, input: VariantCreateInput): Promise<AdminVariant> {
    const settlement = input.supplierSettlementUnitMinor ?? null;
    if (!settlementWithinPrice(input.priceMinor, input.partnerCommissionUnitMinor, settlement)) {
      throw new CatalogValidationError("Supplier settlement plus partner commission must not exceed price", {
        priceMinor: input.priceMinor,
        partnerCommissionUnitMinor: input.partnerCommissionUnitMinor,
        supplierSettlementUnitMinor: settlement
      });
    }
    return this.withClient(async (client) => {
      const product = await this.lockProduct(client, productId);
      const inserted = await client.query<VariantRow>(
        `INSERT INTO product_variants
           (id, product_id, sku, attributes, price_minor, currency, partner_commission_unit_minor, supplier_settlement_unit_minor, inventory_external_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          randomUUID(), productId, input.sku, input.attributes ?? {}, input.priceMinor,
          this.platformCurrency, input.partnerCommissionUnitMinor, settlement,
          input.inventoryExternalKey
        ]
      );
      const variant = inserted.rows[0];
      if (!variant) throw new Error("Variant creation failed");
      const inventory = await client.query<InventoryRow>(
        "INSERT INTO inventory_items (variant_id) VALUES ($1) RETURNING *",
        [variant.id]
      );
      await assertActiveProductInvariant(client, product.id, this.assetChecks);
      await this.audit(client, actorUserId, "admin.variant.create", "variant", variant.id, {
        productId,
        sku: variant.sku
      });
      const inventoryRow = inventory.rows[0];
      if (!inventoryRow) throw new Error("Inventory item creation failed");
      return { ...mapVariant(variant), inventory: mapInventory(inventoryRow) };
    }).catch((error: unknown) => this.rethrowUniqueViolation(error, "SKU or inventory external key already in use"));
  }

  async updateVariant(actorUserId: string, variantId: string, input: VariantUpdateInput): Promise<AdminVariant> {
    return this.withClient(async (client) => {
      const productIdResult = await client.query<{ product_id: string }>(
        "SELECT product_id FROM product_variants WHERE id = $1",
        [variantId]
      );
      const productId = productIdResult.rows[0]?.product_id;
      if (!productId) throw new CatalogNotFoundError("Variant not found");
      const product = await this.lockProduct(client, productId);
      const variant = await this.lockVariant(client, variantId);
      const inventoryInvolved = input.inventoryExternalKey !== undefined || input.safetyBuffer !== undefined;
      if (inventoryInvolved) {
        await this.lockInventoryItem(client, variantId);
      }

      const priceMinor = input.priceMinor ?? variant.price_minor;
      const commissionMinor = input.partnerCommissionUnitMinor ?? variant.partner_commission_unit_minor;
      const settlementMinor = input.supplierSettlementUnitMinor === undefined
        ? variant.supplier_settlement_unit_minor
        : input.supplierSettlementUnitMinor;
      if (!settlementWithinPrice(priceMinor, commissionMinor, settlementMinor)) {
        throw new CatalogValidationError("Supplier settlement plus partner commission must not exceed price", {
          priceMinor, partnerCommissionUnitMinor: commissionMinor, supplierSettlementUnitMinor: settlementMinor
        });
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      const apply = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (input.attributes !== undefined) apply("attributes", input.attributes);
      if (input.priceMinor !== undefined) apply("price_minor", input.priceMinor);
      if (input.partnerCommissionUnitMinor !== undefined) {
        apply("partner_commission_unit_minor", input.partnerCommissionUnitMinor);
      }
      if (input.supplierSettlementUnitMinor !== undefined) {
        apply("supplier_settlement_unit_minor", input.supplierSettlementUnitMinor);
      }
      if (input.inventoryExternalKey !== undefined) apply("inventory_external_key", input.inventoryExternalKey);
      if (input.status !== undefined && input.status !== variant.status) {
        if (!canTransitionVariantStatus(variant.status, input.status)) {
          throw new CatalogValidationError(
            `Variant status transition ${variant.status} to ${input.status} is not allowed`,
            { from: variant.status, to: input.status }
          );
        }
        apply("status", input.status);
      }
      let updated = variant;
      if (sets.length > 0) {
        sets.push("updated_at = now()");
        const result = await client.query<VariantRow>(
          `UPDATE product_variants SET ${sets.join(", ")} WHERE id = $${values.length + 1} RETURNING *`,
          [...values, variantId]
        );
        updated = result.rows[0] ?? variant;
      }

      if (input.inventoryExternalKey !== undefined && input.inventoryExternalKey !== variant.inventory_external_key) {
        await client.query(
          `UPDATE inventory_items
              SET source_quantity = NULL,
                  source_status = 'UNINITIALIZED',
                  source_version = NULL,
                  last_successful_sync_at = NULL,
                  last_successful_sync_run_id = NULL,
                  updated_at = now()
            WHERE variant_id = $1`,
          [variantId]
        );
      }
      if (input.safetyBuffer !== undefined) {
        await client.query(
          "UPDATE inventory_items SET safety_buffer = $1, updated_at = now() WHERE variant_id = $2",
          [input.safetyBuffer, variantId]
        );
      }

      await assertActiveProductInvariant(client, product.id, this.assetChecks);

      const inventoryState = await client.query<InventoryRow>(
        "SELECT * FROM inventory_items WHERE variant_id = $1",
        [variantId]
      );
      const inventoryRow = inventoryState.rows[0];
      if (!inventoryRow) throw new Error("Inventory item state read failed");
      await this.audit(client, actorUserId, "admin.variant.update", "variant", variantId, {
        productId,
        status: input.status ?? null,
        inventoryExternalKeyChanged: input.inventoryExternalKey !== undefined
      });
      return { ...mapVariant(updated), inventory: mapInventory(inventoryRow) };
    }).catch((error: unknown) => this.rethrowUniqueViolation(error, "SKU or inventory external key already in use"));
  }

  async listStorefrontCategories(): Promise<{ items: StorefrontCategory[] }> {
    const result = await this.pool.query<CategoryRow>(
      "SELECT * FROM categories WHERE status = 'ACTIVE' ORDER BY sort_order, id"
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id, name: row.name, slug: row.slug, sortOrder: row.sort_order
      }))
    };
  }

  async listStorefrontProducts(query: Page): Promise<Paginated<StorefrontProductCard>> {
    const total = await this.pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM products WHERE status = 'ACTIVE'"
    );
    const items = await this.pool.query<{
      id: string;
      title: string;
      slug: string;
      description: string;
      brand: string | null;
      price_from_minor: number | null;
      price_to_minor: number | null;
    }>(
      `SELECT p.id, p.title, p.slug, p.description, p.brand,
              (SELECT min(v.price_minor) FROM product_variants v
                WHERE v.product_id = p.id AND v.status = 'ACTIVE') AS price_from_minor,
              (SELECT max(v.price_minor) FROM product_variants v
                WHERE v.product_id = p.id AND v.status = 'ACTIVE') AS price_to_minor
         FROM products p
        WHERE p.status = 'ACTIVE'
        ORDER BY p.created_at DESC, p.id
        LIMIT $1 OFFSET $2`,
      [query.limit, (query.page - 1) * query.limit]
    );
    const assets = await this.pool.query<AssetRow>(
      `SELECT * FROM product_assets WHERE product_id = ANY($1::uuid[])
         AND purpose = 'STOREFRONT' AND status = 'ACTIVE'
       ORDER BY sort_order, created_at, id`,
      [items.rows.map((row) => row.id)]
    );
    return {
      items: items.rows.map((row) => ({
        id: row.id, title: row.title, slug: row.slug, description: row.description,
        brand: row.brand, priceFromMinor: row.price_from_minor, priceToMinor: row.price_to_minor,
        currency: this.platformCurrency,
        gallery: assets.rows.filter((asset) => asset.product_id === row.id).map(mapAsset)
      })),
      page: query.page,
      limit: query.limit,
      total: total.rows[0]?.count ?? 0
    };
  }

  async getStorefrontProduct(slug: string): Promise<StorefrontProduct> {
    const productResult = await this.pool.query<ProductRow>(
      "SELECT * FROM products WHERE slug = $1 AND status = 'ACTIVE'",
      [slug]
    );
    const product = productResult.rows[0];
    if (!product) throw new CatalogNotFoundError("Product not found");
    const categories = await this.pool.query<CategoryRow>(
      `SELECT c.* FROM product_categories pc
         JOIN categories c ON c.id = pc.category_id
        WHERE pc.product_id = $1 AND c.status = 'ACTIVE'
        ORDER BY c.sort_order, c.id`,
      [product.id]
    );
    const variants = await this.pool.query<VariantRow>(
      `SELECT * FROM product_variants
        WHERE product_id = $1 AND status = 'ACTIVE'
        ORDER BY created_at, id`,
      [product.id]
    );
    const assets = await this.pool.query<AssetRow>(
      `SELECT * FROM product_assets WHERE product_id = $1 AND purpose = 'STOREFRONT' AND status = 'ACTIVE'
       ORDER BY sort_order, created_at, id`, [product.id]
    );
    const prices = variants.rows.map((row) => row.price_minor);
    return {
      id: product.id,
      title: product.title,
      slug: product.slug,
      description: product.description,
      brand: product.brand,
      priceFromMinor: prices.length > 0 ? Math.min(...prices) : null,
      priceToMinor: prices.length > 0 ? Math.max(...prices) : null,
      currency: this.platformCurrency,
      gallery: assets.rows.map(mapAsset),
      categories: categories.rows.map((row) => ({
        id: row.id, name: row.name, slug: row.slug, sortOrder: row.sort_order
      })),
      variants: variants.rows.map((row) => ({
        id: row.id, sku: row.sku, attributes: row.attributes,
        priceMinor: row.price_minor, currency: row.currency
      }))
    };
  }
}
