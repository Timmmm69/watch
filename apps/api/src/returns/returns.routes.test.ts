import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { type SessionStore } from "../auth/session.js";
import { ReturnError } from "./returns.js";
import { adminReturnCreateRequestSchema, adminReturnListQuerySchema } from "@watch/contracts";

const id = "00000000-0000-4000-8000-000000000001";
const secret = Buffer.alloc(32, 7);
const cookie = `watch_session=${"a".repeat(43)}`;
const headers = { cookie, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, "session-1") };
const detail = { id, orderId: id, orderPublicNumber: "W-0123456789AB", status: "OPEN", reason: "Broken", note: null,
  createdByAdminUserId: id, currency: "BYN", items: [], reversalPreviewMinor: 0,
  createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
function setup(admin = true, blocked = false) {
  const returns = { list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    detail: vi.fn().mockResolvedValue(detail), create: vi.fn().mockResolvedValue(detail),
    cancel: vi.fn().mockResolvedValue(detail), complete: vi.fn().mockResolvedValue({ ...detail, status: "COMPLETED" }) };
  const current = { session: { id: "session-1", userId: id }, user: { id, telegramUserId: "42", isAdmin: admin, isBlocked: blocked } };
  const app = createApp({ logger: false, checkReadiness: async () => undefined, returns,
    auth: { store: { loadCurrent: vi.fn().mockResolvedValue(current) } as unknown as SessionStore, csrfSecret: secret,
      appBaseUrl: "https://app.example", adminIds: () => new Set(admin ? ["42"] : []) } });
  return { app, returns };
}
describe("Admin Return API", () => {
  it("protects list/detail and mutations with Session/Admin/Origin/CSRF", async () => {
    const { app, returns } = setup();
    const payload = { orderId: id, reason: "Broken item", items: [{ orderItemId: id, quantity: 1 }] };
    for (const url of ["/api/v1/admin/returns", `/api/v1/admin/returns/${id}`]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
      const nonAdmin = setup(false);
      expect((await nonAdmin.app.inject({ url, headers: { cookie } })).statusCode).toBe(403);
      await nonAdmin.app.close();
    }
    for (const requestHeaders of [{ cookie }, { ...headers, origin: "https://wrong.example" }, { ...headers, "x-csrf-token": "bad" }]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/admin/returns", headers: requestHeaders, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/v1/admin/returns/${id}/cancel`, headers: requestHeaders, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/v1/admin/returns/${id}/complete`, headers: requestHeaders, payload: {} })).statusCode).toBe(403);
    }
    expect(returns.create).not.toHaveBeenCalled(); expect(returns.cancel).not.toHaveBeenCalled(); expect(returns.complete).not.toHaveBeenCalled();
    const blocked = setup(true, true);
    expect((await blocked.app.inject({ method: "POST", url: "/api/v1/admin/returns", headers, payload })).json().error.code).toBe("USER_BLOCKED");
    expect(blocked.returns.create).not.toHaveBeenCalled(); await blocked.app.close();
    expect(returns.list).not.toHaveBeenCalled(); expect(returns.detail).not.toHaveBeenCalled();
    await app.close();
  });
  it("validates creation payloads strictly, including duplicate and unknown fields", async () => {
    const { app, returns } = setup();
    const valid = { orderId: id, reason: "Broken item", items: [{ orderItemId: id, quantity: 1 }] };
    for (const payload of [{ ...valid, reason: " " }, { ...valid, reason: "x".repeat(1001) },
      { ...valid, items: [] }, { ...valid, items: [{ orderItemId: id, quantity: 0 }] },
      { ...valid, items: [{ orderItemId: id, quantity: 100 }] },
      { ...valid, items: [{ orderItemId: id, quantity: 1 }, { orderItemId: id, quantity: 1 }] },
      { ...valid, items: [{ orderItemId: "bad", quantity: 1 }] }, { ...valid, actorUserId: id }, { ...valid, note: "x" }])
      expect((await app.inject({ method: "POST", url: "/api/v1/admin/returns", headers, payload })).json().error.code).toBe("VALIDATION_ERROR");
    expect(returns.create).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/returns", headers,
      payload: { ...valid, reason: "x".repeat(1000) } });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(returns.create).toHaveBeenCalledWith(id, expect.objectContaining({ orderId: id, reason: "x".repeat(1000) }), expect.any(String));
    await app.close();
  });
  it("maps stable errors with correct statuses and requires valid identifiers", async () => {
    const { app, returns } = setup();
    for (const [code, status] of [["NOT_FOUND", 404], ["VALIDATION_ERROR", 400], ["RETURN_NOT_ALLOWED", 409], ["RETURN_QUANTITY_EXCEEDED", 409]] as const) {
      returns.create.mockRejectedValue(new ReturnError(code));
      const failed = await app.inject({ method: "POST", url: "/api/v1/admin/returns", headers, payload: { orderId: id, reason: "x", items: [{ orderItemId: id, quantity: 1 }] } });
      expect(failed.statusCode).toBe(status); expect(failed.json().error).toMatchObject({ code, details: {}, requestId: expect.any(String) });
      returns.cancel.mockRejectedValue(new ReturnError(code));
      const cancelled = await app.inject({ method: "POST", url: `/api/v1/admin/returns/${id}/cancel`, headers, payload: {} });
      expect(cancelled.statusCode).toBe(status); expect(cancelled.json().error.code).toBe(code);
    }
    expect((await app.inject({ url: "/api/v1/admin/returns/bad", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/returns/bad/cancel", headers, payload: {} })).statusCode).toBe(400);
    for (const query of ["status=bad", "orderId=bad", "page=0", "limit=101"])
      expect((await app.inject({ url: `/api/v1/admin/returns?${query}`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v1/admin/returns?status=OPEN&orderId=" + id, headers })).statusCode).toBe(200);
    expect(returns.list).toHaveBeenCalledWith({ page: 1, limit: 20, status: "OPEN", orderId: id });
    expect(adminReturnCreateRequestSchema.safeParse({ orderId: id, reason: "x".repeat(1000), items: [{ orderItemId: id, quantity: 99 }] }).success).toBe(true);
    expect(adminReturnListQuerySchema.safeParse({ status: "COMPLETED", page: "2" }).success).toBe(true);
    await app.close();
  });
  it("scopes mutations to the authenticated actor and returns no-store", async () => {
    const { app, returns } = setup();
    const response = await app.inject({ method: "POST", url: `/api/v1/admin/returns/${id}/cancel`, headers, payload: {} });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(returns.cancel).toHaveBeenCalledWith(id, id, expect.any(String));
    await app.close();
  });
  it("validates completion, maps errors and passes the authenticated actor and optional note", async () => {
    const { app, returns } = setup();
    const url = `/api/v1/admin/returns/${id}/complete`;
    expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);
    for (const state of [setup(false), setup(true, true)]) {
      expect((await state.app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(403);
      expect(state.returns.complete).not.toHaveBeenCalled(); await state.app.close();
    }
    for (const payload of [{ note: " " }, { note: "x".repeat(1001) }, { note: 42 }, { actorUserId: id }])
      expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/returns/bad/complete", headers, payload: {} })).statusCode).toBe(400);
    expect(returns.complete).not.toHaveBeenCalled();
    for (const payload of [{}, { note: "  Received  " }]) {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json().status).toBe("COMPLETED");
      expect(returns.complete).toHaveBeenLastCalledWith(id, id, expect.any(String), "note" in payload ? "Received" : undefined);
    }
    for (const [code, status] of [["NOT_FOUND", 404], ["RETURN_NOT_ALLOWED", 409], ["RETURN_QUANTITY_EXCEEDED", 409], ["INTERNAL_INVARIANT_VIOLATION", 409]] as const) {
      returns.complete.mockRejectedValue(new ReturnError(code));
      const response = await app.inject({ method: "POST", url, headers, payload: {} });
      expect(response.statusCode).toBe(status); expect(response.json().error.code).toBe(code);
    }
    await app.close();
  });
});
