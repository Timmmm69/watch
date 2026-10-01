import type { Pool } from "pg";

export interface OutboxEvent {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string;
  payload: unknown;
  attempts: number;
  leaseExpiresAt: Date;
}

export interface OutboxOptions {
  maxAttempts?: number;
  leaseSeconds?: number;
  baseRetrySeconds?: number;
  maxRetrySeconds?: number;
}

export class EventOutbox {
  readonly maxAttempts: number;
  private readonly leaseSeconds: number;
  private readonly baseRetrySeconds: number;
  private readonly maxRetrySeconds: number;

  constructor(private readonly pool: Pool, options: OutboxOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 8;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.baseRetrySeconds = options.baseRetrySeconds ?? 5;
    this.maxRetrySeconds = options.maxRetrySeconds ?? 3600;
  }

  async claim(): Promise<OutboxEvent | null> {
    await this.pool.query(`
      UPDATE events SET status = 'FAILED', lease_expires_at = NULL,
        last_error = 'Lease expired after retry limit'
      WHERE status = 'PROCESSING' AND lease_expires_at <= now() AND attempts >= $1
    `, [this.maxAttempts]);
    const result = await this.pool.query<OutboxEvent & { lease_expires_at: Date }>(`
      WITH candidate AS (
        SELECT id FROM events
        WHERE (status = 'PENDING' AND next_attempt_at <= now())
           OR (status = 'PROCESSING' AND lease_expires_at <= now())
        ORDER BY next_attempt_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE events AS e SET status = 'PROCESSING', attempts = e.attempts + 1,
        processing_started_at = now(), lease_expires_at = now() + ($2::int * interval '1 second')
      FROM candidate WHERE e.id = candidate.id
      RETURNING e.id, e.type, e.aggregate_type AS "aggregateType", e.aggregate_id AS "aggregateId",
                e.dedupe_key AS "dedupeKey", e.payload, e.attempts, e.lease_expires_at AS "leaseExpiresAt"
    `, [this.maxAttempts, this.leaseSeconds]);
    const row = result.rows[0];
    if (!row) return null;
    return row;
  }

  async complete(event: OutboxEvent): Promise<void> {
    await this.pool.query(`
      UPDATE events SET status = 'PROCESSED', processed_at = now(),
        lease_expires_at = NULL, last_error = NULL
      WHERE id = $1 AND status = 'PROCESSING' AND attempts = $2
    `, [event.id, event.attempts]);
  }

  async fail(event: OutboxEvent, error: unknown): Promise<void> {
    const exhausted = event.attempts >= this.maxAttempts;
    const delay = exhausted ? 0 : Math.min(this.maxRetrySeconds, this.baseRetrySeconds * 2 ** (event.attempts - 1));
    await this.pool.query(`
      UPDATE events SET status = $3::"EventProcessingStatus",
        next_attempt_at = CASE WHEN $4 > 0 THEN now() + ($4::int * interval '1 second') ELSE next_attempt_at END,
        lease_expires_at = NULL, last_error = $5
      WHERE id = $1 AND status = 'PROCESSING' AND attempts = $2
    `, [event.id, event.attempts, exhausted ? "FAILED" : "PENDING", delay,
      error instanceof Error ? error.message.slice(0, 500) : "Unknown"]);
  }
}
