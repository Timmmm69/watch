import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AuthenticatedSession } from "../auth/session.js";

const partnerId = randomUUID();
const session: AuthenticatedSession = {
  session: { id: "s", userId: randomUUID(), createdAt: new Date(), expiresAt: new Date(Date.now()+3600000), revokedAt: null },
  user: { id: randomUUID(), telegramUserId: "1", firstName: "Partner", lastName: null, username: null, languageCode: null, isAdmin: false, isBlocked: false }
};
const cookie = { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };

describe("Partner earnings route", () => {
  it.each(["ACTIVE", "BLOCKED"] as const)("allows %s Partner read access despite terms reacceptance; scopes and strips PII", async (status) => {
    const list = vi.fn().mockResolvedValue({ currency: "BYN", pendingAmountMinor: 200, availableAmountMinor: -50,
      items: [], total: 0, page: 2, limit: 3, buyerPhone: "private" });
    const app = createApp({ logger: false, checkReadiness: async () => {},
      auth: { store: { loadCurrent: async () => session } as never, csrfSecret: Buffer.alloc(32), appBaseUrl: "https://app.example", adminIds: () => new Set() },
      partner: { loadState: async () => ({ partner: { id: partnerId, status }, partnerTermsReacceptRequired: true }) } as never,
      earnings: { list } });
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/partner/earnings?page=2&limit=3&partnerId=${randomUUID()}`, headers: cookie });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(list).toHaveBeenCalledExactlyOnceWith(partnerId, { page: 2, limit: 3 });
      expect(response.json()).not.toHaveProperty("buyerPhone");
      expect(response.json().availableAmountMinor).toBe(-50);
    } finally { await app.close(); }
  });

  it("requires a session and Partner, and validates pagination without reading finance", async () => {
    const list = vi.fn();
    const app = createApp({ logger: false, checkReadiness: async () => {},
      auth: { store: { loadCurrent: async () => session } as never, csrfSecret: Buffer.alloc(32), appBaseUrl: "https://app.example", adminIds: () => new Set() },
      earnings: { list } });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/partner/earnings" })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url: "/api/v1/partner/earnings", headers: cookie });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("PARTNER_REQUIRED");
      for (const query of ["page=0", "limit=101", "page=abc", "limit=-1"])
        expect((await app.inject({ method: "GET", url: `/api/v1/partner/earnings?${query}`, headers: cookie })).statusCode).toBe(400);
      expect(list).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
