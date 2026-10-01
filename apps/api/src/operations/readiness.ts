import type { Pool } from "pg";
import { currentLegalDocuments, type ApiRuntimeConfig } from "@watch/config";
import { checkDatabaseReady } from "@watch/db";
import { CatalogService } from "../catalog/catalog.js";
import { LegalDocuments } from "../legal/legal.js";

/** Verification only: initialization is an explicit one-shot deployment gate. */
export async function verifyInstalledRelease(pool: Pool, runtime: ApiRuntimeConfig): Promise<void> {
  await checkDatabaseReady(pool);
  await new CatalogService(pool, runtime.PLATFORM_CURRENCY).verifyCurrencyConfigured();
  await new LegalDocuments(pool, currentLegalDocuments(runtime)).verifyCurrentConfigured();
  if (runtime.NODE_ENV === "production") {
    const suppliers = await pool.query("SELECT id FROM suppliers WHERE status='ACTIVE'");
    if (suppliers.rowCount !== 1) throw new Error("Production requires exactly one ACTIVE Supplier; run explicit bootstrap");
  }
}
