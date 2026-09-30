import { describe, expect, it } from "vitest";
import {
  computeInventoryAvailability,
  DEFAULT_INVENTORY_MAX_AGE_SECONDS,
  variantAvailabilitySql
} from "./availability.js";

const now = new Date("2026-09-30T12:00:00.000Z");
const fresh = new Date(now.getTime() - 10_000);
const stale = new Date(now.getTime() - DEFAULT_INVENTORY_MAX_AGE_SECONDS * 1000 - 1);

describe("inventory freshness classification", () => {
  it("classifies absent or non-OK inventory as UNKNOWN and never sellable", () => {
    for (const sourceStatus of ["UNINITIALIZED", "MISSING", "INVALID", null] as const) {
      expect(computeInventoryAvailability({
        sourceStatus, sourceQuantity: sourceStatus === null ? null : 5,
        lastSuccessfulSyncAt: fresh, activeReservations: 0, safetyBuffer: 0, now
      })).toEqual({ availability: "UNKNOWN", sellable: 0, deficit: false });
    }
  });

  it("classifies OK inventory without a successful sync as STALE", () => {
    expect(computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 5, lastSuccessfulSyncAt: null,
      activeReservations: 0, safetyBuffer: 0, now
    })).toEqual({ availability: "STALE", sellable: 0, deficit: false });
  });

  it("classifies OK inventory older than the max age as STALE and not sellable", () => {
    expect(computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 5, lastSuccessfulSyncAt: stale,
      activeReservations: 0, safetyBuffer: 0, now
    })).toEqual({ availability: "STALE", sellable: 0, deficit: false });
  });

  it("derives sellable from source quantity, active reservations and safety buffer", () => {
    const result = computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 10, lastSuccessfulSyncAt: fresh,
      activeReservations: 3, safetyBuffer: 2, now
    });
    expect(result).toEqual({ availability: "IN_STOCK", sellable: 5, deficit: false });
  });

  it("clamps sellable at zero and reports OUT_OF_STOCK", () => {
    const result = computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 2, lastSuccessfulSyncAt: fresh,
      activeReservations: 3, safetyBuffer: 1, now
    });
    expect(result).toEqual({ availability: "OUT_OF_STOCK", sellable: 0, deficit: true });
  });

  it("flags a fresh deficit and keeps sellable at zero", () => {
    const result = computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 5, lastSuccessfulSyncAt: fresh,
      activeReservations: 4, safetyBuffer: 2, now
    });
    expect(result.deficit).toBe(true);
    expect(result.sellable).toBe(0);
    expect(result.availability).toBe("OUT_OF_STOCK");
  });

  it("does not flag deficits for stale inventory because freshness is already lost", () => {
    const result = computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 1, lastSuccessfulSyncAt: stale,
      activeReservations: 4, safetyBuffer: 2, now
    });
    expect(result).toEqual({ availability: "STALE", sellable: 0, deficit: false });
  });

  it("honors a custom max age", () => {
    const edge = new Date(now.getTime() - 60_000);
    expect(computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 5, lastSuccessfulSyncAt: edge,
      activeReservations: 0, safetyBuffer: 0, maxAgeSeconds: 30, now
    }).availability).toBe("STALE");
    expect(computeInventoryAvailability({
      sourceStatus: "OK", sourceQuantity: 5, lastSuccessfulSyncAt: edge,
      activeReservations: 0, safetyBuffer: 0, maxAgeSeconds: 120, now
    }).availability).toBe("IN_STOCK");
  });
});

describe("availability SQL fragment", () => {
  it("uses the configured max age as a validated integer interval", () => {
    expect(variantAvailabilitySql(600)).toContain("make_interval(secs => 600)");
    expect(variantAvailabilitySql(0)).toContain(`make_interval(secs => ${DEFAULT_INVENTORY_MAX_AGE_SECONDS})`);
    expect(variantAvailabilitySql(-5)).toContain(`make_interval(secs => ${DEFAULT_INVENTORY_MAX_AGE_SECONDS})`);
    expect(variantAvailabilitySql(1.5)).toContain(`make_interval(secs => ${DEFAULT_INVENTORY_MAX_AGE_SECONDS})`);
  });

  it("fails closed to UNKNOWN for any non-OK source status", () => {
    expect(variantAvailabilitySql(600)).toContain("'UNKNOWN'");
    expect(variantAvailabilitySql(600)).toContain("'STALE'");
  });
});
