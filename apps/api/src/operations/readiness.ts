import type { Pool } from "pg";
import { assertApprovedLegalArtifact, currentLegalDocuments, type ApiRuntimeConfig } from "@watch/config";
import { checkDatabaseReady } from "@watch/db";
import { CatalogService } from "../catalog/catalog.js";
import { LegalDocuments } from "../legal/legal.js";
import { assertInventoryMode } from "../inventory/native.js";

/** Verification only: initialization is an explicit one-shot deployment gate. */
export async function verifyInstalledRelease(pool: Pool, runtime: ApiRuntimeConfig, requireInventoryInitialization = true): Promise<void> {
  await checkDatabaseReady(pool);
  // A private owner can open an empty catalogue before the first real stock import.
  // Uninitialized stock remains UNKNOWN and cannot be sold; cutover checks still run.
  await assertInventoryMode(pool, runtime.INVENTORY_PROVIDER, requireInventoryInitialization && runtime.WATCH_PRIVATE_ACCESS !== "1");
  await new CatalogService(pool, runtime.PLATFORM_CURRENCY).verifyCurrencyConfigured();
  await new LegalDocuments(pool, currentLegalDocuments(runtime)).verifyCurrentConfigured();
  if (runtime.NODE_ENV === "production") {
    if (runtime.WATCH_PRIVATE_ACCESS !== "1") {
      const legal = new LegalDocuments(pool, currentLegalDocuments(runtime));
      for (const type of ["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"] as const) {
        const doc = await legal.getCurrent(type);
        if (!doc) throw new Error("Production legal artifact missing");
        assertApprovedLegalArtifact(runtime.productionApproval, type, { ...doc, content: doc.contentMarkdown });
      }
    }
    const suppliers = await pool.query("SELECT id FROM suppliers WHERE status='ACTIVE'");
    if (suppliers.rowCount !== 1) throw new Error("Production requires exactly one ACTIVE Supplier; run explicit bootstrap");
  }
}
