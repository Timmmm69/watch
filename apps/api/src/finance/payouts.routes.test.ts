import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import type { AuthenticatedSession } from "../auth/session.js";
import { PayoutError } from "./payouts.js";

const actor = randomUUID(), partnerId = randomUUID(), csrfSecret = Buffer.alloc(32);
const session: AuthenticatedSession = {
  session: { id: "session",userId: actor,createdAt: new Date(),expiresAt: new Date(Date.now()+3600000),revokedAt: null },
  user: { id: actor,telegramUserId: "1",firstName: "Partner",lastName: null,username: null,languageCode: null,isAdmin: false,isBlocked: false }
};
const payout = { id: randomUUID(),partnerId,amountMinor: 5000,currency: "BYN",status: "REQUESTED",
  requestedByUserId: actor,requestedAt: new Date().toISOString(),allocations: [{ id: randomUUID(),commissionId: randomUUID(),amountMinor: 5000 }] };
const headers = { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",origin: "https://app.example",
  "x-csrf-token": deriveCsrfToken(csrfSecret,"session"),"idempotency-key": "key" };
function setup(admin = false, blocked = false) {
  const request = vi.fn().mockResolvedValue({ payout: { ...payout,destination: "private" },created: true });
  const requestSettlement = vi.fn().mockResolvedValue({ payout,created: true });
  const app = createApp({ logger: false,checkReadiness: async () => {},
    auth: { store: { loadCurrent: async () => ({ ...session,user: { ...session.user,isAdmin: admin,isBlocked: blocked } }) } as never,
      csrfSecret,appBaseUrl: "https://app.example",adminIds: () => new Set(["1"]) }, payouts: { request,requestSettlement } });
  return { app,request,requestSettlement };
}
describe("T33 payout routes", () => {
  it("returns 201 for creation, 200 for retry; server-scoped actor and safe response", async () => {
    const { app,request } = setup();
    try {
      const result = await app.inject({ method: "POST",url: "/api/v1/partner/payouts",headers,payload: {} });
      expect(result.statusCode).toBe(201);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toEqual(payout);
      expect(request).toHaveBeenCalledExactlyOnceWith(actor,"key",{});
      request.mockResolvedValue({ payout,created: false });
      expect((await app.inject({ method: "POST",url: "/api/v1/partner/payouts",headers })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it("rejects missing Session, global block, Origin/CSRF failures and arbitrary client fields", async () => {
    const { app,request } = setup();
    try {
      expect((await app.inject({ method: "POST",url: "/api/v1/partner/payouts",payload: {} })).statusCode).toBe(401);
      for (const altered of [{ ...headers,origin: "https://evil.example" },{ ...headers,"x-csrf-token": "invalid" }])
        expect((await app.inject({ method: "POST",url: "/api/v1/partner/payouts",headers: altered,payload: {} })).statusCode).toBe(403);
      for (const payload of [{ amountMinor: 1 },{ partnerId },{ card: "private" },{ currency: "USD" },[],null])
        expect((await app.inject({ method: "POST",url: "/api/v1/partner/payouts",headers: { ...headers,"content-type": "application/json" },payload: JSON.stringify(payload) })).statusCode).toBe(400);
      for (const key of ["", " ","x".repeat(101)])
        expect((await app.inject({ method: "POST",url: "/api/v1/partner/payouts",headers: { ...headers,"idempotency-key": key },payload: {} })).statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally { await app.close(); }
    const blocked = setup(false,true);
    try { expect((await blocked.app.inject({ method: "POST",url: "/api/v1/partner/payouts",headers,payload: {} })).statusCode).toBe(403); }
    finally { await blocked.app.close(); }
  });
  it.each([["PARTNER_REQUIRED",403],["PARTNER_BLOCKED",403],["TERMS_REACCEPT_REQUIRED",403],
    ["PAYOUT_CONFIGURATION_MISSING",409],["PAYOUT_NOT_AVAILABLE",409],["PAYOUT_BELOW_MINIMUM",409],
    ["PAYOUT_ALREADY_PENDING",409],["IDEMPOTENCY_CONFLICT",409],["RATE_LIMITED",429],["INTERNAL_INVARIANT_VIOLATION",500]])("maps %s to %i", async (code,status) => {
    const { app,request } = setup();
    request.mockRejectedValue(new PayoutError(code as string));
    try {
      const result = await app.inject({ method: "POST",url: "/api/v1/partner/payouts",headers,payload: {} });
      expect(result.statusCode).toBe(status);
      expect(result.json().error.code).toBe(code);
    } finally { await app.close(); }
  });
  it("requires Admin for settlement, forwards target and audit request ID, validates UUID", async () => {
    const url = `/api/v1/admin/partners/${partnerId}/payouts`;
    const normal = setup();
    try {
      expect((await normal.app.inject({ method: "POST",url,headers,payload: {} })).statusCode).toBe(403);
      expect(normal.requestSettlement).not.toHaveBeenCalled();
    } finally { await normal.app.close(); }
    const { app,requestSettlement } = setup(true);
    try {
      const result = await app.inject({ method: "POST",url,headers,payload: {} });
      expect(result.statusCode).toBe(201);
      expect(requestSettlement).toHaveBeenCalledExactlyOnceWith(actor,partnerId,"key",{},expect.any(String));
      expect((await app.inject({ method: "POST",url: "/api/v1/admin/partners/bad/payouts",headers,payload: {} })).statusCode).toBe(400);
      // T34 terminal processing/history/UI is deliberately absent.
      expect((await app.inject({ method: "POST",url: `/api/v1/admin/payouts/${payout.id}/process`,headers,payload: { status: "PAID" } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
