import { randomInt } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { hashSessionToken, SessionStore } from "./session.js";
import type { TelegramIdentity } from "./telegram.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const store = pool ? new SessionStore(pool) : null;
const createdUserIds: string[] = [];

function identity(): TelegramIdentity {
  return {
    telegramUserId: String(randomInt(1_000_000_000, 9_000_000_000)),
    firstName: "Integration", lastName: null, username: null, languageCode: null,
    startParam: null, replayIdentity: "a".repeat(64)
  };
}

afterAll(async () => {
  if (!pool) return;
  if (createdUserIds.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]);
  await pool.end();
});

describe.skipIf(!databaseUrl)("Session store against PostgreSQL", () => {
  it("persists Admin mirror grants and revokes on fresh Telegram auth", async () => {
    const actor = identity();
    const grantStore = new SessionStore(pool!, new Set([actor.telegramUserId]));
    const granted = await grantStore.upsertUserAndIssueSession(actor);
    createdUserIds.push(granted.user.id);
    expect(granted.user.isAdmin).toBe(true);
    const revokeStore = new SessionStore(pool!, new Set());
    const revoked = await revokeStore.upsertUserAndIssueSession(actor, granted.token);
    expect(revoked.reused).toBe(true);
    expect(revoked.user.isAdmin).toBe(false);
    expect((await revokeStore.loadCurrent(granted.token))?.user.isAdmin).toBe(false);
  });
  it("persists only token hashes and retains absolute expiry on same-user reuse", async () => {
    const issued = await store!.upsertUserAndIssueSession(identity());
    createdUserIds.push(issued.user.id);
    const row = await pool!.query<{ token_hash: string; duration_seconds: number }>(`
      SELECT token_hash, EXTRACT(EPOCH FROM expires_at - created_at)::int AS duration_seconds
      FROM sessions WHERE id = $1
    `, [issued.session.id]);
    expect(row.rows[0]?.token_hash).toBe(hashSessionToken(issued.token));
    expect(row.rows[0]?.token_hash).not.toBe(issued.token);
    expect(row.rows[0]?.duration_seconds).toBe(86_400);

    const reused = await store!.upsertUserAndIssueSession({ ...identity(), telegramUserId: issued.user.telegramUserId }, issued.token);
    expect(reused.reused).toBe(true);
    expect(reused.session.id).toBe(issued.session.id);
    expect(reused.session.expiresAt).toEqual(issued.session.expiresAt);
    await pool!.query("UPDATE users SET is_blocked = true WHERE id = $1", [issued.user.id]);
    expect((await store!.loadCurrent(issued.token))?.user.isBlocked).toBe(true);
  });

  it("replaces expired tokens and revokes a cookie bound to another User", async () => {
    const first = await store!.upsertUserAndIssueSession(identity());
    const secondIdentity = identity();
    createdUserIds.push(first.user.id);
    await pool!.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [first.session.id]);
    expect(await store!.loadCurrent(first.token)).toBeNull();
    const replacement = await store!.upsertUserAndIssueSession({ ...identity(), telegramUserId: first.user.telegramUserId }, first.token);
    expect(replacement.reused).toBe(false);
    expect(replacement.token).not.toBe(first.token);

    const second = await store!.upsertUserAndIssueSession(secondIdentity, replacement.token);
    createdUserIds.push(second.user.id);
    expect(second.reused).toBe(false);
    expect(second.user.id).not.toBe(first.user.id);
    expect(await store!.loadCurrent(replacement.token)).toBeNull();
    expect((await store!.loadCurrent(second.token))?.user.id).toBe(second.user.id);
  });
});
