import type { InventorySnapshot } from "./provider.js";

export const MAX_EXTERNAL_KEY_LENGTH = 200;
export const MAX_SOURCE_VERSION_LENGTH = 200;

export interface NormalizedInventoryRecord {
  externalKey: string;
  quantity: number;
  sourceVersion: string | null;
  sourceUpdatedAt: Date | null;
}

export interface NormalizedSnapshot {
  fetchedAt: Date;
  sourceVersion: string | null;
  records: NormalizedInventoryRecord[];
  issues: InventorySnapshotIssue[];
}

export type InventorySnapshotIssue =
  | { kind: "INVALID_KEY"; index: number; key: unknown }
  | { kind: "INVALID_QUANTITY"; index: number; externalKey: string; quantity: unknown }
  | { kind: "INVALID_SOURCE_VERSION"; index: number; externalKey: string; sourceVersion: unknown }
  | { kind: "INVALID_SOURCE_UPDATED_AT"; index: number; externalKey: string }
  | { kind: "DUPLICATE_KEY"; index: number; externalKey: string };

export type NormalizeResult =
  | { kind: "valid"; snapshot: NormalizedSnapshot }
  | { kind: "invalid"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function normalizeInventorySnapshot(raw: unknown): NormalizeResult {
  if (!isRecord(raw)) return { kind: "invalid", reason: "Snapshot must be an object" };
  const fetchedAtValue = raw.fetchedAt;
  const fetchedAt = typeof fetchedAtValue === "string" && !Number.isNaN(Date.parse(fetchedAtValue))
    ? new Date(fetchedAtValue)
    : fetchedAtValue instanceof Date && !Number.isNaN(fetchedAtValue.getTime())
      ? fetchedAtValue
      : null;
  if (!fetchedAt) return { kind: "invalid", reason: "Snapshot fetchedAt is required" };
  if (!Array.isArray(raw.records)) return { kind: "invalid", reason: "Snapshot records must be an array" };

  const sourceVersion = typeof raw.sourceVersion === "string" && raw.sourceVersion.length > 0
    ? raw.sourceVersion.slice(0, MAX_SOURCE_VERSION_LENGTH)
    : null;
  const issues: InventorySnapshotIssue[] = [];
  const records: NormalizedInventoryRecord[] = [];
  const seen = new Set<string>();

  raw.records.forEach((record, index) => {
    if (!isRecord(record)) {
      issues.push({ kind: "INVALID_KEY", index, key: null });
      return;
    }
    const keyValue = record.externalKey;
    if (typeof keyValue !== "string" || keyValue.trim().length === 0 || keyValue.length > MAX_EXTERNAL_KEY_LENGTH) {
      issues.push({ kind: "INVALID_KEY", index, key: typeof keyValue === "string" ? keyValue : null });
      return;
    }
    const externalKey = keyValue.trim();
    if (seen.has(externalKey)) {
      issues.push({ kind: "DUPLICATE_KEY", index, externalKey });
      return;
    }

    const quantityValue = record.quantity;
    if (typeof quantityValue !== "number" || !Number.isInteger(quantityValue) || quantityValue < 0) {
      issues.push({ kind: "INVALID_QUANTITY", index, externalKey, quantity: quantityValue ?? null });
      return;
    }

    let recordSourceVersion: string | null = null;
    if (record.sourceVersion !== undefined && record.sourceVersion !== null) {
      if (typeof record.sourceVersion !== "string" || record.sourceVersion.length === 0 ||
          record.sourceVersion.length > MAX_SOURCE_VERSION_LENGTH) {
        issues.push({ kind: "INVALID_SOURCE_VERSION", index, externalKey, sourceVersion: record.sourceVersion });
      } else {
        recordSourceVersion = record.sourceVersion;
      }
    }

    let sourceUpdatedAt: Date | null = null;
    if (record.sourceUpdatedAt !== undefined && record.sourceUpdatedAt !== null) {
      const updated = record.sourceUpdatedAt instanceof Date && !Number.isNaN(record.sourceUpdatedAt.getTime())
        ? record.sourceUpdatedAt
        : isIsoDate(record.sourceUpdatedAt)
          ? new Date(record.sourceUpdatedAt)
          : null;
      if (!updated) {
        issues.push({ kind: "INVALID_SOURCE_UPDATED_AT", index, externalKey });
      } else {
        sourceUpdatedAt = updated;
      }
    }

    seen.add(externalKey);
    records.push({ externalKey, quantity: quantityValue, sourceVersion: recordSourceVersion, sourceUpdatedAt });
  });

  return { kind: "valid", snapshot: { fetchedAt, sourceVersion, records, issues } };
}
