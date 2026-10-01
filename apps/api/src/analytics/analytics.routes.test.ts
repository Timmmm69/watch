import { describe, expect, it, vi } from "vitest";
import { analyticsQuerySchema } from "@watch/contracts";
import { createApp } from "../app.js";
import type { SessionStore } from "../auth/session.js";
import { ratio } from "./analytics.js";

const cookie = `watch_session=${"a".repeat(43)}`;
const period = { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" };
function setup(admin = true, mirror = true, blocked = false) {
  const analytics = { summary: vi.fn().mockResolvedValue({ orders: 0 }), dashboard: vi.fn().mockResolvedValue({ actionable: {} }) };
  const app = createApp({ logger: false, checkReadiness: async () => undefined, analytics,
    auth: { store: { loadCurrent: vi.fn().mockResolvedValue({ session: { id: "session", userId: "user" },
      user: { id: "user", telegramUserId: "42", isAdmin: mirror, isBlocked: blocked } }) } as unknown as SessionStore,
      csrfSecret: Buffer.alloc(32, 7), appBaseUrl: "https://app.example", adminIds: () => new Set(admin ? ["42"] : []) } });
  return { app, analytics };
}
describe("Analytics and operational dashboard API", () => {
  it("enforces Session, runtime membership, persisted Admin mirror and user blocking", async () => {
    for (const url of ["/api/v1/admin/dashboard", `/api/v1/admin/analytics/summary?${new URLSearchParams(period)}`]) {
      const normal = setup();
      expect((await normal.app.inject({ url })).statusCode).toBe(401);
      expect(normal.analytics.summary).not.toHaveBeenCalled();
      expect(normal.analytics.dashboard).not.toHaveBeenCalled();
      await normal.app.close();
      for (const instance of [setup(false), setup(true, false), setup(true, true, true)]) {
        expect((await instance.app.inject({ url, headers: { cookie } })).statusCode).toBe(403);
        expect(instance.analytics.summary).not.toHaveBeenCalled(); expect(instance.analytics.dashboard).not.toHaveBeenCalled();
        await instance.app.close();
      }
    }
  });
  it("requires an ISO half-open range up to 365 days and rejects unknown inputs", async () => {
    const { app, analytics } = setup();
    for (const query of [{}, { ...period, from: "bad" }, { ...period, to: period.from },
      { ...period, to: "2026-08-31T00:00:00Z" }, { ...period, to: "2027-09-02T00:00:00Z" }, { ...period, partnerId: "untrusted" }]) {
      expect((await app.inject({ url: `/api/v1/admin/analytics/summary?${new URLSearchParams(query)}`, headers: { cookie } })).statusCode).toBe(400);
    }
    expect(analytics.summary).not.toHaveBeenCalled();
    const response = await app.inject({ url: `/api/v1/admin/analytics/summary?${new URLSearchParams(period)}`, headers: { cookie } });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(analytics.summary).toHaveBeenCalledWith(period);
    const dashboard = await app.inject({ url: "/api/v1/admin/dashboard", headers: { cookie } });
    expect(dashboard.statusCode).toBe(200); expect(dashboard.headers["cache-control"]).toBe("no-store");
    await app.close();
    expect(analyticsQuerySchema.safeParse({ from: "2026-01-01T00:00:00+03:00", to: "2027-01-01T00:00:00+03:00" }).success).toBe(true);
    expect(ratio(0, 0)).toBeNull(); expect(ratio(2, 1)).toBe(2);
  });
});
