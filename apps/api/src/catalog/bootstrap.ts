import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabasePool } from "@watch/db";
import { initializePlatformCurrency, seedSupplier } from "./catalog.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

function parseArgs(argv: string[]): { currency: string | undefined; supplierName: string | undefined } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return { currency: args.currency, supplierName: args["supplier-name"] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const currency = args.currency ?? process.env.PLATFORM_CURRENCY;
  if (!currency) throw new Error("--currency or PLATFORM_CURRENCY is required");
  const supplierName = args.supplierName ?? "Основной поставщик";

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createDatabasePool(databaseUrl);

  try {
    const platform = await initializePlatformCurrency(pool, currency);
    const supplier = await seedSupplier(pool, supplierName);
    console.log(JSON.stringify({
      platformCurrency: platform.platformCurrency,
      platformCurrencyCreated: platform.created,
      supplierId: supplier.supplierId,
      supplierStatus: supplier.status,
      supplierCreated: supplier.created
    }));
  } finally {
    await pool.end();
  }
}

await main();
