import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";
import { CartError } from "./cart.js";

const userId = "00000000-0000-4000-8000-000000000001";
const variantId = "00000000-0000-4000-8000-000000000002";
const secret = Buffer.alloc(32, 7);
const cookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;
const headers = { cookie, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, "session-1") };
const current = { session: { id: "session-1", userId, createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
  user: { id: userId, telegramUserId: "42", firstName: "Buyer", lastName: null, username: null,
    languageCode: null, isAdmin: false, isBlocked: false } };
const empty = { id: userId, currency: "BYN", items: [], totalMinor: 0, canCheckout: false };
function setup(blocked = false) {
  const cart = { read: vi.fn().mockResolvedValue(empty), put: vi.fn().mockResolvedValue(empty),
    remove: vi.fn().mockResolvedValue(empty), clear: vi.fn().mockResolvedValue(empty) };
  const app = createApp({ logger: false, checkReadiness: async () => undefined, cart,
    auth: { store: { loadCurrent: vi.fn().mockResolvedValue({ ...current, user: { ...current.user, isBlocked: blocked } }) } as unknown as SessionStore,
      csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set() } });
  return { app, cart };
}

describe("Cart HTTP contract", () => {
  it("requires a session and returns an uncached projection scoped only to the authenticated Buyer", async () => {
    const { app, cart } = setup();
    expect((await app.inject({ url: "/api/v1/cart" })).statusCode).toBe(401);
    const response = await app.inject({ url: "/api/v1/cart", headers: { cookie } });
    expect(response.json()).toEqual(empty);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(cart.read).toHaveBeenCalledWith(userId);
    await app.close();
  });
  it.each([0, 100, -1, 1.5, "2", null])("rejects invalid quantity %s without mutation", async (quantity) => {
    const { app, cart } = setup();
    const response = await app.inject({ method: "PUT", url: `/api/v1/cart/items/${variantId}`, headers, payload: { quantity } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(cart.put).not.toHaveBeenCalled();
    await app.close();
  });
  it("rejects overrides and invalid IDs; accepts 99 as an absolute quantity", async () => {
    const { app, cart } = setup();
    for (const payload of [{ quantity: 2, buyerUserId: variantId }, { quantity: 2, priceMinor: 1 }]) {
      expect((await app.inject({ method: "PUT", url: `/api/v1/cart/items/${variantId}`, headers, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: "/api/v1/cart/items/not-uuid", headers, payload: { quantity: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/api/v1/cart/items/${variantId}`, headers, payload: { quantity: 99 } })).statusCode).toBe(200);
    expect(cart.put).toHaveBeenCalledExactlyOnceWith(userId, variantId, 99);
    await app.close();
  });
  it.each([
    ["PUT", `/api/v1/cart/items/${variantId}`, "put"],
    ["DELETE", `/api/v1/cart/items/${variantId}`, "remove"],
    ["DELETE", "/api/v1/cart", "clear"]
  ] as const)("enforces CSRF and blocked-user protection for %s %s", async (method, url, action) => {
    const { app, cart } = setup();
    const payload = method === "PUT" ? { quantity: 1 } : undefined;
    expect((await app.inject({ method, url, headers: { cookie }, payload })).statusCode).toBe(403);
    expect(cart[action]).not.toHaveBeenCalled();
    expect((await app.inject({ method, url, headers, payload })).statusCode).toBe(200);
    expect(cart[action]).toHaveBeenCalledOnce();
    const blocked = setup(true);
    expect((await blocked.app.inject({ method, url, headers, payload })).json().error.code).toBe("USER_BLOCKED");
    expect(blocked.cart[action]).not.toHaveBeenCalled();
    await app.close(); await blocked.app.close();
  });
  it.each(["PRODUCT_NOT_ACTIVE", "VARIANT_NOT_ACTIVE", "CART_LINE_LIMIT_EXCEEDED", "OUT_OF_STOCK", "INVENTORY_STALE", "INVENTORY_UNKNOWN"] as const)
    ("returns stable conflict code %s", async (code) => {
      const { app, cart } = setup(); cart.put.mockRejectedValue(new CartError(code));
      const response = await app.inject({ method: "PUT", url: `/api/v1/cart/items/${variantId}`, headers, payload: { quantity: 1 } });
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe(code);
      await app.close();
    });
});
