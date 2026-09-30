import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readSessionCookie, type AuthenticatedSession, type SessionStore } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthenticatedSession;
  }
}

export function createRequireSession(store: Pick<SessionStore, "loadCurrent">) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = readSessionCookie(request.headers.cookie);
    const auth = token ? await store.loadCurrent(token) : null;
    if (!auth) {
      sendAuthError(reply, 401, token ? "SESSION_EXPIRED" : "AUTH_REQUIRED", "Authentication required", request.id);
      return;
    }
    if (auth.user.isBlocked) {
      sendAuthError(reply, 403, "USER_BLOCKED", "User is blocked", request.id);
      return;
    }
    request.auth = auth;
  };
}

function sendAuthError(reply: FastifyReply, status: number, code: string, message: string, requestId: string): void {
  reply.code(status).send({ error: { code, message, details: {}, requestId } });
}

export function isAdmin(auth: AuthenticatedSession, adminIds: ReadonlySet<string>): boolean {
  return !auth.user.isBlocked && auth.user.isAdmin && adminIds.has(auth.user.telegramUserId);
}

export function createRequireAdmin(adminIds: () => ReadonlySet<string>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.auth || !isAdmin(request.auth, adminIds())) {
      sendAuthError(reply, 403, "ADMIN_REQUIRED", "Admin access required", request.id);
    }
  };
}

export function deriveCsrfToken(secret: Buffer, sessionId: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`, "utf8").digest("base64url");
}

export function createRequireCsrf(secret: Buffer, appBaseUrl: string) {
  const allowedOrigin = new URL(appBaseUrl).origin;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    const submitted = request.headers["x-csrf-token"];
    const expected = request.auth ? deriveCsrfToken(secret, request.auth.session.id) : null;
    if (origin !== allowedOrigin || expected === null || typeof submitted !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(submitted) ||
      !timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
      sendAuthError(reply, 403, "CSRF_INVALID", "Invalid CSRF token", request.id);
    }
  };
}
