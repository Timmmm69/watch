import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Pool, PoolClient } from "pg";
import { CatalogNotFoundError, CatalogValidationError } from "./catalog.js";
import { assertActiveProductInvariant, databaseAssetChecks } from "./invariant.js";

export type AssetPurpose = "STOREFRONT" | "PARTNER_CONTENT";
export type AssetType = "IMAGE" | "VIDEO" | "TEXT";
export type AssetStatus = "ACTIVE" | "ARCHIVED";

interface AssetRow {
  id: string; product_id: string; variant_id: string | null; type: AssetType;
  purpose: AssetPurpose; storage_key: string | null; text_content: string | null;
  mime_type: string | null; size_bytes: number | null; sort_order: number;
  status: AssetStatus; created_at: Date; updated_at: Date;
}

export interface AssetProjection {
  id: string; productId: string; variantId: string | null; type: AssetType;
  purpose: AssetPurpose; text: string | null; mimeType: string | null;
  sizeBytes: number | null; sortOrder: number; status: AssetStatus;
  mediaUrl: string | null; createdAt: Date; updatedAt: Date;
}

function project(row: AssetRow): AssetProjection {
  return {
    id: row.id, productId: row.product_id, variantId: row.variant_id,
    type: row.type, purpose: row.purpose, text: row.text_content,
    mimeType: row.mime_type, sizeBytes: row.size_bytes, sortOrder: row.sort_order,
    status: row.status, mediaUrl: row.storage_key ? `/api/v1/catalog/assets/${row.id}/media` : null,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export interface ObjectStorage {
  put(key: string, path: string, mimeType: string, sizeBytes: number): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, endpoint: string, region: string, accessKeyId: string, secretAccessKey: string) {
    this.client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  }
  async put(key: string, path: string, mimeType: string, sizeBytes: number): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: createReadStream(path), ContentType: mimeType,
      ContentLength: sizeBytes
    }));
  }
  async get(key: string): Promise<Readable> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error("Storage object has no body");
    return response.Body as Readable;
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export class StorageUnavailableError extends Error {
  constructor() { super("Media storage unavailable"); this.name = "StorageUnavailableError"; }
}

export class AssetService {
  constructor(private readonly pool: Pool, private readonly storage: ObjectStorage) {}

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async lockProduct(client: PoolClient, productId: string): Promise<void> {
    const result = await client.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (result.rowCount === 0) throw new CatalogNotFoundError("Product not found");
  }

  private async checkVariant(client: PoolClient, productId: string, variantId: string | null): Promise<void> {
    if (!variantId) return;
    const result = await client.query(
      "SELECT id FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE", [variantId, productId]
    );
    if (result.rowCount === 0) throw new CatalogValidationError("Variant does not belong to Product");
  }

  private async audit(client: PoolClient, actorUserId: string, action: string, assetId: string): Promise<void> {
    await client.query(
      "INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id) VALUES ($1, $2, $3, 'ProductAsset', $4)",
      [randomUUID(), actorUserId, action, assetId]
    );
  }

  async list(productId: string): Promise<AssetProjection[]> {
    const rows = await this.pool.query<AssetRow>(
      "SELECT * FROM product_assets WHERE product_id = $1 ORDER BY sort_order, created_at, id", [productId]
    );
    return rows.rows.map(project);
  }

  async storefront(productId: string): Promise<AssetProjection[]> {
    const rows = await this.pool.query<AssetRow>(
      "SELECT * FROM product_assets WHERE product_id = $1 AND purpose = 'STOREFRONT' AND status = 'ACTIVE' ORDER BY sort_order, created_at, id",
      [productId]
    );
    return rows.rows.map(project);
  }

  async createText(actorUserId: string, productId: string, input: { text: string; purpose: AssetPurpose; variantId?: string | null | undefined }): Promise<AssetProjection> {
    return this.transaction(async (client) => {
      await this.lockProduct(client, productId);
      await this.checkVariant(client, productId, input.variantId ?? null);
      const result = await client.query<AssetRow>(
        `INSERT INTO product_assets (id, product_id, variant_id, type, purpose, text_content)
         VALUES ($1, $2, $3, 'TEXT', $4, $5) RETURNING *`,
        [randomUUID(), productId, input.variantId ?? null, input.purpose, input.text]
      );
      await assertActiveProductInvariant(client, productId, databaseAssetChecks);
      await this.audit(client, actorUserId, "PRODUCT_ASSET_CREATED", result.rows[0]!.id);
      return project(result.rows[0]!);
    });
  }

  async createMedia(actorUserId: string, productId: string, input: {
    type: "IMAGE" | "VIDEO"; purpose: AssetPurpose; variantId: string | null;
    path: string; mimeType: string; sizeBytes: number;
  }): Promise<AssetProjection> {
    const key = `products/${productId}/${randomUUID()}`;
    try {
      await this.storage.put(key, input.path, input.mimeType, input.sizeBytes);
    } catch {
      await this.storage.delete(key).catch(() => undefined);
      throw new StorageUnavailableError();
    }
    try {
      return await this.transaction(async (client) => {
        await this.lockProduct(client, productId);
        await this.checkVariant(client, productId, input.variantId);
        const result = await client.query<AssetRow>(
          `INSERT INTO product_assets (id, product_id, variant_id, type, purpose, storage_key, mime_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [randomUUID(), productId, input.variantId, input.type, input.purpose, key, input.mimeType, input.sizeBytes]
        );
        await assertActiveProductInvariant(client, productId, databaseAssetChecks);
        await this.audit(client, actorUserId, "PRODUCT_ASSET_CREATED", result.rows[0]!.id);
        return project(result.rows[0]!);
      });
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async update(actorUserId: string, assetId: string, input: {
    status?: AssetStatus | undefined; purpose?: AssetPurpose | undefined; sortOrder?: number | undefined; text?: string | undefined;
  }): Promise<AssetProjection> {
    return this.transaction(async (client) => {
      const preliminary = await client.query<{ product_id: string }>("SELECT product_id FROM product_assets WHERE id = $1", [assetId]);
      if (!preliminary.rows[0]) throw new CatalogNotFoundError("Asset not found");
      const productId = preliminary.rows[0].product_id;
      await this.lockProduct(client, productId);
      const locked = await client.query<AssetRow>("SELECT * FROM product_assets WHERE id = $1 FOR UPDATE", [assetId]);
      const row = locked.rows[0];
      if (!row) throw new CatalogNotFoundError("Asset not found");
      if (input.text !== undefined && row.type !== "TEXT") throw new CatalogValidationError("Only TEXT assets can change text");
      const result = await client.query<AssetRow>(
        `UPDATE product_assets SET status = $2, purpose = $3, sort_order = $4,
          text_content = $5, updated_at = now() WHERE id = $1 RETURNING *`,
        [assetId, input.status ?? row.status, input.purpose ?? row.purpose,
          input.sortOrder ?? row.sort_order, input.text ?? row.text_content]
      );
      await assertActiveProductInvariant(client, productId, databaseAssetChecks);
      await this.audit(client, actorUserId, "PRODUCT_ASSET_UPDATED", assetId);
      return project(result.rows[0]!);
    });
  }

  async media(assetId: string, partnerAccess: boolean): Promise<{ stream: Readable; mimeType: string; sizeBytes: number }> {
    const result = await this.pool.query<AssetRow & { product_status: string }>(
      `SELECT a.*, p.status AS product_status FROM product_assets a
       JOIN products p ON p.id = a.product_id WHERE a.id = $1`, [assetId]
    );
    const asset = result.rows[0];
    if (!asset || !asset.storage_key || asset.status !== "ACTIVE" || asset.product_status !== "ACTIVE" ||
        (asset.purpose === "PARTNER_CONTENT" && !partnerAccess)) {
      throw new CatalogNotFoundError("Asset not found");
    }
    try {
      return { stream: await this.storage.get(asset.storage_key), mimeType: asset.mime_type!, sizeBytes: asset.size_bytes! };
    } catch { throw new StorageUnavailableError(); }
  }
}
