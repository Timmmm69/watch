import { describe, expect, it } from "vitest";
import { FakeInventoryProvider } from "./fake.js";
import { normalizeInventorySnapshot } from "./normalize.js";

describe("FakeInventoryProvider", () => {
  it("returns a deterministic complete snapshot of its configured records", async () => {
    const provider = new FakeInventoryProvider([
      { externalKey: "sku-1", quantity: 5 },
      { externalKey: "sku-2", quantity: 0, sourceVersion: "r2" }
    ], { sourceVersion: "source-version-1" });

    const first = await provider.fetchSnapshot();
    const second = await provider.fetchSnapshot();
    expect(first.records).toEqual(second.records);
    expect(first.sourceVersion).toBe("source-version-1");
    expect(first.fetchedAt).toBeInstanceOf(Date);

    const normalized = normalizeInventorySnapshot(first);
    expect(normalized.kind).toBe("valid");
    if (normalized.kind !== "valid") return;
    expect(normalized.snapshot.issues).toEqual([]);
    expect(normalized.snapshot.records).toEqual([
      expect.objectContaining({ externalKey: "sku-1", quantity: 5, sourceVersion: null }),
      expect.objectContaining({ externalKey: "sku-2", quantity: 0, sourceVersion: "r2" })
    ]);
  });

  it("does not let callers mutate provider state through returned snapshots", async () => {
    const provider = new FakeInventoryProvider([{ externalKey: "sku-1", quantity: 5 }]);
    const snapshot = await provider.fetchSnapshot();
    snapshot.records[0]!.quantity = 999;
    const again = await provider.fetchSnapshot();
    expect(again.records[0]?.quantity).toBe(5);
  });

  it("reports health and complete-snapshot capabilities without reconciliation", async () => {
    const provider = new FakeInventoryProvider([], { latencyMs: 3 });
    expect(await provider.health()).toEqual({ ok: true, latencyMs: 3 });
    expect(provider.capabilities()).toEqual({ completeSnapshot: true, reservationReconciliation: "NONE" });
    expect(provider.key).toBe("fake");
  });

  it("supports an empty complete snapshot", async () => {
    const provider = new FakeInventoryProvider();
    const snapshot = await provider.fetchSnapshot();
    expect(snapshot.records).toEqual([]);
  });
});
