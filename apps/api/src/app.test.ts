import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { deriveCsrfToken } from "./auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "./auth/session.js";

describe("infrastructure endpoints", () => {
  it("serves liveness without checking dependencies", async () => {
    const checkReadiness = vi.fn(async () => undefined);
    const app = createApp({ checkReadiness, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(checkReadiness).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns ready only when the readiness probe passes", async () => {
    const app = createApp({ checkReadiness: async () => undefined, logger: false });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    await app.close();
  });

  it("reports a dependency failure without exposing the underlying error", async () => {
    const app = createApp({
      checkReadiness: async () => { throw new Error("secret database detail"); },
      logger: false
    });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(response.body).not.toContain("secret database detail");
    await app.close();
  });
});

describe("legal document endpoints", () => {
  const secret = Buffer.alloc(32, 4);
  const current = {
    session: { id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
    user: { id: "user-1", telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
      languageCode: null, isAdmin: false, isBlocked: false }
  };
  const cookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;
  const document = {
    id: "00000000-0000-4000-8000-000000000001", type: "PARTNER_TERMS" as const, version: "v1",
    sha256: "a".repeat(64), contentMarkdown: "# Terms", effectiveAt: "2026-01-01T00:00:00.000Z", requiresReacceptance: false
  };

  it("serves the configured current legal document to an authenticated user", async () => {
    const loadCurrent = vi.fn().mockResolvedValue(current);
    const getCurrent = vi.fn().mockResolvedValue(document);
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent } as unknown as SessionStore, csrfSecret: secret,
        appBaseUrl: "https://app.example", adminIds: () => new Set() },
      legal: { getCurrent } });
    const response = await app.inject({ method: "GET", url: "/api/v1/legal/PARTNER_TERMS/current", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: document.id, type: "PARTNER_TERMS", version: "v1", contentMarkdown: "# Terms" });
    expect(getCurrent).toHaveBeenCalledWith("PARTNER_TERMS");
    await app.close();
  });

  it("returns NOT_FOUND for an unknown type without querying", async () => {
    const loadCurrent = vi.fn().mockResolvedValue(current);
    const getCurrent = vi.fn();
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent } as unknown as SessionStore, csrfSecret: secret,
        appBaseUrl: "https://app.example", adminIds: () => new Set() },
      legal: { getCurrent } });
    const response = await app.inject({ method: "GET", url: "/api/v1/legal/UNKNOWN/current", headers: { cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(getCurrent).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns NOT_FOUND when the type has no configured current document", async () => {
    const loadCurrent = vi.fn().mockResolvedValue(current);
    const getCurrent = vi.fn().mockResolvedValue(null);
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent } as unknown as SessionStore, csrfSecret: secret,
        appBaseUrl: "https://app.example", adminIds: () => new Set() },
      legal: { getCurrent } });
    const response = await app.inject({ method: "GET", url: "/api/v1/legal/SALES_TERMS/current", headers: { cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("requires an authenticated session", async () => {
    const loadCurrent = vi.fn().mockResolvedValue(null);
    const getCurrent = vi.fn();
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent } as unknown as SessionStore, csrfSecret: secret,
        appBaseUrl: "https://app.example", adminIds: () => new Set() },
      legal: { getCurrent } });
    const response = await app.inject({ method: "GET", url: "/api/v1/legal/PARTNER_TERMS/current" });
    expect(response.statusCode).toBe(401);
    expect(getCurrent).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("session and logout endpoints", () => {
  it("returns current authority and revokes a CSRF-authorized logout", async () => {
    const secret = Buffer.alloc(32, 4);
    const current = {
      session: { id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
      user: { id: "user-1", telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
        languageCode: null, isAdmin: true, isBlocked: false }
    };
    const loadCurrent = vi.fn().mockResolvedValue(current);
    const revoke = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent, revoke } as unknown as SessionStore, csrfSecret: secret,
        appBaseUrl: "https://app.example", adminIds: () => new Set(["42"]) } });
    const cookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;
    const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ isAdmin: true, partner: null, partnerTermsReacceptRequired: false,
      csrfToken: deriveCsrfToken(secret, "session-1") });
    const denied = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(denied.json().error.code).toBe("CSRF_INVALID");
    expect(revoke).not.toHaveBeenCalled();
    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout",
      headers: { cookie, origin: "https://app.example", "x-csrf-token": session.json().csrfToken } });
    expect(logout.json()).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledWith("session-1", "user-1");
    expect(logout.headers["set-cookie"]).toContain(`${SESSION_COOKIE_NAME}=;`);
    await app.close();
  });
});

describe("partner onboarding endpoint", () => {
  const secret = Buffer.alloc(32, 5);
  const current = {
    session: { id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
    user: { id: "user-1", telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
      languageCode: null, isAdmin: false, isBlocked: false }
  };
  const cookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;
  const csrf = deriveCsrfToken(secret, "session-1");
  const documentId = "00000000-0000-4000-8000-000000000001";

  function buildApp(onboard: ReturnType<typeof vi.fn>) {
    const loadCurrent = vi.fn().mockResolvedValue(current);
    return createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent } as unknown as SessionStore, csrfSecret: secret,
        appBaseUrl: "https://app.example", adminIds: () => new Set() },
      partner: { loadState: vi.fn().mockResolvedValue({ partner: null, partnerTermsReacceptRequired: false }), onboard } });
  }

  it("creates or returns the Partner for a valid current-terms acceptance", async () => {
    const onboard = vi.fn().mockResolvedValue({ kind: "ok", partner: { id: "00000000-0000-4000-8000-000000000010", status: "ACTIVE" } });
    const app = buildApp(onboard);
    const response = await app.inject({ method: "POST", url: "/api/v1/partner/onboarding",
      headers: { cookie, origin: "https://app.example", "x-csrf-token": csrf },
      payload: { documentId, documentVersion: "v1", accept: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ partner: { id: "00000000-0000-4000-8000-000000000010", status: "ACTIVE" } });
    expect(onboard).toHaveBeenCalledWith("user-1", documentId, "v1");
    await app.close();
  });

  it("returns TERMS_VERSION_CHANGED with current document metadata on a stale acceptance", async () => {
    const onboard = vi.fn().mockResolvedValue({ kind: "stale", currentDocument: { id: "00000000-0000-4000-8000-000000000099", version: "v2" } });
    const app = buildApp(onboard);
    const response = await app.inject({ method: "POST", url: "/api/v1/partner/onboarding",
      headers: { cookie, origin: "https://app.example", "x-csrf-token": csrf },
      payload: { documentId, documentVersion: "v1", accept: true } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "TERMS_VERSION_CHANGED" });
    expect(response.json().error.details.currentDocument).toEqual({ id: "00000000-0000-4000-8000-000000000099", version: "v2" });
    await app.close();
  });

  it("rejects a missing or false acceptance without invoking onboarding", async () => {
    const onboard = vi.fn();
    const app = buildApp(onboard);
    for (const payload of [
      { documentId, documentVersion: "v1", accept: false },
      { documentId, documentVersion: "v1" },
      { documentId, documentVersion: "v1", accept: "yes" }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/partner/onboarding",
        headers: { cookie, origin: "https://app.example", "x-csrf-token": csrf }, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(onboard).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a valid CSRF token", async () => {
    const onboard = vi.fn();
    const app = buildApp(onboard);
    const response = await app.inject({ method: "POST", url: "/api/v1/partner/onboarding",
      headers: { cookie, origin: "https://app.example" },
      payload: { documentId, documentVersion: "v1", accept: true } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_INVALID");
    expect(onboard).not.toHaveBeenCalled();
    await app.close();
  });
});
