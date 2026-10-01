import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { EventOutbox } from "./outbox.js";

class MockPool {
  queries: { sql: string; params: unknown[] }[] = [];
  private responses: Map<string, unknown> = new Map();

  query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params: params ?? [] });
    const key = `${sql}|${JSON.stringify(params ?? [])}`;
    const response = this.responses.get(key) ?? this.responses.get(sql) ?? { rows: [] };
    return Promise.resolve(response as { rows: unknown[] });
  }

  set(sql: string, params: unknown[], rows: unknown[]) {
    this.responses.set(`${sql}|${JSON.stringify(params)}`, { rows });
  }

  setBySql(sql: string, rows: unknown[]) {
    this.responses.set(sql, { rows });
  }
}

describe("EventOutbox", () => {
  it("claims a PENDING event with lease and increments attempts", async () => {
    const pool = new MockPool();
    const event = {
      id: "e1", type: "ORDER_CREATED", aggregate_type: "Order", aggregate_id: "a1",
      dedupe_key: "d1", payload: { v: 1 }, attempts: 0, lease_expires_at: new Date()
    };
    pool.setBySql(`
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
    `, [event]);
    const outbox = new EventOutbox(pool as unknown as Pool);
    const claimed = await outbox.claim();
    expect(claimed).toBeTruthy();
    expect(claimed!.id).toBe("e1");
    expect(claimed!.attempts).toBe(0);
    const update = pool.queries.find((q) => q.sql.includes("UPDATE events AS e SET status = 'PROCESSING'"));
    expect(update?.params).toEqual([8, 60]);
  });

  it("returns null when no event is available", async () => {
    const pool = new MockPool();
    pool.setBySql(`
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
    `, []);
    const outbox = new EventOutbox(pool as unknown as Pool);
    expect(await outbox.claim()).toBeNull();
  });

  it("marks exhausted events FAILED on fail", async () => {
    const pool = new MockPool();
    const outbox = new EventOutbox(pool as unknown as Pool, { maxAttempts: 1 });
    const event = { id: "e1", type: "ORDER_CREATED", aggregateType: "Order", aggregateId: "a1", dedupeKey: "d1", payload: {}, attempts: 1, leaseExpiresAt: new Date() };
    await outbox.fail(event, new Error("boom"));
    const q = pool.queries.find((q) => q.sql.includes("UPDATE events SET status = $3"));
    expect(q?.params[2]).toBe("FAILED");
  });

  it("schedules retry for non-exhausted failures", async () => {
    const pool = new MockPool();
    const outbox = new EventOutbox(pool as unknown as Pool, { maxAttempts: 5, baseRetrySeconds: 10 });
    const event = { id: "e1", type: "ORDER_CREATED", aggregateType: "Order", aggregateId: "a1", dedupeKey: "d1", payload: {}, attempts: 1, leaseExpiresAt: new Date() };
    await outbox.fail(event, new Error("boom"));
    const q = pool.queries.find((q) => q.sql.includes("UPDATE events SET status = $3"));
    expect(q?.params[2]).toBe("PENDING");
    expect(q?.params[3]).toBe(10);
  });

  it("caps retry delay", async () => {
    const pool = new MockPool();
    const outbox = new EventOutbox(pool as unknown as Pool, { maxAttempts: 10, baseRetrySeconds: 5, maxRetrySeconds: 60 });
    const event = { id: "e1", type: "ORDER_CREATED", aggregateType: "Order", aggregateId: "a1", dedupeKey: "d1", payload: {}, attempts: 10, leaseExpiresAt: new Date() };
    await outbox.fail(event, new Error("boom"));
    const q = pool.queries.find((q) => q.sql.includes("UPDATE events SET status = $3"));
    expect(q?.params[3]).toBeLessThanOrEqual(60);
  });
});
