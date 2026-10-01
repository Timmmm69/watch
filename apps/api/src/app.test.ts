import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { deriveCsrfToken } from "./auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "./auth/session.js";
import { CatalogNotFoundError, CatalogValidationError } from "./catalog/catalog.js";
import { ActiveProductInvariantError } from "./catalog/invariant.js";

describe("infrastructure endpoints", () => {
  it("trusts forwarding only from the configured proxy and disables trust by default", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" };
    for (const trustedProxyIp of [undefined, "172.30.36.2"]) {
      const app = createApp({ checkReadiness: async () => undefined, logger: false,
        ...(trustedProxyIp ? { trustedProxyIp } : {}) });
      app.get("/proxy-test", async (request) => ({ ip: request.ip, protocol: request.protocol }));
      const direct = await app.inject({ url: "/proxy-test", headers, remoteAddress: "172.30.36.3" });
      expect(direct.json()).toEqual({ ip: "172.30.36.3", protocol: "http" });
      const proxy = await app.inject({ url: "/proxy-test", headers, remoteAddress: "172.30.36.2" });
      expect(proxy.json()).toEqual(trustedProxyIp ? { ip: "203.0.113.9", protocol: "https" } : { ip: "172.30.36.2", protocol: "http" });
      const cors = await app.inject({ method: "OPTIONS", url: "/health", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
      expect(cors.headers["access-control-allow-origin"]).toBeUndefined();
      await app.close();
    }
  });

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

describe("catalog endpoints", () => {
  const secret = Buffer.alloc(32, 9);
  const admin = {
    session: { id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
    user: { id: "user-1", telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
      languageCode: null, isAdmin: true, isBlocked: false }
  };
  const buyer = {
    session: { id: "session-2", userId: "user-2", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
    user: { id: "user-2", telegramUserId: "43", firstName: "Bob", lastName: null, username: null,
      languageCode: null, isAdmin: false, isBlocked: false }
  };
  const adminCookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;
  const buyerCookie = `${SESSION_COOKIE_NAME}=${"b".repeat(43)}`;
  const adminCsrf = deriveCsrfToken(secret, "session-1");
  const categoryId = "00000000-0000-4000-8000-000000000020";
  const category = {
    id: categoryId, name: "Наручные", slug: "watches", sortOrder: 0, status: "ACTIVE",
    createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z"
  };

  function buildApp(service: Record<string, unknown>, session = admin) {
    const loadCurrent = vi.fn().mockImplementation((token: string) => {
      if (token === "a".repeat(43)) return Promise.resolve(admin);
      if (token === "b".repeat(43)) return Promise.resolve(buyer);
      return Promise.resolve(session);
    });
    return createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent } as unknown as SessionStore, csrfSecret: secret,
        appBaseUrl: "https://app.example", adminIds: () => new Set(["42"]) },
      catalog: { service: service as never } });
  }

  it("creates a category for an authorized Admin", async () => {
    const createCategory = vi.fn().mockResolvedValue(category);
    const app = buildApp({ createCategory });
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/categories",
      headers: { cookie: adminCookie, origin: "https://app.example", "x-csrf-token": adminCsrf },
      payload: { name: "Наручные", sortOrder: 0 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: categoryId, slug: "watches" });
    expect(createCategory).toHaveBeenCalledWith("user-1", { name: "Наручные", slug: undefined, sortOrder: 0 });
    await app.close();
  });

  it("rejects non-Admin users and missing CSRF for Admin catalog mutations", async () => {
    const createCategory = vi.fn();
    const app = buildApp({ createCategory });
    const forbidden = await app.inject({ method: "POST", url: "/api/v1/admin/categories",
      headers: { cookie: buyerCookie, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, "session-2") },
      payload: { name: "Наручные" } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");
    const noCsrf = await app.inject({ method: "POST", url: "/api/v1/admin/categories",
      headers: { cookie: adminCookie, origin: "https://app.example" }, payload: { name: "Наручные" } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("CSRF_INVALID");
    expect(createCategory).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps catalog validation, invariant, and not-found errors", async () => {
    const createCategory = vi.fn().mockRejectedValue(new CatalogValidationError("Slug already in use", { field: "slug" }));
    const app = buildApp({ createCategory });
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/categories",
      headers: { cookie: adminCookie, origin: "https://app.example", "x-csrf-token": adminCsrf },
      payload: { name: "Наручные" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "VALIDATION_ERROR", message: "Slug already in use" });
    expect(response.json().error.details).toEqual({ field: "slug" });

    const invariant = vi.fn().mockRejectedValue(
      new ActiveProductInvariantError({ productId: "00000000-0000-4000-8000-000000000030", unmet: ["ACTIVE_STOREFRONT_IMAGE_REQUIRED"] })
    );
    const invariantApp = buildApp({ createCategory: invariant });
    const invariantResponse = await invariantApp.inject({ method: "POST", url: "/api/v1/admin/categories",
      headers: { cookie: adminCookie, origin: "https://app.example", "x-csrf-token": adminCsrf },
      payload: { name: "Наручные" } });
    expect(invariantResponse.statusCode).toBe(400);
    expect(invariantResponse.json().error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(invariantResponse.json().error.details).toEqual({
      productId: "00000000-0000-4000-8000-000000000030", unmet: ["ACTIVE_STOREFRONT_IMAGE_REQUIRED"]
    });

    const missing = vi.fn().mockRejectedValue(new CatalogNotFoundError("Category not found"));
    const missingApp = buildApp({ createCategory: missing });
    const missingResponse = await missingApp.inject({ method: "POST", url: "/api/v1/admin/categories",
      headers: { cookie: adminCookie, origin: "https://app.example", "x-csrf-token": adminCsrf },
      payload: { name: "Наручные" } });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json().error.code).toBe("NOT_FOUND");
    await app.close();
    await invariantApp.close();
    await missingApp.close();
  });

  it("serves the buyer catalog shell only to authenticated users", async () => {
    const listStorefrontCategories = vi.fn().mockResolvedValue({ items: [{ id: categoryId, name: "Наручные", slug: "watches", sortOrder: 0 }] });
    const listStorefrontProducts = vi.fn().mockResolvedValue({ items: [], page: 1, limit: 20, total: 0 });
    const app = buildApp({ listStorefrontCategories, listStorefrontProducts });
    const categories = await app.inject({ method: "GET", url: "/api/v1/catalog/categories", headers: { cookie: buyerCookie } });
    expect(categories.statusCode).toBe(200);
    expect(categories.json()).toEqual({ items: [{ id: categoryId, name: "Наручные", slug: "watches", sortOrder: 0 }] });
    const products = await app.inject({ method: "GET", url: "/api/v1/catalog/products?page=1&limit=20", headers: { cookie: buyerCookie } });
    expect(products.statusCode).toBe(200);
    expect(products.json()).toEqual({ items: [], page: 1, limit: 20, total: 0 });
    expect(listStorefrontProducts).toHaveBeenCalledWith({ page: 1, limit: 20 }, { partner: null, userBlocked: false, partnerTermsReacceptRequired: false });
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/catalog/categories" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("AUTH_REQUIRED");
    await app.close();
  });

  it("validates and forwards generic storefront filters", async () => {
    const listStorefrontProducts = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 10, total: 0 });
    const app = buildApp({ listStorefrontProducts });
    const valid = await app.inject({ method: "GET",
      url: "/api/v1/catalog/products?q=Casio&category=watches&brand=Casio&minPriceMinor=100&maxPriceMinor=500&availability=UNKNOWN&page=2&limit=10",
      headers: { cookie: buyerCookie } });
    expect(valid.statusCode).toBe(200);
    expect(listStorefrontProducts).toHaveBeenCalledWith({ q: "Casio", category: "watches", brand: "Casio",
      minPriceMinor: 100, maxPriceMinor: 500, availability: "UNKNOWN", page: 2, limit: 10 }, { partner: null, userBlocked: false, partnerTermsReacceptRequired: false });
    for (const suffix of ["availability=AVAILABLE", "minPriceMinor=-1", "minPriceMinor=501&maxPriceMinor=500", "limit=101", "caseDiameter=42"]) {
      const invalid = await app.inject({ method: "GET", url: `/api/v1/catalog/products?${suffix}`, headers: { cookie: buyerCookie } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(listStorefrontProducts).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
