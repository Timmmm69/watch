export type InventorySourceStatus = "UNINITIALIZED" | "OK" | "MISSING" | "INVALID";
export type InventoryAvailability = "IN_STOCK" | "OUT_OF_STOCK" | "STALE" | "UNKNOWN";

export const DEFAULT_INVENTORY_SYNC_INTERVAL_SECONDS = 120;
export const DEFAULT_INVENTORY_MAX_AGE_SECONDS = 600;

export interface InventoryAvailabilityInput {
  sourceStatus: InventorySourceStatus | null;
  sourceQuantity: number | null;
  lastSuccessfulSyncAt: Date | null;
  activeReservations: number;
  safetyBuffer: number;
  maxAgeSeconds?: number | undefined;
  now?: Date | undefined;
}

export interface InventoryAvailabilityResult {
  availability: InventoryAvailability;
  sellable: number;
  deficit: boolean;
}

export function computeInventoryAvailability(input: InventoryAvailabilityInput): InventoryAvailabilityResult {
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_INVENTORY_MAX_AGE_SECONDS;
  const now = input.now ?? new Date();

  const isOk = input.sourceStatus === "OK" && input.sourceQuantity !== null;
  if (!isOk) {
    return { availability: "UNKNOWN", sellable: 0, deficit: false };
  }
  const fresh = input.lastSuccessfulSyncAt !== null &&
    input.lastSuccessfulSyncAt.getTime() >= now.getTime() - maxAgeSeconds * 1000;
  const sourceQuantity = input.sourceQuantity as number;
  const reserved = Math.max(0, input.activeReservations);
  const buffer = Math.max(0, input.safetyBuffer);
  if (!fresh) {
    return { availability: "STALE", sellable: 0, deficit: false };
  }
  const sellable = Math.max(0, sourceQuantity - reserved - buffer);
  const deficit = sourceQuantity < reserved + buffer;
  return {
    availability: sellable > 0 ? "IN_STOCK" : "OUT_OF_STOCK",
    sellable,
    deficit
  };
}

export function variantAvailabilitySql(maxAgeSeconds: number = DEFAULT_INVENTORY_MAX_AGE_SECONDS): string {
  const maxAge = Number.isInteger(maxAgeSeconds) && maxAgeSeconds > 0 ? maxAgeSeconds : DEFAULT_INVENTORY_MAX_AGE_SECONDS;
  return `CASE
  WHEN i.source_status IS DISTINCT FROM 'OK' OR i.source_quantity IS NULL THEN 'UNKNOWN'
  WHEN i.last_successful_sync_at IS NULL OR i.last_successful_sync_at < now() - make_interval(secs => ${maxAge}) THEN 'STALE'
  WHEN i.source_quantity > i.safety_buffer THEN 'IN_STOCK'
  ELSE 'OUT_OF_STOCK' END`;
}
