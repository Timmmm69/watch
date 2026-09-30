import { Pool, type PoolConfig } from "pg";

const foundationMigration = "20260930000000_repository_foundation";
const userSessionsMigration = "20260930010000_user_sessions";
const telegramUpdatesMigration = "20260930020000_telegram_updates";

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
}
