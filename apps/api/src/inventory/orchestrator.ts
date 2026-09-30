import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { InventoryProvider } from "./provider.js";
import { normalizeInventorySnapshot, type NormalizedSnapshot } from "./normalize.js";
import type { InventorySyncRunView, InventorySyncRunStatus } from "./service.js";

// One platform-wide lock, shared by Admin requests and scheduled executions.
export const INVENTORY_SYNC_LOCK = [1463899203, 1] as const;

export class InventorySyncError extends Error {
  constructor(
    readonly code: "SYNC_ALREADY_RUNNING" | "DEPENDENCY_UNAVAILABLE",
    readonly details: Record<string, unknown> = {}
  ) {
    super(code === "SYNC_ALREADY_RUNNING" ? "Inventory sync is already running" : "Inventory sync dependency unavailable");
  }
}

interface Mapping { id: string; inventory_external_key: string }

async function transaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const runProjection = `id, provider_key AS "providerKey", status, started_at AS "startedAt",
  finished_at AS "finishedAt", items_processed AS "itemsProcessed", items_failed AS "itemsFailed",
  details_json AS details, error_summary AS "errorSummary"`;

async function failedEvent(client: PoolClient, runId: string, providerKey: string): Promise<void> {
  await client.query(
    `INSERT INTO events (id, type, aggregate_type, aggregate_id, dedupe_key, payload)
     VALUES ($1, 'INVENTORY_SYNC_FAILED', 'inventory_sync_run', $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), runId, `inventory-sync:${runId}:failed`, { v: 1, runId, providerKey }]
  );
}

export class InventorySyncOrchestrator {
  constructor(private readonly pool: Pool, private readonly provider: InventoryProvider) {}

  async run(actorUserId: string | null = null): Promise<InventorySyncRunView> {
    let client: PoolClient;
    try { client = await this.pool.connect(); }
    catch { throw new InventorySyncError("DEPENDENCY_UNAVAILABLE"); }
    let locked = false;
    let destroy = false;
    // A checked-out pg client can emit an asynchronous connection error during
    // provider I/O. Keep it handled until release; subsequent queries fail closed.
    const connectionError = () => { destroy = true; };
    client.on("error", connectionError);
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired", [...INVENTORY_SYNC_LOCK]
      );
      locked = lock.rows[0]!.acquired;
      if (!locked) {
        const current = await client.query<InventorySyncRunView>(
          `SELECT ${runProjection} FROM inventory_sync_runs WHERE status = 'RUNNING' ORDER BY started_at DESC, id LIMIT 1`
        );
        throw new InventorySyncError("SYNC_ALREADY_RUNNING", { runSummary: current.rows[0] ?? null });
      }

      const runId = randomUUID();
      // A: advisory-lock ownership proves every previous RUNNING run was interrupted.
      await transaction(client, async () => {
        const stale = await client.query<{ id: string; provider_key: string; applied: number }>(
          `SELECT r.id, r.provider_key,
                  (SELECT count(*)::int FROM inventory_items i WHERE i.last_successful_sync_run_id = r.id) AS applied
             FROM inventory_sync_runs r WHERE r.status = 'RUNNING' ORDER BY r.started_at, r.id FOR UPDATE`
        );
        for (const row of stale.rows) {
          const status = row.applied > 0 ? "PARTIAL" : "FAILED";
          await client.query(
            `UPDATE inventory_sync_runs SET status = $2, finished_at = now(),
                    items_processed = $3, items_failed = GREATEST(items_failed, 1),
                    error_summary = 'INTERRUPTED',
                    details_json = COALESCE(details_json, '{}'::jsonb) || '{"recovered":true}'::jsonb WHERE id = $1`,
            [row.id, status, row.applied]
          );
          if (status === "FAILED") await failedEvent(client, row.id, row.provider_key);
        }
        await client.query(
          "INSERT INTO inventory_sync_runs (id, provider_key, status) VALUES ($1, $2, 'RUNNING')",
          [runId, this.provider.key]
        );
        await client.query(
          `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id)
           VALUES ($1, $2, 'inventory.sync.start', 'inventory_sync_run', $3)`,
          [randomUUID(), actorUserId, runId]
        );
      });

      let applied = 0;
      let failed = 0;
      let unknown = 0;
      let unknownExternalKeys: string[] = [];
      let changed = 0;
      const errors: string[] = [];
      // B: remember mappings before external I/O; reload them under C's locks.
      const mappings = await client.query<Mapping>("SELECT id, inventory_external_key FROM product_variants ORDER BY id");
      let snapshot: NormalizedSnapshot | null = null;
      try {
        if (!this.provider.capabilities().completeSnapshot) throw new Error("Incomplete snapshot");
        const normalized = normalizeInventorySnapshot(await this.provider.fetchSnapshot());
        if (normalized.kind === "invalid") throw new Error("Invalid snapshot");
        snapshot = normalized.snapshot;
      } catch {
        failed++;
        errors.push("PROVIDER_FETCH_FAILED");
      }

      if (snapshot) {
        failed += snapshot.issues.length;
        if (snapshot.issues.length) errors.push("SNAPSHOT_VALIDATION_FAILED");
        const records = new Map(snapshot.records.map((record) => [record.externalKey, record]));
        const invalidKeys = new Set(snapshot.issues.flatMap((issue) => "externalKey" in issue ? [issue.externalKey] : []));
        const configuredKeys = new Set(mappings.rows.map((row) => row.inventory_external_key));
        unknownExternalKeys = [...new Set([...records.keys(), ...invalidKeys].filter((key) => !configuredKeys.has(key)))];
        unknown = unknownExternalKeys.length;
        try {
          // C: acquire all Variants before InventoryItems; never acquire an earlier lock class afterward.
          const counts = await transaction(client, async () => {
            const ids = mappings.rows.map((row) => row.id);
            const current = await client.query<Mapping>(
              "SELECT id, inventory_external_key FROM product_variants WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]
            );
            const items = await client.query<{ variant_id: string }>(
              "SELECT variant_id FROM inventory_items WHERE variant_id = ANY($1::uuid[]) ORDER BY variant_id FOR UPDATE", [ids]
            );
            const currentKeys = new Map(current.rows.map((row) => [row.id, row.inventory_external_key]));
            const itemIds = new Set(items.rows.map((row) => row.variant_id));
            let successes = 0;
            let failures = 0;
            let changedMappings = 0;
            for (const mapping of mappings.rows) {
              if (currentKeys.get(mapping.id) !== mapping.inventory_external_key) {
                failures++;
                changedMappings++;
                continue;
              }
              const record = records.get(mapping.inventory_external_key);
              const status = invalidKeys.has(mapping.inventory_external_key) ? "INVALID" : record ? "OK" : "MISSING";
              await client.query("SAVEPOINT inventory_item_apply");
              try {
                if (!itemIds.has(mapping.id)) throw new Error("Inventory item missing");
                if (status === "OK" && record) {
                  await client.query(
                    `UPDATE inventory_items SET source_quantity = $2, source_status = 'OK', source_version = $3,
                            last_attempt_at = now(), last_successful_sync_at = $4,
                            last_successful_sync_run_id = $5, updated_at = now() WHERE variant_id = $1`,
                    [mapping.id, record.quantity, record.sourceVersion ?? snapshot!.sourceVersion, snapshot!.fetchedAt, runId]
                  );
                  successes++;
                } else {
                  await client.query(
                    "UPDATE inventory_items SET source_status = $2, last_attempt_at = now(), updated_at = now() WHERE variant_id = $1",
                    [mapping.id, status]
                  );
                  // Invalid records already contribute their validation errors.
                  if (status === "MISSING") failures++;
                }
              } catch {
                await client.query("ROLLBACK TO SAVEPOINT inventory_item_apply");
                failures++;
              }
              await client.query("RELEASE SAVEPOINT inventory_item_apply");
            }
            return { successes, failures, changedMappings };
          });
          applied = counts.successes;
          failed += counts.failures;
          changed = counts.changedMappings;
          if (counts.failures) errors.push("STOCK_APPLY_FAILED");
        } catch {
          failed++;
          errors.push("STOCK_APPLY_FAILED");
        }
      }
      // U01 selects MANUAL for Google Sheets: D/E make no proof calls or reservation mutations.
      // Only the audited Admin action may attest the applied snapshot; sync is never proof.

      // F: stock authority has already committed; failure here leaves RUNNING for recovery.
      const status: InventorySyncRunStatus = failed ? applied ? "PARTIAL" : "FAILED" : "SUCCESS";
      return await transaction(client, async () => {
        const result = await client.query<InventorySyncRunView>(
          `UPDATE inventory_sync_runs SET status = $2, finished_at = now(), items_processed = $3,
                  items_failed = $4, details_json = $5, error_summary = $6 WHERE id = $1 RETURNING ${runProjection}`,
          [runId, status, applied, failed, { unknownKeys: unknown, unknownExternalKeys, changedMappings: changed, errors }, errors.join(",") || null]
        );
        if (status === "FAILED") await failedEvent(client, runId, this.provider.key);
        return result.rows[0]!;
      });
    } catch (error) {
      if (error instanceof InventorySyncError) throw error;
      destroy = true;
      throw new InventorySyncError("DEPENDENCY_UNAVAILABLE");
    } finally {
      if (locked) {
        try {
          const result = await client.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock($1, $2) AS unlocked", [...INVENTORY_SYNC_LOCK]
          );
          destroy ||= !result.rows[0]?.unlocked;
        } catch { destroy = true; }
      }
      // Never put a session with an unreleased lock back into the pool.
      client.release(destroy);
      client.off("error", connectionError);
    }
  }
}

/** J-03 invokes the same domain orchestration; no retry queue or stock rewrite. */
export async function runScheduledInventorySync(
  orchestrator: InventorySyncOrchestrator,
  logger: { error(fields: Record<string, unknown>, message: string): void }
): Promise<void> {
  try { await orchestrator.run(); }
  catch (error) {
    if (error instanceof InventorySyncError && error.code === "SYNC_ALREADY_RUNNING") return;
    logger.error({ code: "DEPENDENCY_UNAVAILABLE" }, "Inventory sync failed; next execution will recover");
  }
}
