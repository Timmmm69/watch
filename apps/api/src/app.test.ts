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
