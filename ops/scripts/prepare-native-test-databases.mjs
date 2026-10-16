import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const targets = [["WATCH_T46_DATABASE_URL", "watch_t46"], ["WATCH_T47_DATABASE_URL", "watch_t47"], ["WATCH_T48_DATABASE_URL", "watch_t48"]];

export function nativeTestDatabaseConfiguration(env) {
  assert.ok(env.WATCH_NATIVE_TEST_ADMIN_URL, "Explicit WATCH_NATIVE_TEST_ADMIN_URL is required");
  const admin = new URL(env.WATCH_NATIVE_TEST_ADMIN_URL);
  assert.ok(["postgres:", "postgresql:"].includes(admin.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(admin.hostname), "Native test setup requires loopback PostgreSQL");
  assert.equal(admin.pathname, "/postgres", "Native test admin URL must select /postgres");
  assert.equal(admin.search, ""); assert.equal(admin.hash, "");
  for (const [key, name] of targets) {
    assert.ok(env[key], `Explicit ${key} is required`);
    const expected = new URL(admin); expected.pathname = `/${name}`;
    assert.equal(new URL(env[key]).toString(), expected.toString(), "Native test URLs must select the fixed disposable databases on the admin cluster");
  }
  return { adminUrl: admin.toString(), names: targets.map(([, name]) => name) };
}

export async function prepareNativeTestDatabases(env = process.env, poolFactory) {
  const { adminUrl, names } = nativeTestDatabaseConfiguration(env);
  if (!poolFactory) {
    const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
    const { Pool } = require("pg");
    poolFactory = (connectionString) => new Pool({ connectionString });
  }
  const pool = poolFactory(adminUrl), created = [];
  try {
    for (const name of names) {
      const existing = await pool.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
      // Fixed names only; never reset, drop, migrate or overwrite an existing database.
      if (!existing.rowCount) { await pool.query(`CREATE DATABASE "${name}"`); created.push(name); }
    }
    return created;
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify({ status: "ok", created: await prepareNativeTestDatabases() })); }
  catch { console.error("Disposable native test database setup failed"); process.exitCode = 1; }
}
