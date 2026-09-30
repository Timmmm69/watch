import { describe, expect, it } from "vitest";
import { normalizeInventorySnapshot } from "./normalize.js";

describe("inventory snapshot normalization", () => {
  it("rejects snapshot versions rather than truncating their identity", () => {
    for (const sourceVersion of ["v".repeat(201), "", 42]) {
      expect(normalizeInventorySnapshot({ fetchedAt: new Date(), sourceVersion, records: [] }).kind).toBe("invalid");
    }
  });

  it("rejects quantities outside PostgreSQL INTEGER range", () => {
    const result = normalizeInventorySnapshot({ fetchedAt: new Date(), records: [{ externalKey: "sku", quantity: 2_147_483_648 }] });
    expect(result).toMatchObject({ kind: "valid", snapshot: { records: [], issues: [{ kind: "INVALID_QUANTITY" }] } });
  });
  it("rejects structurally invalid snapshots", () => {
    expect(normalizeInventorySnapshot(null)).toEqual({ kind: "invalid", reason: "Snapshot must be an object" });
    expect(normalizeInventorySnapshot("records")).toEqual({ kind: "invalid", reason: "Snapshot must be an object" });
    expect(normalizeInventorySnapshot({ records: [] })).toEqual({ kind: "invalid", reason: "Snapshot fetchedAt is required" });
    expect(normalizeInventorySnapshot({ fetchedAt: "2026-09-30T10:00:00.000Z" }))
      .toEqual({ kind: "invalid", reason: "Snapshot records must be an array" });
  });

  it("accepts ISO string and Date fetchedAt values", () => {
    const fromString = normalizeInventorySnapshot({ fetchedAt: "2026-09-30T10:00:00.000Z", records: [] });
    expect(fromString).toMatchObject({ kind: "valid" });
    const fromDate = normalizeInventorySnapshot({ fetchedAt: new Date(), records: [] });
    expect(fromDate).toMatchObject({ kind: "valid" });
  });

  it("normalizes valid records", () => {
    const result = normalizeInventorySnapshot({
      fetchedAt: "2026-09-30T10:00:00.000Z",
      sourceVersion: "v42",
      records: [
        { externalKey: "  sku-1  ", quantity: 7, sourceVersion: "v42", sourceUpdatedAt: "2026-09-30T09:00:00.000Z" }
      ]
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.snapshot.sourceVersion).toBe("v42");
    expect(result.snapshot.issues).toEqual([]);
    expect(result.snapshot.records[0]).toMatchObject({ externalKey: "sku-1", quantity: 7, sourceVersion: "v42" });
    expect(result.snapshot.records[0]?.sourceUpdatedAt).toEqual(new Date("2026-09-30T09:00:00.000Z"));
  });

  it("drops records with invalid keys", () => {
    const result = normalizeInventorySnapshot({
      fetchedAt: new Date(),
      records: [
        { externalKey: "", quantity: 1 },
        { externalKey: "   ", quantity: 1 },
        { externalKey: "a".repeat(201), quantity: 1 },
        { externalKey: 42, quantity: 1 },
        { quantity: 1 },
        { externalKey: "valid-key", quantity: 1 }
      ]
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.snapshot.records.map((record) => record.externalKey)).toEqual(["valid-key"]);
    expect(result.snapshot.issues.filter((issue) => issue.kind === "INVALID_KEY")).toHaveLength(5);
  });

  it("drops records with invalid quantities", () => {
    const result = normalizeInventorySnapshot({
      fetchedAt: new Date(),
      records: [
        { externalKey: "neg", quantity: -1 },
        { externalKey: "float", quantity: 1.5 },
        { externalKey: "string", quantity: "3" },
        { externalKey: "null", quantity: null },
        { externalKey: "ok", quantity: 0 }
      ]
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.snapshot.records.map((record) => record.externalKey)).toEqual(["ok"]);
    expect(result.snapshot.issues.filter((issue) => issue.kind === "INVALID_QUANTITY")).toHaveLength(4);
  });

  it("keeps the first record for duplicate external keys and flags the rest", () => {
    const result = normalizeInventorySnapshot({
      fetchedAt: new Date(),
      records: [
        { externalKey: "dup", quantity: 1 },
        { externalKey: "dup", quantity: 2 },
        { externalKey: "dup", quantity: 3 }
      ]
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.snapshot.records).toEqual([expect.objectContaining({ externalKey: "dup", quantity: 1 })]);
    expect(result.snapshot.issues).toEqual([
      { kind: "DUPLICATE_KEY", index: 1, externalKey: "dup" },
      { kind: "DUPLICATE_KEY", index: 2, externalKey: "dup" }
    ]);
  });

  it("flags over-long or non-string source versions without dropping the record", () => {
    const result = normalizeInventorySnapshot({
      fetchedAt: new Date(),
      records: [
        { externalKey: "long-version", quantity: 1, sourceVersion: "v".repeat(201) },
        { externalKey: "number-version", quantity: 1, sourceVersion: 7 },
        { externalKey: "good-version", quantity: 1, sourceVersion: "v1" }
      ]
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.snapshot.issues.filter((issue) => issue.kind === "INVALID_SOURCE_VERSION")).toHaveLength(2);
    const byKey = new Map(result.snapshot.records.map((record) => [record.externalKey, record.sourceVersion]));
    expect(byKey.get("long-version")).toBeNull();
    expect(byKey.get("number-version")).toBeNull();
    expect(byKey.get("good-version")).toBe("v1");
  });

  it("flags invalid sourceUpdatedAt values without dropping the record", () => {
    const result = normalizeInventorySnapshot({
      fetchedAt: new Date(),
      records: [{ externalKey: "bad-date", quantity: 1, sourceUpdatedAt: "not-a-date" }]
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.snapshot.issues).toEqual([{ kind: "INVALID_SOURCE_UPDATED_AT", index: 0, externalKey: "bad-date" }]);
    expect(result.snapshot.records[0]?.sourceUpdatedAt).toBeNull();
  });
});
