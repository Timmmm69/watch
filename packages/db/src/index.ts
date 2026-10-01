import { Pool, type PoolConfig } from "pg";

const foundationMigration = "20260930000000_repository_foundation";
const userSessionsMigration = "20260930010000_user_sessions";
const telegramUpdatesMigration = "20260930020000_telegram_updates";
const legalDocumentsMigration = "20260930030000_legal_documents";
const partnerOnboardingMigration = "20260930040000_partner_onboarding";
const catalogFoundationMigration = "20260930050000_catalog_foundation";
const inventorySyncRunsMigration = "20260930080000_inventory_sync_runs";
const inventorySyncEventsMigration = "20260930090000_inventory_sync_events";
const cartMigration = "20260930100000_cart";
const ordersMigration = "20260930110000_orders";
const commissionLedgerMigration = "20261001000000_commission_ledger";

export function createDatabasePool(connectionString: string): Pool {
  const options: PoolConfig = {
    connectionString,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000
  };
  return new Pool(options);
}

export async function checkDatabaseReady(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
  const result = await pool.query<{
    migration_name: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>("SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations");

  if (result.rows.some((row) => row.finished_at === null && row.rolled_back_at === null)) {
    throw new Error("A database migration failed or is incomplete");
  }
  if (!result.rows.some((row) => row.migration_name === foundationMigration && row.finished_at !== null)) {
    throw new Error("Repository foundation migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === userSessionsMigration && row.finished_at !== null)) {
    throw new Error("User and Session migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === telegramUpdatesMigration && row.finished_at !== null)) {
    throw new Error("Telegram Update migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === legalDocumentsMigration && row.finished_at !== null)) {
    throw new Error("Legal Documents migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === partnerOnboardingMigration && row.finished_at !== null)) {
    throw new Error("Partner onboarding migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === catalogFoundationMigration && row.finished_at !== null)) {
    throw new Error("Catalog foundation migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === inventorySyncRunsMigration && row.finished_at !== null)) {
    throw new Error("Inventory sync runs migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === inventorySyncEventsMigration && row.finished_at !== null)) {
    throw new Error("Inventory sync events migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === cartMigration && row.finished_at !== null)) {
    throw new Error("Cart migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === ordersMigration && row.finished_at !== null)) {
    throw new Error("Orders migration has not been applied");
  }
  if (!result.rows.some((row) => row.migration_name === commissionLedgerMigration && row.finished_at !== null)) {
    throw new Error("Commission/Ledger migration has not been applied");
  }
}
