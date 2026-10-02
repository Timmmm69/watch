import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBackup, restoreBackup, authenticateBackup } from "./backup.mjs";
import { root } from "./compose.mjs";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const adminUrl = process.env.WATCH_OPS_TEST_ADMIN_URL;
const pgBin = process.env.WATCH_OPS_TEST_PG_BIN;
if ((process.env.CI || process.env.WATCH_REQUIRE_DB === "1") && (!adminUrl || !pgBin)) {
  throw new Error("Migration/bootstrap acceptance requires WATCH_OPS_TEST_ADMIN_URL and WATCH_OPS_TEST_PG_BIN; restore must not skip");
}

test("AT-032: fresh migrations/bootstrap, operations and encrypted restore retain data, constraints and exact migration state", { skip: !adminUrl || !pgBin, timeout: 120000 }, async () => {
  // Explicit opt-in, loopback only, new databases only. Never use a production URL.
  const url = new URL(adminUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/postgres");
  const nonce = randomBytes(6).toString("hex");
  const source = `watch_restore_source_${nonce}`, target = `watch_restore_test_${nonce}`;
  const admin = new Pool({ connectionString: adminUrl });
  const directory = await mkdtemp(join(tmpdir(), "watch-restore-integration-"));
  const appUrl = new URL(url); appUrl.username = "watch_app"; appUrl.password = ""; appUrl.pathname = `/${source}`;
  const migrateUrl = new URL(appUrl); migrateUrl.username = "watch_migrator";
  let sourcePool, appPool, restoredPool;
  try {
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='watch_migrator') THEN CREATE ROLE watch_migrator LOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='watch_app') THEN CREATE ROLE watch_app LOGIN; END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${source}" OWNER watch_migrator`);
    const ownerUrl = new URL(url); ownerUrl.pathname = `/${source}`;
    sourcePool = new Pool({ connectionString: ownerUrl.toString() });
    await sourcePool.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC;
      ALTER SCHEMA public OWNER TO watch_migrator;
      GRANT USAGE ON SCHEMA public TO watch_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE watch_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO watch_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE watch_migrator IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO watch_app`);
    const migration = spawnSync(process.execPath, [process.env.npm_execpath, "--filter", "@watch/db", "db:migrate"], {
      cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: migrateUrl.toString() }
    });
    assert.equal(migration.status, 0, `${migration.stdout}\n${migration.stderr}`);
    await sourcePool.query(await readFile(resolve(root, "ops/docker/app-grants.sql"), "utf8"));
    appPool = new Pool({ connectionString: appUrl.toString() });
    const { bootstrapRelease } = await import(new URL("../../apps/api/dist/operations/bootstrap.js", import.meta.url));
    const { verifyInstalledRelease } = await import(new URL("../../apps/api/dist/operations/readiness.js", import.meta.url));
    const { retryFailed, cleanupTransportData, supportDiagnostics } = await import(new URL("../../apps/api/dist/operations/maintenance.js", import.meta.url));
    const { createApp } = await import(new URL("../../apps/api/dist/app.js", import.meta.url));
    const { loadApiRuntimeConfig } = await import(new URL("../../packages/config/dist/index.js", import.meta.url));
    const docs = [];
    for (const type of ["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"]) {
      const content = `# TEST ONLY ${type}`;
      const file = `${type}.md`; await writeFile(join(directory, file), content);
      docs.push({ type, id: randomUUID(), version: "test-v1", file, sha256: createHash("sha256").update(content).digest("hex"),
        effectiveAt: "2026-01-01T00:00:00.000Z", requiresReacceptance: false });
    }
    const manifestFile = join(directory, "manifest.json");
    const manifest = { supplierName: "TEST ONLY Supplier", documents: docs };
    await writeFile(manifestFile, JSON.stringify(manifest));
    const env = {
      NODE_ENV: "production", DATABASE_URL: appUrl.toString(), APP_BASE_URL: "https://app.example.com", API_TRUSTED_PROXY_IP: "172.30.36.2",
      PLATFORM_CURRENCY: "BYN", TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_BOT_USERNAME: "test_bot", TELEGRAM_WEBHOOK_SECRET: "a".repeat(32),
      CSRF_SECRET: randomBytes(32).toString("base64url"), ADMIN_TELEGRAM_IDS: "42", SUPPORT_CONTACT: "@test_support",
      INVENTORY_PROVIDER: "google_sheets", GOOGLE_SHEETS_SPREADSHEET_ID: "test-sheet", GOOGLE_SHEETS_WORKSHEET_NAME: "inventory",
      GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON.stringify({ type: "service_account", project_id: "test", client_email: "test@example.com",
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) })).toString("base64"),
      OBJECT_STORAGE_ENDPOINT: "https://test.r2.cloudflarestorage.com", OBJECT_STORAGE_REGION: "auto", OBJECT_STORAGE_BUCKET: "test",
      OBJECT_STORAGE_ACCESS_KEY_ID: "test", OBJECT_STORAGE_SECRET_ACCESS_KEY: "test",
      LEGAL_PARTNER_TERMS_ID: docs[0].id, LEGAL_PARTNER_TERMS_VERSION: docs[0].version,
      LEGAL_SALES_TERMS_ID: docs[1].id, LEGAL_SALES_TERMS_VERSION: docs[1].version,
      LEGAL_PRIVACY_ID: docs[2].id, LEGAL_PRIVACY_VERSION: docs[2].version
    };
    const runtime = loadApiRuntimeConfig(env);
    const api = createApp({ checkReadiness: () => verifyInstalledRelease(appPool, runtime) });
    try {
      assert.equal((await api.inject({ method: "GET", url: "/ready" })).statusCode, 503);
      await bootstrapRelease(appPool, runtime, manifestFile);
      await bootstrapRelease(appPool, runtime, manifestFile);
      assert.equal((await api.inject({ method: "GET", url: "/ready" })).statusCode, 200);
      assert.equal((await appPool.query("SELECT count(*)::int AS n FROM suppliers")).rows[0].n, 1);
      await assert.rejects(verifyInstalledRelease(appPool, { ...runtime, PLATFORM_CURRENCY: "USD" }), /mismatch/);
      await sourcePool.query("UPDATE suppliers SET status='INACTIVE'");
      assert.equal((await api.inject({ method: "GET", url: "/ready" })).statusCode, 503);
      await sourcePool.query("UPDATE suppliers SET status='ACTIVE'");
      await sourcePool.query("UPDATE _prisma_migrations SET rolled_back_at=now() WHERE migration_name='20261004000000_analytics_cohorts'");
      assert.equal((await api.inject({ method: "GET", url: "/ready" })).statusCode, 503);
      await sourcePool.query("UPDATE _prisma_migrations SET rolled_back_at=NULL WHERE migration_name='20261004000000_analytics_cohorts'");
      await writeFile(join(directory, docs[0].file), "tampered reviewed file");
      await assert.rejects(bootstrapRelease(appPool, runtime, manifestFile), /hash mismatch/);
      await writeFile(join(directory, docs[0].file), `# TEST ONLY ${docs[0].type}`);
      manifest.documents[0].requiresReacceptance = true; await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.rejects(bootstrapRelease(appPool, runtime, manifestFile), /Immutable/);
      manifest.documents[0].requiresReacceptance = false; await writeFile(manifestFile, JSON.stringify(manifest));
    } finally { await api.close(); }

    const actor = randomUUID(), event = randomUUID();
    await appPool.query("INSERT INTO users (id,telegram_user_id,first_name,is_admin) VALUES ($1,42,'Test',true)", [actor]);
    await appPool.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,status,attempts)
      VALUES ($1,'ORDER_STATUS_CHANGED','Order',$2,'test-retained-dedupe','{"v":1}','FAILED',8)`, [event, randomUUID()]);
    await appPool.query("INSERT INTO telegram_updates (update_id,payload,status,attempts,received_at) VALUES (1001,'{}','FAILED',8,now()),(1002,'{}','PROCESSING',1,now()-interval '31 days')");
    await appPool.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()-interval '1 minute')", [randomUUID(), actor, "a".repeat(64)]);
    await assert.rejects(retryFailed(appPool, "event", event, "43", ["42"]));
    await retryFailed(appPool, "event", event, "42", ["42"]);
    await retryFailed(appPool, "telegram", "1001", "42", ["42"]);
    await assert.rejects(retryFailed(appPool, "event", event, "42", ["42"]));
    const retry = (await appPool.query("SELECT status,attempts,dedupe_key,payload FROM events WHERE id=$1", [event])).rows[0];
    assert.deepEqual(retry, { status: "PENDING", attempts: 0, dedupe_key: "test-retained-dedupe", payload: { v: 1 } });
    await cleanupTransportData(appPool, 30);
    assert.equal((await appPool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n, 0);
    assert.deepEqual((await appPool.query("SELECT update_id::text FROM telegram_updates ORDER BY update_id")).rows, [{ update_id: "1001" }]);
    assert.equal((await appPool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n, 2);
    assert.ok(!JSON.stringify(await supportDiagnostics(appPool)).includes("test-retained-dedupe"));
    const sourceHistory = (await appPool.query("SELECT * FROM _prisma_migrations ORDER BY migration_name")).rows;
    const binary = (name) => join(pgBin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
    const pgEnv = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: url.username, PGPASSWORD: decodeURIComponent(url.password) };
    const key = randomBytes(32);
    const backup = await createBackup(directory, key, () => spawn(binary("pg_dump"), ["-Fc", "--no-acl", "--dbname", source], { env: pgEnv, stdio: ["ignore", "pipe", "pipe"] }));
    await authenticateBackup(backup, key);
    const run = async (args, input) => {
      if (args[0] === "run") {
        const result = spawnSync(process.execPath, ["apps/api/dist/operations/cli.js", "verify-restore"], {
          cwd: root, env: { ...process.env, ...env, WATCH_RESTORE_DATABASE: target }, encoding: "utf8"
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      }
      const dbArg = args.find((arg) => arg.startsWith("--dbname="));
      const db = dbArg.slice("--dbname=".length);
      const connection = new URL(url); connection.pathname = `/${db === "watch" ? source : db}`;
      const pool = new Pool({ connectionString: connection.toString() });
      try { for (const statement of input.split(";").filter((sql) => sql.trim())) await pool.query(statement); }
      finally { await pool.end(); }
      return "";
    };
    const result = await restoreBackup(backup, key, target, run, (args) => {
      return spawn(binary("pg_restore"), args.slice(args.indexOf("pg_restore") + 1).filter((arg) => !arg.startsWith("--host=") && !arg.startsWith("--username=")),
        { env: pgEnv, stdio: ["pipe", "pipe", "pipe"] });
    });
    assert.equal(result.verified, true);
    const restoredUrl = new URL(appUrl); restoredUrl.pathname = `/${target}`;
    restoredPool = new Pool({ connectionString: restoredUrl.toString() });
    assert.deepEqual((await restoredPool.query("SELECT * FROM _prisma_migrations ORDER BY migration_name")).rows, sourceHistory);
    assert.deepEqual((await restoredPool.query("SELECT status,attempts,dedupe_key,payload FROM events WHERE id=$1", [event])).rows[0], retry);
    assert.equal((await restoredPool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n, 2);
    for (const sql of ["DELETE FROM legal_documents", "UPDATE platform_settings SET platform_currency='USD'", "DELETE FROM _prisma_migrations", "CREATE TABLE forbidden (id integer)"])
      await assert.rejects(restoredPool.query(sql), (error) => error.code === "42501");
    await assert.rejects(restoreBackup(backup, key, target, run), /already exists/);
    console.log("Verified fresh bootstrap, readiness failure gates, retention, audited retry and encrypted PostgreSQL restore with exact migration rows/ACLs.");
  } finally {
    await restoredPool?.end(); await appPool?.end(); await sourcePool?.end();
    for (const database of [target, source]) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end(); await rm(directory, { recursive: true });
  }
});
