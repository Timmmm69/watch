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
  processedByAdminUserId: null, processedAt: null, externalReference: null, note: null,
  requestedByUserId: actor,requestedAt: new Date().toISOString(),allocations: [{ id: randomUUID(),commissionId: randomUUID(),amountMinor: 5000 }] };
const headers = { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",origin: "https://app.example",
  "x-csrf-token": deriveCsrfToken(csrfSecret,"session"),"idempotency-key": "key" };
function setup(admin = false, blocked = false) {
  const request = vi.fn().mockResolvedValue({ payout: { ...payout,destination: "private" },created: true });
  const requestSettlement = vi.fn().mockResolvedValue({ payout,created: true });
  const listOwn = vi.fn().mockResolvedValue({ items: [payout],total: 1,page: 1,limit: 20 });
  const listAdmin = vi.fn().mockResolvedValue({ items: [payout],total: 1,page: 1,limit: 20 });
  const detail = vi.fn().mockResolvedValue(payout);
  const transition = vi.fn().mockResolvedValue({ ...payout,status: "PAID",externalReference: "transfer-1" });
  const app = createApp({ logger: false,checkReadiness: async () => {},
    auth: { store: { loadCurrent: async () => ({ ...session,user: { ...session.user,isAdmin: admin,isBlocked: blocked } }) } as never,
      csrfSecret,appBaseUrl: "https://app.example",adminIds: () => new Set(["1"]) }, payouts: { request,requestSettlement,listOwn,listAdmin,detail,transition } });
  return { app,request,requestSettlement,listOwn,listAdmin,detail,transition };
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
      // Only the specified transition endpoint is exposed.
      expect((await app.inject({ method: "POST",url: `/api/v1/admin/payouts/${payout.id}/process`,headers,payload: { status: "PAID" } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe("T34 payout routes", () => {
  it("scopes Partner history to authenticated user and rejects injected ownership/filter inputs", async () => {
    const { app,listOwn } = setup();
    try {
      const result = await app.inject({ url: "/api/v1/partner/payouts?status=PAID&page=2&limit=3",headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(listOwn).toHaveBeenCalledExactlyOnceWith(actor,{ status: "PAID",page: 2,limit: 3 });
      for (const query of [`partnerId=${partnerId}`,"status=unknown","limit=101","page=0"])
        expect((await app.inject({ url: `/api/v1/partner/payouts?${query}`,headers })).statusCode).toBe(400);
      expect((await app.inject({ url: "/api/v1/partner/payouts" })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("protects Admin reads/processing and requires CSRF and a completed-transfer reference", async () => {
    const url = `/api/v1/admin/payouts/${payout.id}`;
    const ordinary = setup();
    try {
      for (const path of ["/api/v1/admin/payouts",url]) expect((await ordinary.app.inject({ url: path,headers })).statusCode).toBe(403);
      expect((await ordinary.app.inject({ method: "POST",url: `${url}/transition`,headers,payload: { target: "REJECTED" } })).statusCode).toBe(403);
      expect(ordinary.transition).not.toHaveBeenCalled();
    } finally { await ordinary.app.close(); }
    const { app,listAdmin,detail,transition } = setup(true);
    try {
      expect((await app.inject({ url: `/api/v1/admin/payouts?partnerId=${partnerId}&status=REQUESTED`,headers })).statusCode).toBe(200);
      expect(listAdmin).toHaveBeenCalledExactlyOnceWith({ partnerId,status: "REQUESTED",page: 1,limit: 20 });
      expect((await app.inject({ url,headers })).statusCode).toBe(200);
      expect(detail).toHaveBeenCalledExactlyOnceWith(payout.id);
      for (const payload of [{ target: "PAID" },{ target: "PAID",externalReference: " " },{ target: "REQUESTED" },{ target: "REJECTED",amountMinor: 1 }])
        expect((await app.inject({ method: "POST",url: `${url}/transition`,headers,payload })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST",url: `${url}/transition`,headers: { ...headers,"x-csrf-token": "bad" },payload: { target: "REJECTED" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST",url: `${url}/transition`,headers,payload: { target: "PAID",externalReference: " transfer-1 " } })).statusCode).toBe(200);
      expect(transition).toHaveBeenCalledExactlyOnceWith(actor,payout.id,{ target: "PAID",externalReference: "transfer-1" },expect.any(String));
      transition.mockRejectedValue(new PayoutError("PAYOUT_ALREADY_FINALIZED"));
      expect((await app.inject({ method: "POST",url: `${url}/transition`,headers,payload: { target: "REJECTED" } })).statusCode).toBe(409);
      detail.mockRejectedValue(new PayoutError("NOT_FOUND"));
      expect((await app.inject({ url,headers })).statusCode).toBe(404);
      expect((await app.inject({ url: "/api/v1/admin/payouts/bad",headers })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
