import type { Pool } from "pg";

export interface TelegramUpdate {
  update_id: string;
  payload: unknown;
  attempts: number;
  lease_expires_at: Date;
}

export function parseTelegramUpdate(body: unknown): { updateId: string; payload: Record<string, unknown> } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const payload = body as Record<string, unknown>;
  const id = payload.update_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return null;
  return { updateId: String(id), payload };
}

export class TelegramInbox {
  constructor(private readonly pool: Pool) {}

  async insert(updateId: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "INSERT INTO telegram_updates (update_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (update_id) DO NOTHING",
      [updateId, JSON.stringify(payload)]
    );
  }

  async claim(): Promise<TelegramUpdate | null> {
    await this.pool.query(`
      UPDATE telegram_updates SET status = 'FAILED', lease_expires_at = NULL,
        last_error = 'Lease expired after retry limit'
      WHERE status = 'PROCESSING' AND lease_expires_at <= now() AND attempts >= 5
    `);
    const result = await this.pool.query<TelegramUpdate>(`
      WITH candidate AS (
        SELECT update_id FROM telegram_updates
        WHERE (status = 'PENDING' AND next_attempt_at <= now())
           OR (status = 'PROCESSING' AND lease_expires_at <= now())
        ORDER BY next_attempt_at, update_id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE telegram_updates AS t SET status = 'PROCESSING', attempts = t.attempts + 1,
        processing_started_at = now(), lease_expires_at = now() + interval '60 seconds'
      FROM candidate WHERE t.update_id = candidate.update_id
      RETURNING t.update_id::text AS update_id, t.payload, t.attempts, t.lease_expires_at
    `);
    return result.rows[0] ?? null;
  }

  async complete(update: TelegramUpdate): Promise<void> {
    await this.pool.query(`
      UPDATE telegram_updates SET status = 'PROCESSED', processed_at = now(),
        lease_expires_at = NULL, last_error = NULL
      WHERE update_id = $1 AND status = 'PROCESSING' AND attempts = $2
    `, [update.update_id, update.attempts]);
  }

  async fail(update: TelegramUpdate, error: unknown): Promise<void> {
    const exhausted = update.attempts >= 5;
    const delay = Math.min(300, 2 ** update.attempts);
    await this.pool.query(`
      UPDATE telegram_updates SET status = $3::"TelegramUpdateStatus",
        next_attempt_at = now() + ($4::int * interval '1 second'),
        lease_expires_at = NULL, last_error = $5
      WHERE update_id = $1 AND status = 'PROCESSING' AND attempts = $2
    `, [update.update_id, update.attempts,
      exhausted ? "FAILED" : "PENDING", delay,
      error instanceof Error ? error.name : "Unknown"]);
  }
}
