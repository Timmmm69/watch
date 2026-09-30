import { describe, expect, it } from "vitest";
import { checkoutFingerprint, normalizeCheckout } from "./checkout.js";

export const request = {
  items: [{ variantId: "00000000-0000-4000-8000-00000000000a", quantity: 1, expectedUnitPriceMinor: 1000 }],
  recipientName: "Buyer Name", phone: "+375 (29) 123-45-67", address: "Minsk, address",
  salesTermsDocumentId: "00000000-0000-4000-8000-000000000003",
  privacyDocumentId: "00000000-0000-4000-8000-000000000004", salesTermsAccepted: true, privacyAcknowledged: true
};
describe("Checkout canonical request", () => {
  it("canonicalizes property/line order, UUID case, contact whitespace, phone and omitted comment", () => {
    const items = [...request.items, { ...request.items[0]!, variantId: "00000000-0000-4000-8000-00000000000b" }];
    const first = normalizeCheckout({ ...request, items });
    const second = normalizeCheckout({ ...request, items: items.reverse().map((item) => ({
      expectedUnitPriceMinor: item.expectedUnitPriceMinor, quantity: item.quantity, variantId: item.variantId.toUpperCase() })),
    recipientName: " Buyer Name ", address: " Minsk, address ", phone: "375291234567", comment: "  " });
    expect(checkoutFingerprint(first)).toBe(checkoutFingerprint(second));
    expect(first.phone).toBe("375291234567");
    expect(checkoutFingerprint(first)).not.toBe(checkoutFingerprint({ ...first, address: "Other address" }));
  });
  it.each([
    { salesTermsAccepted: false }, { privacyAcknowledged: false }, { salesTermsAccepted: "true" },
    { phone: "abcdefgh" }, { phone: "1234567" }, { recipientName: "x" }, { address: "x" },
    { comment: "x".repeat(501) }, { currency: "USD" }, { buyerUserId: request.salesTermsDocumentId },
    { items: [] }, { items: [request.items[0], request.items[0]] },
    { items: [{ ...request.items[0], quantity: 100 }] },
    { items: [{ ...request.items[0], expectedUnitPriceMinor: -1 }] }
  ])("rejects malformed or untrusted fields: %j", (change) => {
    expect(() => normalizeCheckout({ ...request, ...change })).toThrow("VALIDATION_ERROR");
  });
});
