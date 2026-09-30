import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { type SessionStore } from "../auth/session.js";
import { OrderTransitionError } from "./admin.js";
import { adminOrderListQuerySchema, adminOrderTransitionSchema } from "@watch/contracts";

const id = "00000000-0000-4000-8000-000000000001";
const secret = Buffer.alloc(32,7);
const cookie = `watch_session=${"a".repeat(43)}`;
const headers = { cookie, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret,"session-1") };
function setup(admin = true, blocked = false) {
  const orders = { list: vi.fn().mockResolvedValue({ items: [],total: 0,page: 1,limit: 20 }),
    detail: vi.fn().mockResolvedValue({ id,status: "PLACED" }), transition: vi.fn().mockResolvedValue({ id,status: "CONFIRMED" }),
    reconcileReservation: vi.fn().mockResolvedValue({ id,status: "CONSUMED" }) };
  const current = { session: { id: "session-1",userId: id },user: { id,telegramUserId: "42",isAdmin: admin,isBlocked: blocked } };
  const app = createApp({ logger: false,checkReadiness: async () => undefined,orders,
    auth: { store: { loadCurrent: vi.fn().mockResolvedValue(current) } as unknown as SessionStore,csrfSecret: secret,
      appBaseUrl: "https://app.example",adminIds: () => new Set(admin ? ["42"] : []) } });
  return { app,orders };
}
describe("Admin Order API", () => {
  it("protects and validates manual reconciliation and binds actor/snapshot to the request", async () => {
    const { app,orders } = setup();
    const url = `/api/v1/admin/inventory/reservations/${id}/reconcile`;
    const payload = { target: "CONSUMED",reason: "Shipped stock reflected",expectedInventorySyncRunId: id,confirmSnapshotReflectsOutcome: true };
    expect((await app.inject({ method: "POST",url,payload })).statusCode).toBe(401);
    for (const requestHeaders of [{ cookie },{ ...headers,origin: "https://wrong.example" },{ ...headers,"x-csrf-token": "bad" }])
      expect((await app.inject({ method: "POST",url,headers: requestHeaders,payload })).statusCode).toBe(403);
    for (const instance of [setup(false),setup(true,true)]) {
      expect((await instance.app.inject({ method: "POST",url,headers,payload })).statusCode).toBe(403);
      expect(instance.orders.reconcileReservation).not.toHaveBeenCalled(); await instance.app.close();
    }
    for (const invalid of [{ ...payload,confirmSnapshotReflectsOutcome: false },{ ...payload,confirmSnapshotReflectsOutcome: undefined },
      { ...payload,expectedInventorySyncRunId: undefined },{ ...payload,expectedInventorySyncRunId: "bad" },{ ...payload,target: "ACTIVE" },
      { ...payload,reason: " " },{ ...payload,reason: "x".repeat(1001) },{ ...payload,evidenceReference: "x".repeat(501) },{ ...payload,actorUserId: id }])
      expect((await app.inject({ method: "POST",url,headers,payload: invalid })).json().error.code).toBe("VALIDATION_ERROR");
    expect((await app.inject({ method: "POST",url: url.replace(id,"bad"),headers,payload })).statusCode).toBe(400);
    expect(orders.reconcileReservation).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST",url,headers,payload: { ...payload,reason: "x".repeat(1000),evidenceReference: "x".repeat(500) } });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(orders.reconcileReservation).toHaveBeenCalledWith(id,id,expect.objectContaining({ expectedInventorySyncRunId: id,confirmSnapshotReflectsOutcome: true }),expect.any(String));
    for (const [code,status] of [["INVENTORY_SNAPSHOT_CHANGED",409],["INVALID_ORDER_TRANSITION",409],["NOT_FOUND",404],
      ["INTERNAL_INVARIANT_VIOLATION",500],["DEPENDENCY_UNAVAILABLE",503]] as const) {
      orders.reconcileReservation.mockRejectedValue(new OrderTransitionError(code));
      const failed = await app.inject({ method: "POST",url,headers,payload });
      expect(failed.statusCode).toBe(status); expect(failed.json().error.code).toBe(code);
    }
    await app.close();
  });
  it("protects list/detail PII and mutation with Session/Admin/Origin/CSRF", async () => {
    const { app,orders } = setup();
    for (const url of ["/api/v1/admin/orders",`/api/v1/admin/orders/${id}`]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
      const nonAdmin = setup(false);
      expect((await nonAdmin.app.inject({ url,headers: { cookie } })).statusCode).toBe(403);
      expect(nonAdmin.orders.detail).not.toHaveBeenCalled(); await nonAdmin.app.close();
    }
    for (const requestHeaders of [{ cookie },{ ...headers,origin: "https://wrong.example" },{ ...headers,"x-csrf-token": "wrong" }])
      expect((await app.inject({ method: "POST",url: `/api/v1/admin/orders/${id}/transition`,headers: requestHeaders,payload: { toStatus: "CONFIRMED" } })).statusCode).toBe(403);
    expect(orders.transition).not.toHaveBeenCalled();
    const blocked = setup(true,true);
    expect((await blocked.app.inject({ method: "POST",url: `/api/v1/admin/orders/${id}/transition`,headers,payload: { toStatus: "CONFIRMED" } })).json().error.code).toBe("USER_BLOCKED");
    expect(blocked.orders.transition).not.toHaveBeenCalled(); await blocked.app.close(); await app.close();
  });
  it("validates targets, identifiers, note limits, untrusted fields and queries", async () => {
    const { app,orders } = setup();
    for (const payload of [{ toStatus: "COMPLETED" },{ toStatus: "RETURNED" },{ toStatus: "CONFIRMED",note: "x".repeat(501) },{ toStatus: "CONFIRMED",actorUserId: id }]) {
      const response = await app.inject({ method: "POST",url: `/api/v1/admin/orders/${id}/transition`,headers,payload });
      expect(response.json().error.code).toBe(payload.toStatus === "COMPLETED" ? "SYSTEM_TRANSITION_ONLY" : "VALIDATION_ERROR");
    }
    expect(orders.transition).not.toHaveBeenCalled();
    expect((await app.inject({ url: "/api/v1/admin/orders/bad",headers })).statusCode).toBe(400);
    for (const query of ["status=bad","overdue=1","page=0","partnerId=bad","dateFrom=bad","limit=101"])
      expect((await app.inject({ url: `/api/v1/admin/orders?${query}`,headers })).statusCode).toBe(400);
    expect(adminOrderTransitionSchema.safeParse({ toStatus: "DELIVERED",note: "x".repeat(500) }).success).toBe(true);
    expect(adminOrderListQuerySchema.safeParse({ dateFrom: "2026-10-02T00:00:00Z",dateTo: "2026-10-01T00:00:00Z" }).success).toBe(false);
    await app.close();
  });
  it("scopes mutations to authenticated actor, returns no-store and maps stable errors", async () => {
    const { app,orders } = setup();
    const response = await app.inject({ method: "POST",url: `/api/v1/admin/orders/${id}/transition`,headers,payload: { toStatus: "CONFIRMED" } });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(orders.transition).toHaveBeenCalledWith(id,id,"CONFIRMED",expect.any(String));
    for (const [code,status] of [["NOT_FOUND",404],["INVALID_ORDER_TRANSITION",409],["SYSTEM_TRANSITION_ONLY",409],["INTERNAL_INVARIANT_VIOLATION",500]] as const) {
      orders.transition.mockRejectedValue(new OrderTransitionError(code));
      const failed = await app.inject({ method: "POST",url: `/api/v1/admin/orders/${id}/transition`,headers,payload: { toStatus: "CONFIRMED" } });
      expect(failed.statusCode).toBe(status); expect(failed.json().error).toMatchObject({ code,details: {},requestId: expect.any(String) });
    }
    orders.detail.mockRejectedValue(new OrderTransitionError("NOT_FOUND"));
    expect((await app.inject({ url: `/api/v1/admin/orders/${id}`,headers })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/v1/admin/orders?overdue=false&status=PLACED",headers })).statusCode).toBe(200);
    expect(orders.list).toHaveBeenCalledWith({ page: 1,limit: 20,overdue: false,status: "PLACED" });
    await app.close();
  });
});
