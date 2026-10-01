import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Pool } from "pg";
import { currentLegalDocuments, type ApiRuntimeConfig } from "@watch/config";
import { checkDatabaseReady } from "@watch/db";
import { initializePlatformCurrency, seedSupplier } from "../catalog/catalog.js";
import { verifyInstalledRelease } from "./readiness.js";
import { verifyS12FinancialData } from "../finance/gate.js";

const types = ["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"] as const;
interface Artifact {
  type: typeof types[number]; id: string; version: string; sha256: string;
  file: string; effectiveAt: string; requiresReacceptance: boolean; content: string;
}

export async function bootstrapRelease(pool: Pool, runtime: ApiRuntimeConfig, manifestFile: string): Promise<void> {
  const root = await realpath(dirname(manifestFile));
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
    supplierName?: unknown; documents?: unknown;
  };
  if (typeof manifest.supplierName !== "string" || !manifest.supplierName.trim() || manifest.supplierName.length > 200
    || !Array.isArray(manifest.documents) || manifest.documents.length !== 3) throw new Error("Invalid reviewed bootstrap manifest");
  const refs = currentLegalDocuments(runtime);
  const artifacts: Artifact[] = [];
  for (const type of types) {
    const matches = manifest.documents.filter((entry) => entry && entry.type === type);
    if (matches.length !== 1) throw new Error(`Manifest requires exactly one ${type}`);
    const doc = matches[0] as Artifact;
    const ref = refs[type];
    if (!ref || doc.id !== ref.id || doc.version !== ref.version || typeof doc.file !== "string" || isAbsolute(doc.file)
      || typeof doc.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(doc.sha256)
      || typeof doc.requiresReacceptance !== "boolean" || typeof doc.effectiveAt !== "string"
      || !Number.isFinite(Date.parse(doc.effectiveAt)) || new Date(doc.effectiveAt) > new Date()) {
      throw new Error(`Reviewed ${type} metadata must match config and be effective`);
    }
    const file = await realpath(resolve(root, doc.file));
    const local = relative(root, file);
    if (local === ".." || local.startsWith("..\\") || local.startsWith("../") || isAbsolute(local)) throw new Error("Legal file escapes manifest directory");
    const content = await readFile(file, "utf8");
    if (!content.trim() || createHash("sha256").update(content).digest("hex") !== doc.sha256) throw new Error(`Reviewed ${type} file hash mismatch`);
    artifacts.push({ ...doc, content });
  }
  // Validate every reviewed input before the first persistent write.
  await checkDatabaseReady(pool);
  await initializePlatformCurrency(pool, runtime.PLATFORM_CURRENCY);
  const supplier = await seedSupplier(pool, manifest.supplierName);
  await pool.query("UPDATE suppliers SET name=$2, updated_at=now() WHERE id=$1 AND status='ACTIVE' AND name IS DISTINCT FROM $2", [supplier.supplierId, manifest.supplierName]);
  for (const doc of artifacts) {
    await pool.query(`INSERT INTO legal_documents
      (id,type,version,sha256,content_markdown,requires_reacceptance,effective_at)
      VALUES ($1,$2::"LegalDocumentType",$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [doc.id, doc.type, doc.version, doc.sha256, doc.content, doc.requiresReacceptance, doc.effectiveAt]);
    const stored = await pool.query<{ requires_reacceptance: boolean; effective_at: Date; sha256: string }>(
      "SELECT requires_reacceptance,effective_at,sha256 FROM legal_documents WHERE id=$1 AND type=$2::\"LegalDocumentType\" AND version=$3",
      [doc.id, doc.type, doc.version]);
    const row = stored.rows[0];
    if (!row || row.sha256 !== doc.sha256 || row.requires_reacceptance !== doc.requiresReacceptance
      || row.effective_at.getTime() !== Date.parse(doc.effectiveAt)) throw new Error(`Immutable ${doc.type} artifact differs from reviewed manifest`);
  }
  await verifyInstalledRelease(pool, runtime);
  await verifyS12FinancialData(pool);
}
