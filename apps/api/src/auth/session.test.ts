import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { hashSessionToken, readSessionCookie, serializeSessionCookie, SessionStore } from "./session.js";
import type { TelegramIdentity } from "./telegram.js";

const identity: TelegramIdentity = {
  telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
  languageCode: null, startParam: null, replayIdentity: "a".repeat(64)
};
const user = {
  id: "user-1", telegram_user_id: "42", first_name: "Ada", last_name: null,
  username: null, language_code: null, is_admin: false, is_blocked: false
};
const existingSession = {
  id: "session-1", user_id: "user-1", created_at: new Date("2026-01-01T00:00:00Z"),
  expires_at: new Date("2026-01-02T00:00:00Z"), revoked_at: null, is_live: true
};
const oldToken = "a".repeat(43);

function fakePool(existing?: typeof existingSession) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("INSERT INTO users")) return { rows: [user] };
    if (sql.includes("SELECT id FROM users")) return { rows: [{ id: user.id }] };
    if (sql.includes("SELECT id, user_id, created_at, expires_at, revoked_at, expires_at > now()")) {
      return { rows: existing ? [existing] : [] };
    }
    if (sql.includes("INSERT INTO sessions")) return { rows: [{ ...existingSession, id: "session-new", user_id: user.id }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { pool, query, release };
}

describe("Session store", () => {
  it("reuses only a live same-user session without extending absolute expiry", async () => {
    const { pool, query } = fakePool(existingSession);
    const issued = await new SessionStore(pool).upsertUserAndIssueSession(identity, oldToken);
    expect(issued).toMatchObject({ token: oldToken, reused: true, session: { id: "session-1" } });
    expect(issued.session.expiresAt).toEqual(existingSession.expires_at);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO sessions"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("last_seen_at = now()"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("expires_at ="))).toBe(false);
  });

  it("replaces an expired session with a fresh 256-bit token and 24-hour absolute expiry", async () => {
    const { pool, query } = fakePool({ ...existingSession, is_live: false });
    const issued = await new SessionStore(pool).upsertUserAndIssueSession(identity, oldToken);
    expect(issued.reused).toBe(false);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.token).not.toBe(oldToken);
    const insertion = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO sessions"));
    expect(insertion?.[0]).toContain("now() + interval '24 hours'");
    expect(insertion?.[1]).toContain(hashSessionToken(issued.token));
    expect(insertion?.[1]).not.toContain(issued.token);
  });

  it("revokes a live cross-user cookie before creating a session for the validated User", async () => {
    const { pool, query } = fakePool({ ...existingSession, user_id: "other-user" });
    const issued = await new SessionStore(pool).upsertUserAndIssueSession(identity, oldToken);
    expect(issued.reused).toBe(false);
    expect(issued.session.userId).toBe(user.id);
    const revokeIndex = query.mock.calls.findIndex(([sql]) => sql.includes("SET revoked_at = now()"));
    const insertIndex = query.mock.calls.findIndex(([sql]) => sql.includes("INSERT INTO sessions"));
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(revokeIndex).toBeLessThan(insertIndex);
  });

  it("rejects duplicate cookie names and never parses malformed token values", () => {
    expect(readSessionCookie(`watch_session=${oldToken}`)).toBe(oldToken);
    expect(readSessionCookie(`watch_session=${oldToken}; watch_session=${oldToken}`)).toBeNull();
    expect(readSessionCookie("watch_session=short")).toBeNull();
    expect(serializeSessionCookie(oldToken, existingSession.expires_at, true)).toContain("HttpOnly; SameSite=Lax; Expires=Fri, 02 Jan 2026 00:00:00 GMT; Secure");
  });

  it("loads a current User from DB with every authenticated Session lookup", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...user, ...existingSession, current_user_id: user.id }] });
    const store = new SessionStore({ query } as unknown as Pool);
    expect((await store.loadCurrent(oldToken))?.user).toMatchObject({ telegramUserId: "42", isBlocked: false });
    expect(query.mock.calls[0]?.[0]).toContain("JOIN users u ON u.id = s.user_id");
    expect(query.mock.calls[0]?.[0]).toContain("s.expires_at > now()");
    expect(query.mock.calls[0]?.[1]).toEqual([hashSessionToken(oldToken)]);
  });

  it("synchronizes the persisted Admin mirror in both directions on Telegram bootstrap", async () => {
    for (const [ids, expected] of [[new Set(["42"]), true], [new Set<string>(), false]] as const) {
      const { pool, query } = fakePool();
      await new SessionStore(pool, ids).upsertUserAndIssueSession(identity);
      const upsert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO users"));
      expect(upsert?.[0]).toContain("is_admin = EXCLUDED.is_admin");
      expect(upsert?.[1]?.[6]).toBe(expected);
    }
  });

  it("revokes only the current User's session", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await new SessionStore({ query } as unknown as Pool).revoke("session-1", "user-1");
    expect(query.mock.calls[0]?.[0]).toContain("id = $1 AND user_id = $2 AND revoked_at IS NULL");
    expect(query.mock.calls[0]?.[1]).toEqual(["session-1", "user-1"]);
  });
});
