import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";
import type { InventoryService } from "./service.js";

const secret = Buffer.alloc(32, 8);
const cookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;

const admin = {
  session: { id: "session-1", userId: "00000000-0000-4000-8000-000000000001", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
  user: { id: "00000000-0000-4000-8000-000000000001", telegramUserId: "42", firstName: "Ada", lastName: null,
    username: null, languageCode: null, isAdmin: true, isBlocked: false }
};
const buyer = {
  session: { id: "session-2", userId: "00000000-0000-4000-8000-000000000002", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
  user: { id: "00000000-0000-4000-8000-000000000002", telegramUserId: "43", firstName: "Bob", lastName: null,
    username: null, languageCode: null, isAdmin: false, isBlocked: false }
};

function appWith(service: Partial<InventoryService>, loadCurrent = vi.fn().mockResolvedValue(admin)) {
  return createApp({ checkReadiness: async () => undefined, logger: false,
    auth: { store: { loadCurrent } as unknown as SessionStore,
      csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set(["42"]) },
    inventory: { service: service as never } });
}

describe("admin inventory HTTP contract", () => {
  it("serves the inventory status projection to an Admin with pagination defaults", async () => {
    const listItems = vi.fn().mockResolvedValue({ items: [], page: 1, limit: 20, total: 0 });
    const app = appWith({ listItems });
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/inventory", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], page: 1, limit: 20, total: 0 });
    expect(listItems).toHaveBeenCalledWith({ page: 1, limit: 20 });
    await app.close();
  });

  it("forwards valid pagination and rejects invalid pagination", async () => {
    const listItems = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 10, total: 0 });
    const app = appWith({ listItems });
    const valid = await app.inject({ method: "GET", url: "/api/v1/admin/inventory?page=2&limit=10", headers: { cookie } });
    expect(valid.statusCode).toBe(200);
    expect(listItems).toHaveBeenCalledWith({ page: 2, limit: 10 });
    for (const query of ["page=0", "limit=101", "page=x"]) {
      const invalid = await app.inject({ method: "GET", url: `/api/v1/admin/inventory?${query}`, headers: { cookie } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
    }
    await app.close();
  });

  it("serves recent sync runs to an Admin", async () => {
    const listSyncRuns = vi.fn().mockResolvedValue({ items: [], page: 1, limit: 20, total: 0 });
    const app = appWith({ listSyncRuns });
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/inventory/sync-runs", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(listSyncRuns).toHaveBeenCalledWith({ page: 1, limit: 20 });
    await app.close();
  });

  it("rejects non-Admin users and anonymous requests", async () => {
    const listItems = vi.fn();
    const loadCurrent = vi.fn().mockResolvedValue(buyer);
    const app = appWith({ listItems }, loadCurrent);
    const forbidden = await app.inject({ method: "GET", url: "/api/v1/admin/inventory", headers: { cookie } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/admin/inventory/sync-runs" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("AUTH_REQUIRED");
    expect(listItems).not.toHaveBeenCalled();
    await app.close();
  });
});
