import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { installSecurityRateLimits, SECURITY_RATE_LIMITS } from "./rate-limits.js";

describe("security rate limits", () => {
  it.each([
    ["auth", "/api/v1/auth/telegram"], ["order", "/api/v1/orders"],
    ["payout", "/api/v1/partner/payouts"], ["referral", "/api/v1/partner/referral-links"],
    ["admin", "/api/v1/admin/products"]
  ] as const)("enforces %s limits, isolates actors and resets expired windows", async (policy, url) => {
    let time = 0;
    const app = Fastify();
    installSecurityRateLimits(app, () => time);
    app.post(url, { preHandler: async (request, reply) => {
      if (request.headers["x-denied"]) return reply.code(403).send({});
      Object.assign(request, { auth: { user: { id: request.headers["x-user"] ?? "user-1" } } });
    } }, async () => ({ ok: true }));
    const inject = (headers = {}, remoteAddress = "203.0.113.1") => app.inject({ method: "POST", url, headers, remoteAddress });
    expect((await inject({ "x-denied": "yes" })).statusCode).toBe(403);
    for (let i = 0; i < SECURITY_RATE_LIMITS[policy].max; i++) expect((await inject()).statusCode).toBe(200);
    const blocked = await inject();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBe(SECURITY_RATE_LIMITS[policy].windowMs / 1000);
    expect((await inject({ "x-user": "user-2" }, "203.0.113.2")).statusCode).toBe(200);
    time = SECURITY_RATE_LIMITS[policy].windowMs;
    expect((await inject()).statusCode).toBe(200);
    await app.close();
  });

  it("shares the Admin mutation budget across routes while leaving reads unlimited", async () => {
    const app = Fastify();
    installSecurityRateLimits(app);
    app.addHook("preHandler", async (request) => { Object.assign(request, { auth: { user: { id: "admin-1" } } }); });
    app.post("/api/v1/admin/products", async () => ({}));
    app.patch("/api/v1/admin/categories/:id", async () => ({}));
    app.get("/api/v1/admin/products", async () => ({}));
    for (let i = 0; i < 120; i++) await app.inject({ method: "POST", url: "/api/v1/admin/products" });
    expect((await app.inject({ method: "PATCH", url: "/api/v1/admin/categories/1" })).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/products" })).statusCode).toBe(200);
    await app.close();
  });
});
