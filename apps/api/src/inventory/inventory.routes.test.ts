import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";
import type { InventoryService } from "./service.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { InventorySyncError, type InventorySyncOrchestrator } from "./orchestrator.js";

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

function appWith(service: Partial<InventoryService>, loadCurrent = vi.fn().mockResolvedValue(admin), orchestrator?: Pick<InventorySyncOrchestrator, "run">) {
  return createApp({ checkReadiness: async () => undefined, logger: false,
    auth: { store: { loadCurrent } as unknown as SessionStore,
      csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set(["42"]) },
    inventory: { service: service as never, ...(orchestrator ? { orchestrator } : {}) } });
}

const syncHeaders = { cookie, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, admin.session.id) };

describe("admin inventory HTTP contract", () => {
  it("executes sync synchronously and returns committed terminal statuses including FAILED", async () => {
    for (const status of ["SUCCESS", "PARTIAL", "FAILED"]) {
      const run = vi.fn().mockResolvedValue({ id: "run", status });
      const app = appWith({}, undefined, { run });
      const response = await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", headers: syncHeaders, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: "run", status });
      expect(run).toHaveBeenCalledExactlyOnceWith(admin.user.id);
      await app.close();
    }
  });

  it("maps lock conflicts and infrastructure failures without fabricating success", async () => {
    for (const runSummary of [null, { id: "running", status: "RUNNING" }]) {
      const app = appWith({}, undefined, { run: vi.fn().mockRejectedValue(new InventorySyncError("SYNC_ALREADY_RUNNING", { runSummary })) });
      const response = await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", headers: syncHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({ code: "SYNC_ALREADY_RUNNING", details: { runSummary } });
      await app.close();
    }
    for (const runner of [undefined, { run: vi.fn().mockRejectedValue(new InventorySyncError("DEPENDENCY_UNAVAILABLE")) }]) {
      const app = appWith({}, undefined, runner);
      const response = await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", headers: syncHeaders });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("DEPENDENCY_UNAVAILABLE");
      await app.close();
    }
  });

  it("requires authentication, Admin/CSRF authorization and an empty body before running sync", async () => {
    const run = vi.fn();
    const loadCurrent = vi.fn().mockResolvedValue(admin);
    const app = appWith({}, loadCurrent, { run });
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", headers: { cookie } })).statusCode).toBe(403);
    for (const payload of [{ quantity: 10 }, [], null]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", payload: JSON.stringify(payload),
        headers: { ...syncHeaders, "content-type": "application/json" } })).statusCode).toBe(400);
    }
    loadCurrent.mockResolvedValue(buyer);
    const forbidden = await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", headers: { ...syncHeaders, "x-csrf-token": deriveCsrfToken(secret, buyer.session.id) } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");
    expect(run).not.toHaveBeenCalled();
    await app.close();
  });

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
