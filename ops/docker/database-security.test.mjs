import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const databaseUrl = process.env.WATCH_SECURITY_TEST_DATABASE_URL;
if ((process.env.CI || process.env.WATCH_REQUIRE_DB === "1") && !databaseUrl) {
  throw new Error("DB security acceptance requires disposable WATCH_SECURITY_TEST_DATABASE_URL; it must not skip");
}

test("fresh-volume roles and migrated app grants enforce least privilege", { skip: !databaseUrl }, async () => {
  // Opt in only with a disposable, empty database named watch. This test creates
  // roles and runs every committed migration; never point it at persistent data.
  const url = new URL(databaseUrl);
  assert.equal(url.pathname, "/watch");
  const admin = new Pool({ connectionString: databaseUrl });
  let app;
  try {
    const tables = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    assert.equal(tables.rowCount, 0, "Security test requires an empty disposable database");
    const init = readFileSync("ops/docker/postgres-init.sh", "utf8").split("<<'SQL'\n")[1].split("\nSQL")[0]
      .replace(":'migrate_password'", "'test-only-migrate'").replace(":'app_password'", "'test-only-app'");
    await admin.query(init);
    const migrateUrl = new URL(databaseUrl);
    migrateUrl.username = "watch_migrator";
    migrateUrl.password = "test-only-migrate";
    const migration = spawnSync(process.execPath, [process.env.npm_execpath, "--filter", "@watch/db", "db:migrate"], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: migrateUrl.toString() }
    });
    assert.equal(migration.status, 0, `${migration.stdout}\n${migration.stderr}`);
    const migrator = new Pool({ connectionString: migrateUrl.toString() });
    try { await migrator.query(readFileSync("ops/docker/app-grants.sql", "utf8")); }
    finally { await migrator.end(); }
    const appUrl = new URL(databaseUrl);
    appUrl.username = "watch_app";
    appUrl.password = "test-only-app";
    app = new Pool({ connectionString: appUrl.toString() });
    assert.ok((await app.query("SELECT * FROM _prisma_migrations")).rowCount > 0);
    await app.query("SELECT * FROM users LIMIT 1");
    await app.query("INSERT INTO platform_settings (singleton_id, platform_currency) VALUES (1, 'BYN')");
    for (const sql of [
      "CREATE TABLE public.forbidden (id integer)", "CREATE SCHEMA forbidden",
      "SET ROLE watch_migrator", "DELETE FROM _prisma_migrations",
      "DELETE FROM legal_documents", "UPDATE platform_settings SET platform_currency='USD'",
      "DELETE FROM ledger_entries", "DELETE FROM payout_allocations", "CREATE ROLE forbidden"
    ]) await assert.rejects(app.query(sql), (error) => error.code === "42501", sql);
    const flags = await app.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(flags.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false });
  } finally {
    if (app) await app.end();
    await admin.end();
  }
});
