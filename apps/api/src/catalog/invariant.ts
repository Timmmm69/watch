import type { Pool } from "pg";

export type Queryable = Pick<Pool, "query">;

export type CategoryStatus = "ACTIVE" | "ARCHIVED";
export type ProductStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type VariantStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export interface ProductAssetChecks {
  countActiveStorefrontImages: (client: Queryable, productId: string) => Promise<number>;
}

export const noProductAssetChecks: ProductAssetChecks = {
  async countActiveStorefrontImages() {
    return 0;
  }
};

export const databaseAssetChecks: ProductAssetChecks = {
  async countActiveStorefrontImages(client, productId) {
    const result = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM product_assets WHERE product_id = $1 AND type = 'IMAGE' AND purpose = 'STOREFRONT' AND status = 'ACTIVE'",
      [productId]
    );
    return result.rows[0]?.count ?? 0;
  }
};

export const ACTIVE_CATEGORY_REQUIRED = "ACTIVE_CATEGORY_REQUIRED";
export const ACTIVE_VARIANT_REQUIRED = "ACTIVE_VARIANT_REQUIRED";
export const ACTIVE_STOREFRONT_IMAGE_REQUIRED = "ACTIVE_STOREFRONT_IMAGE_REQUIRED";

export interface ActiveProductInvariant {
  productId: string;
  unmet: string[];
}

export class ActiveProductInvariantError extends Error {
  constructor(public readonly invariant: ActiveProductInvariant) {
    super(`ACTIVE Product invariant is not satisfied for product ${invariant.productId}`);
    this.name = "ActiveProductInvariantError";
  }
}

export async function evaluateActiveProductInvariant(
  client: Queryable,
  productId: string,
  checks: ProductAssetChecks = noProductAssetChecks
): Promise<ActiveProductInvariant> {
  const status = await client.query<{ status: ProductStatus }>(
    "SELECT status FROM products WHERE id = $1",
    [productId]
  );
  const product = status.rows[0];
  if (!product || product.status !== "ACTIVE") return { productId, unmet: [] };

  const unmet: string[] = [];
  const categories = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM product_categories pc
       JOIN categories c ON c.id = pc.category_id
      WHERE pc.product_id = $1 AND c.status = 'ACTIVE'`,
    [productId]
  );
  if ((categories.rows[0]?.count ?? 0) < 1) unmet.push(ACTIVE_CATEGORY_REQUIRED);

  const variants = await client.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id = $1 AND status = 'ACTIVE'",
    [productId]
  );
  if ((variants.rows[0]?.count ?? 0) < 1) unmet.push(ACTIVE_VARIANT_REQUIRED);

  const images = await checks.countActiveStorefrontImages(client, productId);
  if (images < 1) unmet.push(ACTIVE_STOREFRONT_IMAGE_REQUIRED);

  return { productId, unmet };
}

export async function assertActiveProductInvariant(
  client: Queryable,
  productId: string,
  checks: ProductAssetChecks = noProductAssetChecks
): Promise<void> {
  const invariant = await evaluateActiveProductInvariant(client, productId, checks);
  if (invariant.unmet.length > 0) throw new ActiveProductInvariantError(invariant);
}
