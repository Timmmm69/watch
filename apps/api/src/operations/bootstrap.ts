import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Pool } from "pg";
import { assertApprovedLegalArtifact, currentLegalDocuments, type ApiRuntimeConfig } from "@watch/config";
import { checkDatabaseReady } from "@watch/db";
import { initializePlatformCurrency, seedSupplier } from "../catalog/catalog.js";
import { verifyInstalledRelease } from "./readiness.js";
import { verifyS12FinancialData } from "../finance/gate.js";
import { assertInventoryMode } from "../inventory/native.js";

const types = ["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"] as const;
interface Artifact {
  type: typeof types[number]; id: string; version: string; sha256: string;
  file: string; effectiveAt: string; requiresReacceptance: boolean; content: string;
}

/** Explicit host-operator provisioning for the first import, before API readiness.
 * This creates neither a Session nor legal acceptance; Telegram authentication remains mandatory.
 */
export async function provisionBootstrapAdmin(pool: Pool, runtime: ApiRuntimeConfig,
  telegramId: string, firstName: string, reference: string): Promise<string> {
  if (!runtime.ADMIN_TELEGRAM_IDS.includes(telegramId) || !firstName.trim() || firstName.length > 100
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{2,199}$/.test(reference)) throw new Error("Configured Admin ID, actual first name and safe provisioning reference required");
  await verifyInstalledRelease(pool, runtime, false);
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`bootstrap-admin:${telegramId}`]);
    const existing=(await client.query("SELECT id,is_admin,is_blocked FROM users WHERE telegram_user_id=$1 FOR UPDATE",[telegramId])).rows[0];
    if(existing?.is_blocked) throw new Error("Blocked Admin cannot be provisioned");
    const id=existing?.id ?? randomUUID();
    if(!existing?.is_admin) {
      if(existing) await client.query("UPDATE users SET is_admin=true WHERE id=$1",[id]);
      else await client.query("INSERT INTO users(id,telegram_user_id,first_name,is_admin) VALUES($1,$2,$3,true)",[id,telegramId,firstName.trim()]);
      await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2::uuid,'BOOTSTRAP_ADMIN_PROVISIONED','User',$2::uuid::text,$3)`,[randomUUID(),id,JSON.stringify({reference})]);
    }
    await client.query("COMMIT"); return id as string;
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally {client.release();}
}

export async function bootstrapRelease(pool: Pool, runtime: ApiRuntimeConfig, manifestFile: string): Promise<void> {
  const root = await realpath(dirname(manifestFile));
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
    supplierName?: unknown; documents?: unknown;
  };
  if (typeof manifest.supplierName !== "string" || !manifest.supplierName.trim() || manifest.supplierName.length > 200
    || !Array.isArray(manifest.documents) || manifest.documents.length !== 3) throw new Error("Invalid reviewed bootstrap manifest");
  const refs = currentLegalDocuments(runtime);
  if (runtime.NODE_ENV === "production") {
    const policy = runtime.productionApproval?.pii;
    if (!policy) throw new Error("Production requires an approved fulfilment PII policy");
    const file = await realpath(resolve(root, policy.policyFile));
    const local = relative(root, file);
    if (local === ".." || local.startsWith("..\\") || local.startsWith("../") || isAbsolute(local)) throw new Error("PII policy escapes manifest directory");
    const content = await readFile(file, "utf8");
    if (!content.trim() || createHash("sha256").update(content).digest("hex") !== policy.policySha256) throw new Error("Approved PII policy hash mismatch");
  }
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
    if (runtime.NODE_ENV === "production") assertApprovedLegalArtifact(runtime.productionApproval, type, { ...doc, content });
    artifacts.push({ ...doc, content });
  }
  // Validate every reviewed input before the first persistent write.
  await checkDatabaseReady(pool);
  // Bootstrap legal/currency prerequisites before the explicit opening-stock import.
  // Runtime readiness still requires the selected native authority.
  await assertInventoryMode(pool, runtime.INVENTORY_PROVIDER, false);
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
  await verifyInstalledRelease(pool, runtime, false);
  await verifyS12FinancialData(pool);
}
