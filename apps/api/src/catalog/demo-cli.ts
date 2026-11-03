import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { checkDatabaseReady, createDatabasePool } from "@watch/db";
import { S3ObjectStorage } from "./assets.js";
import { seedDemoCatalog } from "./demo.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
try {
  if (process.env.NODE_ENV === "production") throw new Error("Demo seed is for development only");
  if (process.env.INVENTORY_PROVIDER !== "native") throw new Error("Set INVENTORY_PROVIDER=native");
  const names = ["DATABASE_URL", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_REGION", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"] as const;
  for (const name of names) if (!process.env[name]) throw new Error(`${name} is required`);
  const pool = createDatabasePool(process.env.DATABASE_URL!);
  try {
    await checkDatabaseReady(pool);
    const storage = new S3ObjectStorage(process.env.OBJECT_STORAGE_BUCKET!, process.env.OBJECT_STORAGE_ENDPOINT!,
      process.env.OBJECT_STORAGE_REGION!, process.env.OBJECT_STORAGE_ACCESS_KEY_ID!, process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!);
    console.log(JSON.stringify(await seedDemoCatalog(pool, storage)));
  } finally { await pool.end(); }
} catch (error) {
  console.error(error instanceof Error && !("code" in error) ? error.message : "Demo catalog failed; check database and storage configuration");
  process.exitCode = 1;
}
