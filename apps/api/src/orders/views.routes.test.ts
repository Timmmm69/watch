import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AuthenticatedSession } from "../auth/session.js";

const now = new Date().toISOString();
const user = { id: randomUUID(), telegramUserId: "111", firstName: "Buyer", lastName: null, username: null, languageCode: null, isAdmin: false, isBlocked: false };
const session: AuthenticatedSession = {
  session: { id: "s1", userId: user.id, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000), revokedAt: null },
  user
};
const fakeStore = { loadCurrent: async () => session, revoke: async () => undefined };

function app(deps: { orderViews?: object; partner?: object } = {}) {
  return createApp({
    logger: false,
    checkReadiness: async () => undefined,
    auth: { store: fakeStore as never, csrfSecret: Buffer.alloc(32), appBaseUrl: "https://app.example", adminIds: () => new Set() },
    partner: deps.partner as never,
    orderViews: deps.orderViews as never
  });
}

describe("Order view routes", () => {
  it("lists buyer orders", async () => {
    const orderViews = {
      listBuyerOrders: async () => ({
        items: [{
          id: randomUUID(), publicNumber: "W-ABC", status: "PLACED", totalMinor: 1000, currency: "BYN", itemCount: 1, createdAt: now
        }],
        total: 1, page: 1, limit: 20
      })
    };
    const server = await app({ orderViews });
    const response = await server.inject({ method: "GET", url: "/api/v1/orders", headers: { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ publicNumber: "W-ABC", totalMinor: 1000 });
    await server.close();
  });

  it("returns buyer order detail with fulfillment", async () => {
    const orderViews = {
      getBuyerOrder: async () => ({
        id: randomUUID(), publicNumber: "W-ABC", status: "PLACED", currency: "BYN", subtotalMinor: 1000, totalMinor: 1000,
        items: [{ id: randomUUID(), variantId: randomUUID(), sku: "S1", title: "Watch", attributes: {}, quantity: 1, unitPriceMinor: 1000, lineTotalMinor: 1000 }],
        timeline: [{ status: "PLACED" as const, at: now }],
        fulfillment: { recipientName: "Name", phone: "375", address: "Addr", comment: null, redactedAt: null },
        supportContact: "@support", createdAt: now
      })
    };
    const server = await app({ orderViews });
    const response = await server.inject({ method: "GET", url: "/api/v1/orders/W-ABC", headers: { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().fulfillment.phone).toBe("375");
    await server.close();
  });

  it("rejects partner order list without partner account", async () => {
    const orderViews = { listPartnerOrders: async () => ({ items: [], total: 0, page: 1, limit: 20 }) };
    const partner = { loadState: async () => ({ partner: null, partnerTermsReacceptRequired: false }) };
    const server = await app({ orderViews, partner });
    const response = await server.inject({ method: "GET", url: "/api/v1/partner/orders", headers: { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PARTNER_REQUIRED");
    await server.close();
  });

  it("lists partner orders and excludes fulfillment", async () => {
    const orderViews = {
      listPartnerOrders: async () => ({
        items: [{
          id: randomUUID(), publicNumber: "W-ABC", status: "PLACED", totalMinor: 1000, currency: "BYN",
          commissionEligibleSnapshot: true, itemCount: 1, createdAt: now
        }],
        total: 1, page: 1, limit: 20
      }),
      getPartnerOrder: async () => ({
        id: randomUUID(), publicNumber: "W-ABC", status: "PLACED", currency: "BYN", subtotalMinor: 1000, totalMinor: 1000,
        commissionEligibleSnapshot: true,
        items: [{ id: randomUUID(), variantId: randomUUID(), sku: "S1", title: "Watch", attributes: {}, quantity: 1, unitPriceMinor: 1000, lineTotalMinor: 1000, partnerCommissionUnitSnapshotMinor: 100 }],
        timeline: [{ status: "PLACED" as const, at: now }],
        supportContact: "@support", createdAt: now
      })
    };
    const partner = { loadState: async () => ({ partner: { id: "p1", status: "ACTIVE" as const }, partnerTermsReacceptRequired: false }) };
    const server = await app({ orderViews, partner });
    const list = await server.inject({ method: "GET", url: "/api/v1/partner/orders", headers: { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({ commissionEligibleSnapshot: true });
    const detail = await server.inject({ method: "GET", url: "/api/v1/partner/orders/W-ABC", headers: { cookie: "watch_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.items[0].partnerCommissionUnitSnapshotMinor).toBe(100);
    expect(body).not.toHaveProperty("fulfillment");
    await server.close();
  });
});
