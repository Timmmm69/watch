import type { Pool } from "pg";
import {
  computeInventoryAvailability,
  DEFAULT_INVENTORY_MAX_AGE_SECONDS,
  type InventoryAvailability
} from "./availability.js";

export type Queryable = Pick<Pool, "query">;

export interface InventoryReservationChecks {
  activeReservationsByVariant(client: Queryable, variantIds: string[]): Promise<Map<string, number>>;
  reconciliationPendingByVariant(client: Queryable, variantIds: string[]): Promise<Map<string, number>>;
}

export const inventoryReservationChecks: InventoryReservationChecks = {
  async activeReservationsByVariant(client, variantIds) {
    const result = await client.query<{ variant_id: string; quantity: string }>(
      `SELECT variant_id, SUM(quantity)::text AS quantity FROM inventory_reservations
       WHERE variant_id = ANY($1::uuid[]) AND status = 'ACTIVE' GROUP BY variant_id`, [variantIds]);
    return new Map(result.rows.map((row) => [row.variant_id, Number(row.quantity)]));
  },
  async reconciliationPendingByVariant(client, variantIds) {
    const result = await client.query<{ variant_id: string; count: string }>(
      `SELECT r.variant_id,COUNT(*)::text AS count FROM inventory_reservations r JOIN orders o ON o.id=r.order_id
       WHERE r.variant_id=ANY($1::uuid[]) AND r.status='ACTIVE'
         AND o.status IN ('SHIPPED','DELIVERED','COMPLETED','DELIVERY_FAILED') GROUP BY r.variant_id`, [variantIds]);
    return new Map(result.rows.map((row) => [row.variant_id, Number(row.count)]));
  }
};

export interface Page {
  page: number;
  limit: number;
}

export interface Paginated<T> extends Page {
  items: T[];
  total: number;
}

export type InventorySourceStatus = "UNINITIALIZED" | "OK" | "MISSING" | "INVALID";
export type InventorySyncRunStatus = "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED";

export interface AdminInventoryItem {
  variantId: string;
  productId: string;
  productTitle: string;
  sku: string;
  inventoryExternalKey: string;
  sourceQuantity: number | null;
  safetyBuffer: number;
  sourceStatus: InventorySourceStatus;
  sourceVersion: string | null;
  lastAttemptAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  lastSuccessfulSyncRunId: string | null;
  activeReservations: number;
  reconciliationPending: number;
  sellable: number;
  availability: InventoryAvailability;
  deficit: boolean;
}

export interface InventorySyncRunView {
  id: string;
  providerKey: string;
  status: InventorySyncRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  itemsProcessed: number;
  itemsFailed: number;
  details: Record<string, unknown> | null;
  errorSummary: string | null;
}

interface AdminInventoryRow {
  variant_id: string;
  product_id: string;
  product_title: string;
  sku: string;
  inventory_external_key: string;
  inventory_variant_id: string | null;
  source_quantity: number | null;
  safety_buffer: number;
  source_status: InventorySourceStatus;
  source_version: string | null;
  last_attempt_at: Date | null;
  last_successful_sync_at: Date | null;
  last_successful_sync_run_id: string | null;
}

interface SyncRunRow {
  id: string;
  provider_key: string;
  status: InventorySyncRunStatus;
  started_at: Date;
  finished_at: Date | null;
  items_processed: number;
  items_failed: number;
  details_json: Record<string, unknown> | null;
  error_summary: string | null;
}

export class InventoryService {
  constructor(
    private readonly pool: Pool,
    private readonly reservationChecks: InventoryReservationChecks = inventoryReservationChecks,
    private readonly maxAgeSeconds: number = DEFAULT_INVENTORY_MAX_AGE_SECONDS
  ) {}

  async listItems(query: Page): Promise<Paginated<AdminInventoryItem>> {
    const total = await this.pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM product_variants"
    );
    const rows = await this.pool.query<AdminInventoryRow>(
      `SELECT v.id AS variant_id, v.product_id, p.title AS product_title, v.sku,
              v.inventory_external_key,
              i.variant_id AS inventory_variant_id, i.source_quantity, i.safety_buffer, i.source_status,
              i.source_version, i.last_attempt_at, i.last_successful_sync_at, i.last_successful_sync_run_id
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN inventory_items i ON i.variant_id = v.id
        ORDER BY v.created_at, v.id
        LIMIT $1 OFFSET $2`,
      [query.limit, (query.page - 1) * query.limit]
    );
    const variantIds = rows.rows.map((row) => row.variant_id);
    const activeReservations = await this.reservationChecks.activeReservationsByVariant(this.pool, variantIds);
    const reconciliationPending = await this.reservationChecks.reconciliationPendingByVariant(this.pool, variantIds);

    const items = rows.rows.map((row) => {
      const reserved = activeReservations.get(row.variant_id) ?? 0;
      const pending = reconciliationPending.get(row.variant_id) ?? 0;
      const state = computeInventoryAvailability({
        sourceStatus: row.inventory_variant_id === null ? "UNINITIALIZED" : row.source_status,
        sourceQuantity: row.source_quantity,
        lastSuccessfulSyncAt: row.last_successful_sync_at,
        activeReservations: reserved,
        safetyBuffer: row.safety_buffer,
        maxAgeSeconds: this.maxAgeSeconds
      });
      return {
        variantId: row.variant_id,
        productId: row.product_id,
        productTitle: row.product_title,
        sku: row.sku,
        inventoryExternalKey: row.inventory_external_key,
        sourceQuantity: row.source_quantity,
        safetyBuffer: row.safety_buffer,
        sourceStatus: row.source_status,
        sourceVersion: row.source_version,
        lastAttemptAt: row.last_attempt_at,
        lastSuccessfulSyncAt: row.last_successful_sync_at,
        lastSuccessfulSyncRunId: row.last_successful_sync_run_id,
        activeReservations: reserved,
        reconciliationPending: pending,
        sellable: state.sellable,
        availability: state.availability,
        deficit: state.deficit
      };
    });
    return { items, page: query.page, limit: query.limit, total: total.rows[0]?.count ?? 0 };
  }

  async listSyncRuns(query: Page): Promise<Paginated<InventorySyncRunView>> {
    const total = await this.pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM inventory_sync_runs"
    );
    const rows = await this.pool.query<SyncRunRow>(
      `SELECT * FROM inventory_sync_runs ORDER BY started_at DESC, id LIMIT $1 OFFSET $2`,
      [query.limit, (query.page - 1) * query.limit]
    );
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        providerKey: row.provider_key,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        itemsProcessed: row.items_processed,
        itemsFailed: row.items_failed,
        details: row.details_json,
        errorSummary: row.error_summary
      })),
      page: query.page,
      limit: query.limit,
      total: total.rows[0]?.count ?? 0
    };
  }
}
