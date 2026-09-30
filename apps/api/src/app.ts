import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { healthResponseSchema, legalDocumentResponseSchema, readyResponseSchema } from "@watch/contracts";
import type { LegalDocumentType } from "@watch/config";
import { createRequireCsrf, createRequireSession, deriveCsrfToken, isAdmin } from "./auth/middleware.js";
import { BlockedUserError, readSessionCookie, serializeSessionCookie, SESSION_COOKIE_NAME, type SessionStore } from "./auth/session.js";
import { InvalidTelegramInitData, verifyTelegramInitData } from "./auth/telegram.js";
import type { LegalDocumentProjection } from "./legal/legal.js";
import { parseTelegramUpdate, type TelegramInbox } from "./telegram/inbox.js";

export interface AppDependencies {
  checkReadiness: () => Promise<void>;
  logger?: boolean;
  auth?: {
    store: SessionStore;
    csrfSecret: Buffer;
    appBaseUrl: string;
    adminIds: () => ReadonlySet<string>;
    botToken?: string;
  };
  legal?: { getCurrent: (type: LegalDocumentType) => Promise<LegalDocumentProjection | null> };
  webhook?: { secret: string; inbox: Pick<TelegramInbox, "insert"> };
}

export function createApp({ checkReadiness, logger = true, auth, legal, webhook }: AppDependencies) {
  const app = Fastify({ logger });

  app.get("/health", async () => healthResponseSchema.parse({ status: "ok" }));

  app.get("/ready", async (request, reply) => {
    try {
      await checkReadiness();
      return readyResponseSchema.parse({ status: "ready" });
    } catch (error) {
      request.log.error(
        { errorName: error instanceof Error ? error.name : "Unknown" },
        "Readiness check failed"
      );
      return reply.code(503).send({
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "Service is not ready",
          details: {},
          requestId: request.id
        }
      });
    }
  });

  if (auth) {
    const requireSession = createRequireSession(auth.store);
    const requireCsrf = createRequireCsrf(auth.csrfSecret, auth.appBaseUrl);
    if (auth.botToken) app.post("/api/v1/auth/telegram", { bodyLimit: 17_000 }, async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof (body as { initData?: unknown }).initData !== "string") {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid request", details: {}, requestId: request.id } });
      }
      try {
        const identity = verifyTelegramInitData((body as { initData: string }).initData, auth.botToken!);
        const current = await auth.store.upsertUserAndIssueSession(identity, readSessionCookie(request.headers.cookie));
        reply.header("Set-Cookie", serializeSessionCookie(current.token, current.session.expiresAt,
          new URL(auth.appBaseUrl).protocol === "https:"));
        return {
          user: { id: current.user.id, telegramUserId: current.user.telegramUserId,
            firstName: current.user.firstName, lastName: current.user.lastName,
            username: current.user.username, languageCode: current.user.languageCode },
          partner: null, isAdmin: isAdmin(current, auth.adminIds()),
          partnerTermsReacceptRequired: false,
          csrfToken: deriveCsrfToken(auth.csrfSecret, current.session.id),
          launchTarget: "/shop"
        };
      } catch (error) {
        if (error instanceof InvalidTelegramInitData || error instanceof BlockedUserError) {
          const blocked = error instanceof BlockedUserError;
          return reply.code(blocked ? 403 : 401).send({ error: {
            code: blocked ? "USER_BLOCKED" : "AUTH_REQUIRED",
            message: blocked ? "User is blocked" : "Invalid Telegram initData",
            details: {}, requestId: request.id
          } });
        }
        throw error;
      }
    });
    app.get("/api/v1/auth/session", { preHandler: requireSession }, async (request) => {
      const current = request.auth!;
      return {
        user: {
          id: current.user.id,
          telegramUserId: current.user.telegramUserId,
          firstName: current.user.firstName,
          lastName: current.user.lastName,
          username: current.user.username,
          languageCode: current.user.languageCode
        },
        partner: null,
        isAdmin: isAdmin(current, auth.adminIds()),
        partnerTermsReacceptRequired: false,
        csrfToken: deriveCsrfToken(auth.csrfSecret, current.session.id)
      };
    });
    app.post("/api/v1/auth/logout", { preHandler: [requireSession, requireCsrf] }, async (request, reply) => {
      await auth.store.revoke(request.auth!.session.id, request.auth!.user.id);
      reply.header("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${new URL(auth.appBaseUrl).protocol === "https:" ? "; Secure" : ""}`);
      return { ok: true };
    });

    if (legal) {
      app.get("/api/v1/legal/:type/current", { preHandler: requireSession }, async (request, reply) => {
        const type = (request.params as { type?: string }).type;
        if (type !== "PARTNER_TERMS" && type !== "SALES_TERMS" && type !== "PRIVACY") {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Unknown legal document type", details: {}, requestId: request.id } });
        }
        const document = await legal.getCurrent(type);
        if (!document) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No current legal document configured", details: {}, requestId: request.id } });
        }
        return legalDocumentResponseSchema.parse(document);
      });
    }
  }

  if (webhook) app.post("/api/v1/telegram/webhook", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const received = request.headers["x-telegram-bot-api-secret-token"];
    const expected = Buffer.from(webhook.secret);
    if (typeof received !== "string" || Buffer.byteLength(received) !== expected.length ||
      !timingSafeEqual(Buffer.from(received), expected)) {
      return reply.code(403).send({ error: { code: "AUTH_REQUIRED", message: "Forbidden", details: {}, requestId: request.id } });
    }
    const parsed = parseTelegramUpdate(request.body);
    if (!parsed) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid update", details: {}, requestId: request.id } });
    await webhook.inbox.insert(parsed.updateId, parsed.payload);
    return { ok: true };
  });

  return app;
}
