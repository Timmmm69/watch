import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBackup, restoreBackup, authenticateBackup } from "./backup.mjs";
import { root } from "./compose.mjs";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const adminUrl = process.env.WATCH_OPS_TEST_ADMIN_URL;
const pgBin = process.env.WATCH_OPS_TEST_PG_BIN;
const nativeTables = ["inventory_authority", "inventory_initializations", "inventory_movements", "inventory_items",
  "inventory_reservations", "orders", "order_items", "order_fulfillment_details", "commissions", "ledger_entries",
  "payouts", "payout_allocations", "returns", "return_items", "order_money_entries", "customer_obligations",
  "order_direct_expenses", "order_expense_reviews"];
async function nativeSnapshot(pool) {
  return Object.fromEntries(await Promise.all(nativeTables.map(async table => [table,
    (await pool.query(`SELECT to_jsonb(t) AS fact FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.fact)])));
}

/** Only synthetic facts in a newly created disposable DB; never bank/Telegram calls. */
async function seedNativeRelease(pool, actor, docs) {
  const {InitialInventoryImport,INVENTORY_HEADERS}=await import("../../apps/api/dist/inventory/initial-import.js");
  const {DropshipCheckoutService}=await import("../../apps/api/dist/orders/dropship-checkout.js");
  const {AdminOrderService}=await import("../../apps/api/dist/orders/admin.js");
  const {OrderCompletionWorker}=await import("../../apps/api/dist/orders/completion.js");
  const {OrderMoneyService}=await import("../../apps/api/dist/finance/money.js");
  const {PayoutService}=await import("../../apps/api/dist/finance/payouts.js");
  const {AdminReturnService}=await import("../../apps/api/dist/returns/returns.js");
  const partner=randomUUID();
  await pool.query("INSERT INTO partners(id,user_id) VALUES($1,$2)",[partner,actor]);
  await pool.query("INSERT INTO partner_terms_acceptances(partner_id,legal_document_id) VALUES($1,$2)",[partner,docs[0].id]);
  const cells=[INVENTORY_HEADERS,["RESTORE-SKU","Acceptance Watch","","3","240.02","100.00","","Confirmed fixture description",""]];
  const importer=new InitialInventoryImport(pool);
  const preview=await importer.preview(cells); assert.deepEqual(preview.errors,[]);
  const op={actorUserId:actor,operationKey:"restore-opening",reason:"TEST ONLY physical count",occurredAt:new Date()};
  await importer.apply(cells,preview.confirmation,op);
  assert.equal((await importer.apply(cells,preview.confirmation,op)).replayed,true);
  const variant=(await pool.query("SELECT id,product_id FROM product_variants WHERE sku='RESTORE-SKU'")).rows[0];
  const category=randomUUID();
  await pool.query("INSERT INTO categories(id,name,slug) VALUES($1,'Acceptance','acceptance')",[category]);
  await pool.query("INSERT INTO product_categories(product_id,category_id) VALUES($1,$2)",[variant.product_id,category]);
  await pool.query(`INSERT INTO product_assets(id,product_id,type,purpose,storage_key,mime_type,size_bytes)
    VALUES($1,$2,'IMAGE','STOREFRONT','restore-fixture.png','image/png',68)`,[randomUUID(),variant.product_id]);
  await pool.query("UPDATE products SET status='ACTIVE'; UPDATE product_variants SET status='ACTIVE'");
  const legal=Object.fromEntries(docs.map(d=>[d.type,{id:d.id,version:d.version}]));
  const checkout=new DropshipCheckoutService(pool,"BYN",legal);
  const order=(await checkout.checkout(actor,"restore-order",{items:[{variantId:variant.id,quantity:3,expectedDropshipPriceMinor:10000,customerUnitPriceMinor:14500}],
    recipientName:"Acceptance recipient",phone:"+375291234567",address:"TEST ONLY address",partnerTermsDocumentId:docs[0].id,
    privacyDocumentId:docs[2].id,privacyAcknowledged:true})).order;
  const item=(await pool.query("SELECT id FROM order_items WHERE order_id=$1",[order.id])).rows[0].id;
  // Zero-day hold only in this synthetic restore fixture; 14-day gates have dedicated acceptance tests.
  const orders=new AdminOrderService(pool,0), completion=new OrderCompletionWorker(pool), money=new OrderMoneyService(pool);
  for(const state of ["CONFIRMED","FULFILLING","SHIPPED","DELIVERED"]) await orders.transition(order.id,actor,state);
  assert.equal(await completion.completeOrder(order.id),false);
  const fact=(amountMinor,kind="RECEIPT",extra={})=>({operationKey:randomUUID(),reference:`TEST:${randomUUID().slice(0,8)}:${randomUUID().slice(0,8)}`,occurredAt:new Date().toISOString(),
    reason:"TEST ONLY verified fact",confirmed:true,kind,amountMinor,...extra});
  const receipt=fact(43500);
  await money.record(order.id,actor,receipt,"money"); await money.record(order.id,actor,receipt,"money");
  await money.record(order.id,actor,fact(125,"DELIVERY"),"expense");
  await money.record(order.id,actor,{operationKey:randomUUID(),reason:"TEST ONLY reviewed",confirmed:true,expenseEntryCount:1,reviewedTotalMinor:125},"review");
  const returns=new AdminReturnService(pool);
  async function returned(saleable) {
    const r=await returns.create(actor,{orderId:order.id,reason:"TEST ONLY return",items:[{orderItemId:item,quantity:1}]});
    await returns.complete(r.id,actor); await returns.complete(r.id,actor);
    const detail=await returns.detail(r.id);
    await returns.inspect(r.id,actor,{operationKey:randomUUID(),reason:"TEST ONLY inspected",items:[{returnItemId:detail.items[0].id,quantity:1,saleableQuantity:saleable}]});
    const liability=(await money.detail(order.id)).obligations.find(o=>o.outstandingMinor>0);
    assert.ok(liability);
    await money.record(order.id,actor,fact(-14500,"REFUND",{obligationId:liability.id}),"money");
  }
  await returned(1);
  assert.equal(await completion.completeOrder(order.id),true);
  const payouts=new PayoutService(pool,"BYN",legal.PARTNER_TERMS);
  const p=await payouts.request(actor,"restore-payout"); assert.equal(p.payout.amountMinor,9000);
  await payouts.transition(actor,p.payout.id,{target:"PAID",externalReference:"TEST:restore-transfer"});
  const paid=(await pool.query("SELECT * FROM payouts")).rows;
  await returned(0);
  assert.deepEqual((await pool.query("SELECT * FROM payouts")).rows,paid);
  assert.equal((await pool.query("SELECT sum(amount_minor)::int AS n FROM ledger_entries WHERE bucket='AVAILABLE'")).rows[0].n,-4500);
  assert.deepEqual((await pool.query("SELECT native_on_hand,native_reserved_quantity,native_free_value_minor FROM inventory_items")).rows,
    [{native_on_hand:1,native_reserved_quantity:0,native_free_value_minor:8000}]);
  assert.equal((await money.detail(order.id)).cashMinor,14500);
  return nativeSnapshot(pool);
}
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
    const { bootstrapRelease, provisionBootstrapAdmin } = await import(new URL("../../apps/api/dist/operations/bootstrap.js", import.meta.url));
    const { verifyInstalledRelease } = await import(new URL("../../apps/api/dist/operations/readiness.js", import.meta.url));
    const { retryFailed, cleanupTransportData, supportDiagnostics } = await import(new URL("../../apps/api/dist/operations/maintenance.js", import.meta.url));
    const { createApp } = await import(new URL("../../apps/api/dist/app.js", import.meta.url));
    const { loadApiRuntimeConfig } = await import(new URL("../../packages/config/dist/index.js", import.meta.url));
    const docs = [];
    for (const type of ["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"]) {
      const content = `Acceptance fixture ${type}`;
      const file = `${type}.md`; await writeFile(join(directory, file), content);
      docs.push({ type, id: randomUUID(), version: "release-v1", file, sha256: createHash("sha256").update(content).digest("hex"),
        effectiveAt: "2026-01-01T00:00:00.000Z", requiresReacceptance: false });
    }
    const manifestFile = join(directory, "manifest.json");
    const manifest = { supplierName: "TEST ONLY Supplier", documents: docs };
    await writeFile(manifestFile, JSON.stringify(manifest));
    const env = {
      NODE_ENV: "production", DATABASE_URL: appUrl.toString(), APP_BASE_URL: "https://watch.company.org", API_TRUSTED_PROXY_IP: "172.30.36.2",
      RELEASE_TAG: "0123456789abcdef0123456789abcdef01234567", ORDER_HOLD_DAYS: "14", ORDER_OVERDUE_SECONDS: "3600",
      WATCH_PRODUCTION_APPROVAL_FILE: join(directory, "approval.json"), WATCH_CLOSED_ACCEPTANCE: "1",
      PLATFORM_CURRENCY: "BYN", TELEGRAM_BOT_TOKEN: "123:fixture_token", TELEGRAM_BOT_USERNAME: "watch_bot", TELEGRAM_WEBHOOK_SECRET: "a".repeat(32),
      CSRF_SECRET: randomBytes(32).toString("base64url"), ADMIN_TELEGRAM_IDS: "42", SUPPORT_CONTACT: "@watch_support",
      INVENTORY_PROVIDER: "native",
      OBJECT_STORAGE_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", OBJECT_STORAGE_REGION: "auto", OBJECT_STORAGE_BUCKET: "watch-media",
      OBJECT_STORAGE_ACCESS_KEY_ID: "fixture-key", OBJECT_STORAGE_SECRET_ACCESS_KEY: "fixture-secret",
      LEGAL_PARTNER_TERMS_ID: docs[0].id, LEGAL_PARTNER_TERMS_VERSION: docs[0].version,
      LEGAL_SALES_TERMS_ID: docs[1].id, LEGAL_SALES_TERMS_VERSION: docs[1].version,
      LEGAL_PRIVACY_ID: docs[2].id, LEGAL_PRIVACY_VERSION: docs[2].version
    };
    const { productionApprovalFixture, fixturePolicy } = await import("./fixtures/production-approval.mjs");
    const pendingApproval = productionApprovalFixture(env);
    for (const name of ["inventoryLive", "nativeWorkflow", "telegramDevice"]) pendingApproval.acceptance[name].passed = false;
    await writeFile(env.WATCH_PRODUCTION_APPROVAL_FILE, JSON.stringify(pendingApproval));
    await writeFile(join(directory, "pii-policy.md"), fixturePolicy);
    assert.throws(() => loadApiRuntimeConfig({ ...env, WATCH_CLOSED_ACCEPTANCE: undefined }), /approval/);
    const runtime = loadApiRuntimeConfig(env);
    const cli = (...args) => spawnSync(process.execPath, ["apps/api/dist/operations/cli.js", ...args], {
      cwd: root, env: { ...process.env, ...env }, encoding: "utf8"
    });
    assert.equal(cli("config").status, 0, "Production CLI must permit honest pending live proof only in closed acceptance");
    let actor; const event = randomUUID();
    let nativeHistory;
    const api = createApp({ checkReadiness: () => verifyInstalledRelease(appPool, runtime) });
    try {
      assert.equal((await api.inject({ method: "GET", url: "/ready" })).statusCode, 503);
      await writeFile(join(directory, "pii-policy.md"), "unreviewed policy");
      await assert.rejects(bootstrapRelease(appPool, runtime, manifestFile), /PII policy hash mismatch/);
      assert.equal((await appPool.query("SELECT count(*)::int AS n FROM legal_documents")).rows[0].n, 0);
      await writeFile(join(directory, "pii-policy.md"), fixturePolicy);
      const firstBootstrap = cli("bootstrap", manifestFile);
      assert.equal(firstBootstrap.status, 0, firstBootstrap.stdout + firstBootstrap.stderr);
      const replayBootstrap = cli("bootstrap", manifestFile);
      assert.equal(replayBootstrap.status, 0, replayBootstrap.stdout + replayBootstrap.stderr);
      // Bootstrap cannot manufacture opening stock; readiness stays closed until explicit import.
      assert.equal((await api.inject({ method: "GET", url: "/ready" })).statusCode, 503);
      await assert.rejects(provisionBootstrapAdmin(appPool,runtime,"43","Test","TEST:owner-verified"));
      actor=await provisionBootstrapAdmin(appPool,runtime,"42","Test","TEST:owner-verified");
      assert.equal(await provisionBootstrapAdmin(appPool,runtime,"42","Test","TEST:owner-verified"),actor);
      assert.equal((await appPool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n,0);
      nativeHistory = await seedNativeRelease(appPool, actor, docs);
      assert.equal((await api.inject({ method: "GET", url: "/ready" })).statusCode, 200);
      const privateVerify = cli("verify");
      assert.equal(privateVerify.status, 0, privateVerify.stdout + privateVerify.stderr);
      assert.throws(() => loadApiRuntimeConfig({ ...env, WATCH_CLOSED_ACCEPTANCE: undefined }), /approval/,
        "A healthy private stage must not authorize public startup without full live proof");
      await assert.rejects(verifyInstalledRelease(appPool, {...runtime,INVENTORY_PROVIDER:"google_sheets"}), /NATIVE_AUTHORITY/);
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
      await writeFile(join(directory, docs[0].file), `Acceptance fixture ${docs[0].type}`);
      const unapproved = structuredClone(runtime);
      unapproved.productionApproval.legal.PARTNER_TERMS.sha256 = "b".repeat(64);
      await assert.rejects(verifyInstalledRelease(appPool, unapproved), /not approved/);
      await assert.rejects(bootstrapRelease(appPool, unapproved, manifestFile), /not approved/);
      manifest.documents[0].requiresReacceptance = true; await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.rejects(bootstrapRelease(appPool, runtime, manifestFile), /Immutable/);
      manifest.documents[0].requiresReacceptance = false; await writeFile(manifestFile, JSON.stringify(manifest));
    } finally { await api.close(); }

    await appPool.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,status,attempts)
      VALUES ($1,'ORDER_STATUS_CHANGED','Order',$2,'test-retained-dedupe','{"v":1}','FAILED',8)`, [event, randomUUID()]);
    await appPool.query("INSERT INTO telegram_updates (update_id,payload,status,attempts,received_at) VALUES (1001,'{}','FAILED',8,now()),(1002,'{}','PROCESSING',1,now()-interval '31 days')");
    await appPool.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()-interval '1 minute')", [randomUUID(), actor, "a".repeat(64)]);
    await assert.rejects(retryFailed(appPool, "event", event, "43", ["42"]));
    const beforeRetryAudits=Number((await appPool.query("SELECT count(*) AS n FROM audit_logs")).rows[0].n);
    await retryFailed(appPool, "event", event, "42", ["42"]);
    await retryFailed(appPool, "telegram", "1001", "42", ["42"]);
    await assert.rejects(retryFailed(appPool, "event", event, "42", ["42"]));
    const retry = (await appPool.query("SELECT status,attempts,dedupe_key,payload FROM events WHERE id=$1", [event])).rows[0];
    assert.deepEqual(retry, { status: "PENDING", attempts: 0, dedupe_key: "test-retained-dedupe", payload: { v: 1 } });
    await cleanupTransportData(appPool, 30);
    assert.equal((await appPool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n, 0);
    assert.deepEqual((await appPool.query("SELECT update_id::text FROM telegram_updates ORDER BY update_id")).rows, [{ update_id: "1001" }]);
    assert.equal((await appPool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n, beforeRetryAudits+2);
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
    assert.deepEqual(await nativeSnapshot(restoredPool), nativeHistory);
    assert.ok((await restoredPool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n > 2);
    for (const table of nativeTables.filter(name=>!["orders","order_items","inventory_items","commissions","payouts"].includes(name))) {
      await assert.rejects(restoredPool.query(`DELETE FROM ${table}`), error=>["42501","23514"].includes(error.code));
    }
    for (const sql of ["DELETE FROM legal_documents", "UPDATE platform_settings SET platform_currency='USD'", "DELETE FROM _prisma_migrations", "CREATE TABLE forbidden (id integer)"])
      await assert.rejects(restoredPool.query(sql), (error) => error.code === "42501");
    await assert.rejects(restoreBackup(backup, key, target, run), /already exists/);
    console.log("Verified native bootstrap/import/order/cash/shipment/delivery/release/payout/late non-saleable return and encrypted isolated restore with exact economic history, migration rows and ACLs (test facts only).");
  } finally {
    await restoredPool?.end(); await appPool?.end(); await sourcePool?.end();
    for (const database of [target, source]) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end(); await rm(directory, { recursive: true });
  }
});
