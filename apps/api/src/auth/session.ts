import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TelegramIdentity } from "./telegram.js";

export const SESSION_COOKIE_NAME = "watch_session";
const sessionLifetimeHours = 24;

export interface CurrentUser {
  id: string;
  telegramUserId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  isAdmin: boolean;
  isBlocked: boolean;
}

export interface CurrentSession {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface AuthenticatedSession {
  session: CurrentSession;
  user: CurrentUser;
}

export interface IssuedSession extends AuthenticatedSession {
  token: string;
  reused: boolean;
  launchTarget?: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  is_live?: boolean;
}

interface UserRow {
  id: string;
  telegram_user_id: string;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  is_admin: boolean;
  is_blocked: boolean;
}

interface LoadedRow extends SessionRow, UserRow {
  current_user_id: string;
}

function mapUser(row: UserRow): CurrentUser {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    languageCode: row.language_code,
    isAdmin: row.is_admin,
    isBlocked: row.is_blocked
  };
}

function mapSession(row: SessionRow): CurrentSession {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const matches = cookieHeader.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]?.slice(SESSION_COOKIE_NAME.length + 1) ?? "";
  return isSessionToken(token) ? token : null;
}

export function serializeSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  if (!isSessionToken(token)) throw new Error("Invalid session token");
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`;
}

export class SessionStore {
  constructor(private readonly pool: Pool, private readonly adminTelegramIds: ReadonlySet<string> = new Set()) {}

  async loadCurrent(token: string): Promise<AuthenticatedSession | null> {
    if (!isSessionToken(token)) return null;
    const result = await this.pool.query<LoadedRow>(`
      SELECT s.id, s.user_id, s.created_at, s.expires_at, s.revoked_at,
             u.id AS current_user_id, u.telegram_user_id::text AS telegram_user_id,
             u.first_name, u.last_name, u.username, u.language_code, u.is_admin, u.is_blocked
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
    `, [hashSessionToken(token)]);
    const row = result.rows[0];
    if (!row) return null;
    return { session: mapSession(row), user: mapUser({ ...row, id: row.current_user_id }) };
  }

  async upsertUserAndIssueSession(
    identity: TelegramIdentity,
    currentToken?: string | null,
    onLockedUser?: (client: PoolClient, user: CurrentUser) => Promise<string | null>
  ): Promise<IssuedSession> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query<UserRow>(`
        INSERT INTO users (id, telegram_user_id, first_name, last_name, username, language_code, is_admin)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (telegram_user_id) DO UPDATE SET
          first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
          username = EXCLUDED.username, language_code = EXCLUDED.language_code,
          is_admin = EXCLUDED.is_admin,
          updated_at = now()
        RETURNING id, telegram_user_id::text AS telegram_user_id, first_name, last_name,
                  username, language_code, is_admin, is_blocked
      `, [randomUUID(), identity.telegramUserId, identity.firstName, identity.lastName, identity.username, identity.languageCode,
        this.adminTelegramIds.has(identity.telegramUserId)]);
      const user = userResult.rows[0];
      if (!user) throw new Error("User upsert failed");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [user.id]);
      if (user.is_blocked) throw new BlockedUserError();
      const launchTarget = await onLockedUser?.(client, mapUser(user)) ?? "/shop";

      let existing: SessionRow | undefined;
      if (currentToken && isSessionToken(currentToken)) {
        const existingResult = await client.query<SessionRow>(`
          SELECT id, user_id, created_at, expires_at, revoked_at, expires_at > now() AS is_live FROM sessions
          WHERE token_hash = $1 FOR UPDATE
        `, [hashSessionToken(currentToken)]);
        existing = existingResult.rows[0];
      }
      if (existing && existing.user_id === user.id && existing.revoked_at === null && existing.is_live) {
        await client.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [existing.id]);
        await client.query("COMMIT");
        return { user: mapUser(user), session: mapSession(existing), token: currentToken!, reused: true, launchTarget };
      }
      if (existing && existing.user_id !== user.id && existing.revoked_at === null) {
        await client.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [existing.id]);
      }
      const token = randomBytes(32).toString("base64url");
      const created = await client.query<SessionRow>(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, now() + interval '${sessionLifetimeHours} hours')
        RETURNING id, user_id, created_at, expires_at, revoked_at
      `, [randomUUID(), user.id, hashSessionToken(token)]);
      const session = created.rows[0];
      if (!session) throw new Error("Session insert failed");
      await client.query("COMMIT");
      return { user: mapUser(user), session: mapSession(session), token, reused: false, launchTarget };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(sessionId: string, userId: string): Promise<void> {
    await this.pool.query(
      "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [sessionId, userId]
    );
  }
}

export class BlockedUserError extends Error {
  constructor() { super("User is blocked"); }
}
