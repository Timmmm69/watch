import { describe, expect, it } from "vitest";
import {
  canTransitionProductStatus,
  canTransitionVariantStatus,
  generateSlug,
  normalizeSlug,
  settlementWithinPrice
} from "./catalog.js";

describe("slug normalization", () => {
  it("normalizes provided slugs", () => {
    expect(normalizeSlug("  Premium--Watches!  ", 140)).toBe("premium-watches");
    expect(normalizeSlug("Rolex Submariner 2026", 140)).toBe("rolex-submariner-2026");
    expect(normalizeSlug("----", 140)).toBe("");
    expect(normalizeSlug("Фыва АБВ", 140)).toBe("");
  });

  it("truncates long slugs to the column limit", () => {
    expect(normalizeSlug("a".repeat(300), 140)).toHaveLength(140);
    expect(normalizeSlug(`${"a".repeat(300)}-`, 140)).toMatch(/^[a-z0-9-]*$/);
  });

  it("generates a prefixed fallback for non-latin sources", () => {
    expect(generateSlug("Фыва", "item", 140)).toMatch(/^item-[0-9a-f]{12}$/);
    expect(generateSlug("Casio", "item", 140)).toBe("casio");
  });
});

describe("catalog status transitions", () => {
  it("allows only the specified Product transitions", () => {
    expect(canTransitionProductStatus("DRAFT", "DRAFT")).toBe(true);
    expect(canTransitionProductStatus("DRAFT", "ACTIVE")).toBe(true);
    expect(canTransitionProductStatus("DRAFT", "ARCHIVED")).toBe(true);
    expect(canTransitionProductStatus("ACTIVE", "ARCHIVED")).toBe(true);
    expect(canTransitionProductStatus("ARCHIVED", "ACTIVE")).toBe(true);
    expect(canTransitionProductStatus("ACTIVE", "DRAFT")).toBe(false);
    expect(canTransitionProductStatus("ARCHIVED", "DRAFT")).toBe(false);
  });

  it("allows only the specified Variant transitions", () => {
    expect(canTransitionVariantStatus("DRAFT", "ACTIVE")).toBe(true);
    expect(canTransitionVariantStatus("DRAFT", "ARCHIVED")).toBe(true);
    expect(canTransitionVariantStatus("ACTIVE", "ARCHIVED")).toBe(true);
    expect(canTransitionVariantStatus("ARCHIVED", "ACTIVE")).toBe(true);
    expect(canTransitionVariantStatus("ACTIVE", "DRAFT")).toBe(false);
    expect(canTransitionVariantStatus("ARCHIVED", "DRAFT")).toBe(false);
  });
});

describe("variant commercial checks", () => {
  it("accepts absent settlement and settlement within price", () => {
    expect(settlementWithinPrice(10_000, 500, null)).toBe(true);
    expect(settlementWithinPrice(10_000, 500, 9_500)).toBe(true);
    expect(settlementWithinPrice(10_000, 500, 9_501)).toBe(false);
    expect(settlementWithinPrice(0, 0, 0)).toBe(true);
  });
});
