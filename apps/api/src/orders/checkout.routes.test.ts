import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";
import { CheckoutError } from "./checkout.js";

const userId = "00000000-0000-4000-8000-000000000001";
const secret = Buffer.alloc(32, 7);
const cookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;
const headers = { cookie, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, "session-1"), "idempotency-key": "order-1" };
const current = { session: { id: "session-1", userId, createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
  user: { id: userId, telegramUserId: "42", firstName: "Buyer", lastName: null, username: null,
    languageCode: null, isAdmin: false, isBlocked: false } };
const payload = { items: [{ variantId: userId, quantity: 1, expectedUnitPriceMinor: 1000 }], recipientName: "Buyer Name",
  phone: "+375 (29) 123-45-67", address: "Minsk, address", salesTermsDocumentId: userId, privacyDocumentId: userId,
  salesTermsAccepted: true, privacyAcknowledged: true };
const order = { id: userId, publicNumber: "W-0123456789AB", status: "PLACED", currency: "BYN", subtotalMinor: 1000, totalMinor: 1000,
  salesTermsDocumentId: userId, privacyDocumentId: userId, salesTermsAcceptedAt: new Date().toISOString(),
  privacyAcknowledgedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
function setup(blocked = false) {
  const checkout = { checkout: vi.fn().mockResolvedValue({ order, created: true }) };
  const app = createApp({ logger: false, checkReadiness: async () => undefined, checkout,
    auth: { store: { loadCurrent: vi.fn().mockResolvedValue({ ...current, user: { ...current.user, isBlocked: blocked } }) } as unknown as SessionStore,
      csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set() } });
  return { app, checkout };
}
describe("Checkout HTTP contract", () => {
  it("requires auth, exact Origin, CSRF and a non-blocked User before calling checkout", async () => {
    const { app, checkout } = setup();
    for (const [requestHeaders, status] of [[{}, 401], [{ cookie }, 403], [{ ...headers, origin: "https://other.example" }, 403]] as const) {
      expect((await app.inject({ method: "POST", url: "/api/v1/orders", headers: requestHeaders, payload })).statusCode).toBe(status);
    }
    expect(checkout.checkout).not.toHaveBeenCalled();
    const blocked = setup(true);
    expect((await blocked.app.inject({ method: "POST", url: "/api/v1/orders", headers, payload })).json().error.code).toBe("USER_BLOCKED");
    expect(blocked.checkout.checkout).not.toHaveBeenCalled();
    await app.close(); await blocked.app.close();
  });
  it("returns 201/200 for create/replay and scopes the normalized input to the authenticated Buyer", async () => {
    const { app, checkout } = setup();
    const response = await app.inject({ method: "POST", url: "/api/v1/orders", headers, payload });
    expect(response.statusCode).toBe(201); expect(response.json()).toEqual(order);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(checkout.checkout).toHaveBeenCalledExactlyOnceWith(userId, "order-1", { ...payload, phone: "375291234567", comment: "" });
    checkout.checkout.mockResolvedValue({ order, created: false });
    expect((await app.inject({ method: "POST", url: "/api/v1/orders", headers, payload })).statusCode).toBe(200);
    await app.close();
  });
  it("requires a 1..100 char Idempotency-Key and rejects invalid/untrusted request data", async () => {
    const { app, checkout } = setup();
    for (const key of [undefined, "", " ", "x".repeat(101)]) {
      const { "idempotency-key": _, ...other } = headers;
      expect((await app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...other, ...(key === undefined ? {} : { "idempotency-key": key }) }, payload })).statusCode).toBe(400);
    }
    for (const change of [{ salesTermsAccepted: false }, { privacyAcknowledged: false }, { buyerUserId: userId }, { currency: "USD" },
      { items: [payload.items[0], payload.items[0]] }]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/orders", headers, payload: { ...payload, ...change } })).statusCode).toBe(400);
    }
    expect(checkout.checkout).not.toHaveBeenCalled(); await app.close();
  });
  it.each(["CART_EMPTY", "CART_CHANGED", "CART_LINE_LIMIT_EXCEEDED", "ORDER_TOTAL_LIMIT_EXCEEDED", "PRICE_CHANGED",
    "OUT_OF_STOCK", "INVENTORY_STALE", "INVENTORY_UNKNOWN", "TERMS_VERSION_CHANGED", "IDEMPOTENCY_CONFLICT"] as const)
    ("returns stable 409 for %s with safe details", async (code) => {
      const { app, checkout } = setup();
      const details = code === "CART_CHANGED" ? { reason: "ITEM_UNAVAILABLE", affectedVariantIds: [userId] } : {};
      checkout.checkout.mockRejectedValue(new CheckoutError(code, details));
      const response = await app.inject({ method: "POST", url: "/api/v1/orders", headers, payload });
      expect(response.statusCode).toBe(409); expect(response.json().error).toMatchObject({ code, details });
      expect(response.json().error.requestId).toBeTypeOf("string"); await app.close();
    });
});
