export interface InventoryRecord {
  externalKey: string;
  quantity: number;
  sourceVersion?: string | undefined;
  sourceUpdatedAt?: Date | undefined;
}

export interface InventorySnapshot {
  fetchedAt: Date;
  sourceVersion?: string | undefined;
  records: InventoryRecord[];
}

export interface InventoryProviderCapabilities {
  completeSnapshot: boolean;
  reservationReconciliation: "NONE" | "SOURCE_PROOF";
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs?: number | undefined;
  error?: string | undefined;
}

export type ReservationReconciliationResult =
  | { kind: "KEEP_ACTIVE" }
  | { kind: "PROVEN_CONSUMED" | "PROVEN_RELEASED"; reference: string; reflectedSourceVersion: string };

export interface ReservationReconciliationContext {
  reservationId: string;
  variantId: string;
  quantity: number;
  orderStatus: string;
  currentSourceVersion: string | null;
}

export interface InventoryProvider {
  readonly key: string;
  fetchSnapshot(): Promise<InventorySnapshot>;
  health(): Promise<ProviderHealth>;
  capabilities(): InventoryProviderCapabilities;
  reconcileReservation?(
    reservation: { id: string },
    context: ReservationReconciliationContext
  ): Promise<ReservationReconciliationResult>;
}
