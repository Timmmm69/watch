import type {
  InventoryProvider,
  InventoryProviderCapabilities,
  InventoryRecord,
  InventorySnapshot,
  ProviderHealth
} from "./provider.js";

export interface FakeInventoryProviderOptions {
  sourceVersion?: string | undefined;
  latencyMs?: number | undefined;
}

export class FakeInventoryProvider implements InventoryProvider {
  readonly key = "fake";

  private readonly records: InventoryRecord[];
  private readonly options: FakeInventoryProviderOptions;

  constructor(records: InventoryRecord[] = [], options: FakeInventoryProviderOptions = {}) {
    this.records = records.map((record) => ({ ...record }));
    this.options = options;
  }

  async fetchSnapshot(): Promise<InventorySnapshot> {
    if (this.options.latencyMs !== undefined && this.options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }
    return {
      fetchedAt: new Date(),
      sourceVersion: this.options.sourceVersion,
      records: this.records.map((record) => ({ ...record }))
    };
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, latencyMs: this.options.latencyMs ?? 0 };
  }

  capabilities(): InventoryProviderCapabilities {
    return { completeSnapshot: true, reservationReconciliation: "NONE" };
  }
}
