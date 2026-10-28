import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { CatalogService, type PartnerViewContext } from "./catalog.js";

describe("native shop buyer prices", () => {
  it.each([false, true])("serves retail prices to buyers and D only to partners (partner=%s)", async (isPartner) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM products")) return { rows: [{ id: "product", title: "Watch", slug: "watch", description: "", brand: null }] };
      if (sql.includes("SELECT COUNT(*)")) return { rows: [{ count: 1 }] };
      if (sql.includes("SELECT p.id")) return { rows: [{ id: "product", title: "Watch", slug: "watch", description: "", brand: null,
        price_from_minor: sql.includes("min(v.dropship_price_minor)") ? 10000 : 20000, price_to_minor: 20000, availability: "IN_STOCK" }] };
      if (sql.includes("SELECT v.*")) return { rows: [{ id: "variant", sku: "WATCH", attributes: {},
        price_minor: sql.includes("v.dropship_price_minor AS price_minor") ? 10000 : 20000,
        dropship_price_minor: 10000, sellable: 5, currency: "BYN", availability: "IN_STOCK" }] };
      return { rows: [] };
    });
    const service = new CatalogService({ query } as unknown as Pool, "BYN", undefined, undefined, undefined, true);
    const ctx: PartnerViewContext = { partner: isPartner ? { id: "partner", status: "ACTIVE" } : null,
      userBlocked: false, partnerTermsReacceptRequired: false };
    const list = await service.listStorefrontProducts({ page: 1, limit: 20 }, ctx);
    const detail = await service.getStorefrontProduct("watch", ctx);
    expect(list.items[0]?.priceFromMinor).toBe(isPartner ? 10000 : 20000);
    expect(detail.variants[0]?.priceMinor).toBe(isPartner ? 10000 : 20000);
    if (isPartner) expect(detail.variants[0]).toHaveProperty("dropshipPriceMinor", 10000);
    else {
      expect(detail.variants[0]).not.toHaveProperty("dropshipPriceMinor");
      expect(detail).not.toHaveProperty("partnerView");
      expect(query.mock.calls.some(([sql]) => sql.includes("purpose = 'PARTNER_CONTENT'"))).toBe(false);
    }
  });
});
