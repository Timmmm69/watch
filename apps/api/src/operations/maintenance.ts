import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export async function cleanupTransportData(pool: Pool, retentionDays: number): Promise<void> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) throw new Error("Raw-update retention must be 1..30 days");
  await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
  // Run hourly with a one-hour margin so healthy workers never retain raw payloads beyond the configured cap.
  await pool.query("DELETE FROM telegram_updates WHERE received_at <= now() - ($1::int * interval '1 hour')", [retentionDays * 24 - 1]);
}

export function startScheduledCleanup(pool: Pool, retentionDays: number,
  logger: { error(fields: object, message: string): void }): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = cleanupTransportData(pool, retentionDays).catch((error: unknown) => {
      logger.error({ errorName: error instanceof Error ? error.name : "Unknown" }, "Transport retention cleanup failed");
    }).finally(() => { pending = undefined; });
  }, 60 * 60 * 1000);
  // Startup cleanup is awaited before this scheduler is enabled.
  return async () => { clearInterval(timer); await pending; };
}

export async function retryFailed(pool: Pool, kind: "event" | "telegram", id: string, actorTelegramId: string, adminIds: string[]): Promise<void> {
  if (!adminIds.includes(actorTelegramId)) throw new Error("Operator is not a configured Admin");
  if (kind === "event" ? !/^[a-f0-9-]{36}$/i.test(id) : !/^[0-9]+$/.test(id)) throw new Error("Invalid retry identity");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actor = await client.query<{ id: string }>("SELECT id FROM users WHERE telegram_user_id=$1 AND is_admin AND NOT is_blocked FOR UPDATE", [actorTelegramId]);
    if (!actor.rows[0]) throw new Error("Operator Admin mirror is missing or blocked");
    const table = kind === "event" ? "events" : "telegram_updates";
    const key = kind === "event" ? "id" : "update_id";
    const row = await client.query<{ status: string }>(`SELECT status FROM ${table} WHERE ${key}=$1 FOR UPDATE`, [id]);
    if (row.rows[0]?.status !== "FAILED") throw new Error("Only a reviewed FAILED record can be retried");
    await client.query(`UPDATE ${table} SET status='PENDING', attempts=0, next_attempt_at=now(),
      processing_started_at=NULL, lease_expires_at=NULL, last_error=NULL WHERE ${key}=$1`, [id]);
    await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
      VALUES ($1,$2,'OPERATOR_RETRY',$3,$4,$5)`, [randomUUID(), actor.rows[0].id,
      kind === "event" ? "Event" : "TelegramUpdate", id, { reviewed: true }]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Safe support output: no request payloads, errors, tokens or Buyer PII. */
export async function supportDiagnostics(pool: Pool): Promise<object> {
  const events = await pool.query("SELECT status,count(*)::int AS count FROM events GROUP BY status");
  const updates = await pool.query("SELECT status,count(*)::int AS count FROM telegram_updates GROUP BY status");
  const sessions = await pool.query("SELECT count(*)::int AS expired FROM sessions WHERE expires_at<=now()");
  const oldest = await pool.query("SELECT min(received_at) AS oldest_raw_update FROM telegram_updates");
  const inventory = await pool.query(`SELECT status,started_at,finished_at FROM inventory_sync_runs ORDER BY started_at DESC LIMIT 5`);
  const failedEvents = await pool.query("SELECT id,type,attempts FROM events WHERE status='FAILED' ORDER BY created_at LIMIT 20");
  const failedUpdates = await pool.query("SELECT update_id::text,attempts FROM telegram_updates WHERE status='FAILED' ORDER BY received_at LIMIT 20");
  return { events: events.rows, telegram: updates.rows, sessions: sessions.rows[0], retention: oldest.rows[0],
    inventory: inventory.rows, failedEvents: failedEvents.rows, failedUpdates: failedUpdates.rows };
}
