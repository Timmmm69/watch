import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import type { AuthenticatedSession } from "../auth/session.js";
import { AdminPartnerError } from "./admin.js";

const actor = randomUUID(), id = randomUUID(), csrfSecret = Buffer.alloc(32);
const state = { id,status: "BLOCKED",blockReason: "review",blockedAt: new Date().toISOString() };
const session: AuthenticatedSession = {
  session: { id: "session",userId: actor,createdAt: new Date(),expiresAt: new Date(Date.now()+3600000),revokedAt: null },
  user: { id: actor,telegramUserId: "1",firstName: "Admin",lastName: null,username: null,languageCode: null,isAdmin: true,isBlocked: false }
};
const headers = { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",origin: "https://app.example",
  "x-csrf-token": deriveCsrfToken(csrfSecret,"session") };
function setup({ mirror=true,runtime=true,blocked=false } = {}) {
  const list = vi.fn().mockResolvedValue({ items: [],total: 0,page: 1,limit: 20 });
  const detail = vi.fn().mockRejectedValue(new AdminPartnerError("NOT_FOUND"));
  const setStatus = vi.fn().mockResolvedValue(state);
  const app = createApp({ logger: false,checkReadiness: async () => {},
    auth: { store: { loadCurrent: async () => ({ ...session,user: { ...session.user,isAdmin: mirror,isBlocked: blocked } }) } as never,
      csrfSecret,appBaseUrl: "https://app.example",adminIds: () => new Set(runtime ? ["1"] : []) }, adminPartners: { list,detail,setStatus } });
  return { app,list,detail,setStatus };
}
describe("T41 Admin Partners HTTP authorization and contracts", () => {
  const requests = [{ method: "GET" as const,url: "/api/v1/admin/partners" },
    { method: "GET" as const,url: `/api/v1/admin/partners/${id}` },
    ...["block","unblock"].map(a => ({ method: "POST" as const,url: `/api/v1/admin/partners/${id}/${a}`,payload: { reason: "review" } }))];
  it.each([{ mirror:false },{ runtime:false },{ blocked:true }])("rejects unauthorized Admin predicates %j", async options => {
    const { app,list,detail,setStatus } = setup(options);
    try {
      for (const request of requests) expect((await app.inject({ ...request,headers })).statusCode).toBe(403);
      expect(list).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled(); expect(setStatus).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("requires session on every route, Origin and CSRF for mutations", async () => {
    const { app,setStatus } = setup();
    try {
      for (const request of requests) expect((await app.inject(request)).statusCode).toBe(401);
      for (const action of ["block","unblock"]) for (const changed of [{ ...headers,origin: "https://evil.example" },{ ...headers,"x-csrf-token": "invalid" }])
        expect((await app.inject({ method: "POST",url: `/api/v1/admin/partners/${id}/${action}`,headers: changed,payload: { reason: "review" } })).statusCode).toBe(403);
      expect(setStatus).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("validates filters/pagination and forwards only server-scoped actor", async () => {
    const { app,list,setStatus } = setup();
    try {
      const result = await app.inject({ method: "GET",url: "/api/v1/admin/partners?status=BLOCKED&search=Alice&page=2&limit=5",headers });
      expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
      expect(list).toHaveBeenCalledExactlyOnceWith({ status: "BLOCKED",search: "Alice",page: 2,limit: 5 });
      for (const query of ["status=INVALID","page=0","limit=101","page=100001","search=","balance=42"])
        expect((await app.inject({ method: "GET",url: `/api/v1/admin/partners?${query}`,headers })).statusCode).toBe(400);
      for (const [action,target] of [["block","BLOCKED"],["unblock","ACTIVE"]]) {
        expect((await app.inject({ method: "POST",url: `/api/v1/admin/partners/${id}/${action}`,headers,payload: { reason: " review " } })).json()).toEqual(state);
        expect(setStatus).toHaveBeenLastCalledWith(actor,id,target,"review",expect.any(String));
      }
    } finally { await app.close(); }
  });
  it("rejects invalid identities/reasons/arbitrary fields and maps missing Partner", async () => {
    const { app,setStatus } = setup();
    try {
      expect((await app.inject({ method: "GET",url: `/api/v1/admin/partners/${id}`,headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET",url: "/api/v1/admin/partners/bad",headers })).statusCode).toBe(400);
      for (const action of ["block","unblock"]) {
        for (const payload of [{},{ reason: " " },{ reason: "x".repeat(501) },{ reason: "ok",actorId: actor },{ reason: "ok",status: "ACTIVE" }])
          expect((await app.inject({ method: "POST",url: `/api/v1/admin/partners/${id}/${action}`,headers,payload })).statusCode).toBe(400);
        expect((await app.inject({ method: "POST",url: `/api/v1/admin/partners/bad/${action}`,headers,payload: { reason: "ok" } })).statusCode).toBe(400);
      }
      expect(setStatus).not.toHaveBeenCalled(); setStatus.mockRejectedValue(new AdminPartnerError("NOT_FOUND"));
      expect((await app.inject({ method: "POST",url: `/api/v1/admin/partners/${id}/block`,headers,payload: { reason: "ok" } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
