import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";
import { CatalogService } from "../catalog/catalog.js";
import { FakeInventoryProvider } from "./fake.js";
import { GoogleAuth } from "google-auth-library";
import { createConfiguredInventoryOrchestrator } from "./runtime.js";
import type { ApiRuntimeConfig } from "@watch/config";
import type { InventoryRecord } from "./provider.js";
import { InventoryService } from "./service.js";
import { INVENTORY_SYNC_LOCK, InventorySyncOrchestrator, runScheduledInventorySync } from "./orchestrator.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `inventory_orchestrator_${randomUUID().replaceAll("-", "")}`;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 }) : null;
const actor = randomUUID();
let product: string;
let variants: string[];

function orchestrator(records: InventoryRecord[] = []) {
  return new InventorySyncOrchestrator(pool!, new FakeInventoryProvider(records, { sourceVersion: "source-v1" }));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  if (!pool || !adminPool) return;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const root = new URL("../../../../packages/db/prisma/migrations/", import.meta.url);
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith("202")) await pool.query(await readFile(new URL(`${name}/migration.sql`, root), "utf8"));
  }
  await pool.query("INSERT INTO platform_settings (platform_currency) VALUES ('BYN')");
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE inventory_items, inventory_sync_runs, events, audit_logs, product_variants, products, suppliers, users CASCADE");
  await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, 42, 'Sync')", [actor]);
  const supplier = randomUUID();
  product = randomUUID();
  variants = [randomUUID(), randomUUID()];
  await pool.query("INSERT INTO suppliers (id, name) VALUES ($1, 'Test')", [supplier]);
  await pool.query("INSERT INTO products (id, supplier_id, title, slug) VALUES ($1, $2, 'Test', 'test')", [product, supplier]);
  for (const [index, id] of variants.entries()) {
    await pool.query(
      `INSERT INTO product_variants (id, product_id, sku, price_minor, currency, partner_commission_unit_minor, inventory_external_key)
       VALUES ($1, $2, $3, 100, 'BYN', 0, $3)`, [id, product, `key-${index}`]
    );
    await pool.query("INSERT INTO inventory_items (variant_id) VALUES ($1)", [id]);
  }
});

afterAll(async () => {
  if (!pool || !adminPool) return;
  await pool.end();
  await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await adminPool.end();
});

describe.skipIf(!databaseUrl)("safe inventory orchestration against PostgreSQL", () => {
  it("wires Google Sheets into Admin sync with real PostgreSQL apply and preserves catalog authority", async () => {
    const token = vi.spyOn(GoogleAuth.prototype, "getAccessToken").mockResolvedValue("test-token");
    const googleFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ values: [
      ["external_key", "stock_quantity", "sku", "price_minor", "status", "commission"],
      ["key-0", 9, "ignore", 99999, "ACTIVE", 999], ["unknown", 3]
    ] })));
    const runner = createConfiguredInventoryOrchestrator(pool!, {
      INVENTORY_PROVIDER: "google_sheets", GOOGLE_SHEETS_SPREADSHEET_ID: "test-sheet",
      GOOGLE_SHEETS_WORKSHEET_NAME: "Stock", GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: {
        type: "service_account", project_id: "test", client_email: "test@example.com", private_key: "not-used-by-mocked-auth"
      }
    } as ApiRuntimeConfig)!;
    const app = createApp({ logger: false, checkReadiness: async () => undefined,
      auth: { store: { loadCurrent: async () => ({
        session: { id: actor }, user: { id: actor, telegramUserId: "42", isAdmin: true, isBlocked: false }
      }) } as unknown as SessionStore, csrfSecret: Buffer.alloc(32, 8),
        appBaseUrl: "https://app.example", adminIds: () => new Set(["42"]) },
      inventory: { service: new InventoryService(pool!), orchestrator: runner }
    });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", headers: {
        cookie: `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`, origin: "https://app.example",
        "x-csrf-token": deriveCsrfToken(Buffer.alloc(32, 8), actor)
      }, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "PARTIAL", providerKey: "google_sheets",
        details: { unknownExternalKeys: ["unknown"] } });
      expect((await pool!.query("SELECT source_quantity, source_status, source_version FROM inventory_items WHERE variant_id = $1", [variants[0]])).rows[0])
        .toEqual({ source_quantity: 9, source_status: "OK", source_version: null });
      expect((await pool!.query("SELECT source_quantity, source_status FROM inventory_items WHERE variant_id = $1", [variants[1]])).rows[0])
        .toEqual({ source_quantity: null, source_status: "MISSING" });
      expect((await pool!.query("SELECT sku, price_minor, partner_commission_unit_minor, status FROM product_variants WHERE id = $1", [variants[0]])).rows[0])
        .toEqual({ sku: "key-0", price_minor: 100, partner_commission_unit_minor: 0, status: "DRAFT" });
      expect(googleFetch).toHaveBeenCalledOnce();
      expect(token).toHaveBeenCalledOnce();
    } finally {
      token.mockRestore(); googleFetch.mockRestore(); await app.close();
    }
  });

  it("holds one physical session across start, provider I/O, apply, finalize and explicit unlock", async () => {
    const acquired: number[] = [];
    const released: number[] = [];
    const observePool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, max: 1 });
    observePool.on("acquire", (client) => { acquired.push((client as unknown as { processID: number }).processID); });
    observePool.on("release", (_error, client) => { released.push((client as unknown as { processID: number }).processID); });
    const entered = deferred();
    const resume = deferred();
    const provider = new FakeInventoryProvider([{ externalKey: "key-0", quantity: 8 }, { externalKey: "key-1", quantity: 9 }]);
    provider.fetchSnapshot = async () => {
      entered.resolve();
      await resume.promise;
      return { fetchedAt: new Date(), records: [{ externalKey: "key-0", quantity: 8 }, { externalKey: "key-1", quantity: 9 }] };
    };
    const execution = new InventorySyncOrchestrator(observePool, provider).run(actor);
    try {
      await entered.promise;
      expect(acquired).toHaveLength(1);
      expect(released).toEqual([]);
      const pid = acquired[0]!;
      const activity = await pool!.query("SELECT state, xact_start FROM pg_stat_activity WHERE pid = $1", [pid]);
      expect(activity.rows[0]).toMatchObject({ state: "idle", xact_start: null });
      const holder = await pool!.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted", [...INVENTORY_SYNC_LOCK]);
      expect(holder.rows).toEqual([{ pid }]);
      // Provider wait holds no Variant/InventoryItem row locks.
      const competitor = await pool!.connect();
      try {
        await competitor.query("BEGIN");
        await competitor.query("SELECT id FROM product_variants FOR UPDATE NOWAIT");
        await competitor.query("SELECT variant_id FROM inventory_items FOR UPDATE NOWAIT");
        expect((await competitor.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [...INVENTORY_SYNC_LOCK])).rows[0].acquired).toBe(false);
      } finally { await competitor.query("ROLLBACK"); competitor.release(); }
      await expect(orchestrator().run()).rejects.toMatchObject({ code: "SYNC_ALREADY_RUNNING", details: { runSummary: { status: "RUNNING" } } });
      resume.resolve();
      const result = await execution;
      expect(result).toMatchObject({ status: "SUCCESS", itemsProcessed: 2, itemsFailed: 0 });
      expect(acquired).toEqual([pid]);
      expect(released).toEqual([pid]);
      expect((await pool!.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND pid = $1", [pid])).rows).toEqual([]);
      const stock = await pool!.query("SELECT last_successful_sync_run_id FROM inventory_items");
      expect(stock.rows.every((row) => row.last_successful_sync_run_id === result.id)).toBe(true);
      expect((await pool!.query("SELECT actor_user_id FROM audit_logs WHERE entity_id = $1", [result.id])).rows[0].actor_user_id).toBe(actor);
    } finally { resume.resolve(); await execution.catch(() => undefined); await observePool.end(); }
  });

  it("reports a null visible run in the lock-before-start-commit race without creating a run", async () => {
    const holder = await pool!.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1, $2)", [...INVENTORY_SYNC_LOCK]);
      await holder.query("BEGIN");
      await holder.query("INSERT INTO inventory_sync_runs (id, provider_key, status) VALUES ($1, 'fake', 'RUNNING')", [randomUUID()]);
      await expect(orchestrator().run()).rejects.toMatchObject({ code: "SYNC_ALREADY_RUNNING", details: { runSummary: null } });
      expect((await pool!.query("SELECT * FROM inventory_sync_runs")).rows).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      await holder.query("SELECT pg_advisory_unlock($1, $2)", [...INVENTORY_SYNC_LOCK]);
      holder.release();
    }
  });

  it("applies good rows, fails closed on duplicates/missing, and records unknown keys", async () => {
    const run = await orchestrator([
      { externalKey: "key-0", quantity: 5 },
      { externalKey: "key-0", quantity: 6 },
      { externalKey: "unknown", quantity: 10 }
    ]).run();
    expect(run).toMatchObject({ status: "FAILED", itemsProcessed: 0, details: { unknownKeys: 1, unknownExternalKeys: ["unknown"] } });
    expect((await pool!.query("SELECT source_status FROM inventory_items ORDER BY variant_id")).rows.map((row) => row.source_status).sort()).toEqual(["INVALID", "MISSING"]);
    const partial = await orchestrator([{ externalKey: "key-0", quantity: 0 }]).run();
    expect(partial).toMatchObject({ status: "PARTIAL", itemsProcessed: 1, itemsFailed: 1 });
    expect((await pool!.query("SELECT source_quantity, source_status FROM inventory_items WHERE variant_id = $1", [variants[0]])).rows[0]).toEqual({ source_quantity: 0, source_status: "OK" });
    const events = await pool!.query("SELECT dedupe_key, payload FROM events");
    expect(events.rows).toEqual([{ dedupe_key: `inventory-sync:${run.id}:failed`, payload: { v: 1, runId: run.id, providerKey: "fake" } }]);
  });

  it("all invalid mapped rows fail, while legitimately empty/no-mapped runs succeed", async () => {
    expect(await orchestrator([{ externalKey: "key-0", quantity: -1 }, { externalKey: "key-1", quantity: 2_147_483_648 }]).run()).toMatchObject({ status: "FAILED", itemsProcessed: 0 });
    await pool!.query("DELETE FROM inventory_items; DELETE FROM product_variants");
    expect(await orchestrator().run()).toMatchObject({ status: "SUCCESS", itemsProcessed: 0, itemsFailed: 0 });
    expect(await orchestrator([{ externalKey: "unknown", quantity: 2 }]).run()).toMatchObject({ status: "SUCCESS", itemsProcessed: 0, details: { unknownKeys: 1 } });
  });

  it("fatal fetch/incomplete snapshot keeps previous quantities, timestamps and identity", async () => {
    await orchestrator([{ externalKey: "key-0", quantity: 7 }, { externalKey: "key-1", quantity: 8 }]).run();
    const before = (await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows;
    const provider = new FakeInventoryProvider();
    provider.fetchSnapshot = async () => { throw new Error("secret provider credentials"); };
    expect(await new InventorySyncOrchestrator(pool!, provider).run()).toMatchObject({ status: "FAILED", errorSummary: "PROVIDER_FETCH_FAILED" });
    provider.capabilities = () => ({ completeSnapshot: false, reservationReconciliation: "NONE" });
    expect(await new InventorySyncOrchestrator(pool!, provider).run()).toMatchObject({ status: "FAILED" });
    expect((await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows).toEqual(before);
    expect(JSON.stringify((await pool!.query("SELECT * FROM inventory_sync_runs")).rows)).not.toContain("secret provider credentials");
  });

  it("skips fetched old-key mappings after concurrent Admin key mutation/reset", async () => {
    await orchestrator([{ externalKey: "key-0", quantity: 7 }, { externalKey: "key-1", quantity: 8 }]).run();
    const provider = new FakeInventoryProvider();
    provider.fetchSnapshot = async () => {
      await new CatalogService(pool!, "BYN").updateVariant(actor, variants[0]!, { inventoryExternalKey: "new-key", safetyBuffer: 3 });
      return { fetchedAt: new Date(), records: [{ externalKey: "key-0", quantity: 99 }, { externalKey: "key-1", quantity: 8 }] };
    };
    expect(await new InventorySyncOrchestrator(pool!, provider).run()).toMatchObject({ status: "PARTIAL", itemsProcessed: 1, details: { changedMappings: 1 } });
    expect((await pool!.query("SELECT * FROM inventory_items WHERE variant_id = $1", [variants[0]])).rows[0]).toMatchObject({
      source_quantity: null, source_status: "UNINITIALIZED", source_version: null,
      last_successful_sync_at: null, last_successful_sync_run_id: null, safety_buffer: 3
    });
    const next = await orchestrator([{ externalKey: "new-key", quantity: 4 }, { externalKey: "key-1", quantity: 8 }]).run();
    expect(next.status).toBe("SUCCESS");
    expect((await pool!.query("SELECT last_successful_sync_run_id FROM inventory_items WHERE variant_id = $1", [variants[0]])).rows[0].last_successful_sync_run_id).toBe(next.id);
  });

  it("isolates row-apply errors and rolls back failed phase-C commits", async () => {
    await pool!.query(`CREATE FUNCTION reject_stock() RETURNS trigger AS $$ BEGIN
      IF NEW.variant_id = '${variants[0]}' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_stock BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION reject_stock()`);
    try {
      expect(await orchestrator([{ externalKey: "key-0", quantity: 3 }, { externalKey: "key-1", quantity: 4 }]).run()).toMatchObject({ status: "PARTIAL", itemsProcessed: 1 });
    } finally { await pool!.query("DROP TRIGGER reject_stock ON inventory_items; DROP FUNCTION reject_stock()"); }
    const before = (await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows;
    await pool!.query(`CREATE FUNCTION reject_stock_commit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected commit'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER reject_stock_commit AFTER UPDATE ON inventory_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_stock_commit()`);
    try {
      expect(await orchestrator([{ externalKey: "key-0", quantity: 33 }, { externalKey: "key-1", quantity: 44 }]).run()).toMatchObject({ status: "FAILED", itemsProcessed: 0 });
      expect((await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows).toEqual(before);
    } finally { await pool!.query("DROP TRIGGER reject_stock_commit ON inventory_items; DROP FUNCTION reject_stock_commit()"); }
  });

  it("recovers all stale runs from committed snapshot evidence without changing stock", async () => {
    const stale = [randomUUID(), randomUUID()];
    for (const id of stale) await pool!.query("INSERT INTO inventory_sync_runs (id, provider_key, status) VALUES ($1, 'fake', 'RUNNING')", [id]);
    await pool!.query("UPDATE inventory_items SET source_quantity = 5, source_status = 'OK', last_successful_sync_at = now(), last_successful_sync_run_id = $1 WHERE variant_id = $2", [stale[0], variants[0]]);
    const before = (await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows;
    const provider = new FakeInventoryProvider();
    provider.fetchSnapshot = async () => {
      expect((await pool!.query("SELECT status FROM inventory_sync_runs WHERE id = $1", [stale[0]])).rows[0].status).toBe("PARTIAL");
      expect((await pool!.query("SELECT status FROM inventory_sync_runs WHERE id = $1", [stale[1]])).rows[0].status).toBe("FAILED");
      expect((await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows).toEqual(before);
      throw new Error("stop before applying");
    };
    await new InventorySyncOrchestrator(pool!, provider).run();
    expect((await pool!.query("SELECT payload FROM events WHERE aggregate_id = $1", [stale[1]])).rows).toHaveLength(1);
    expect((await pool!.query("SELECT * FROM events WHERE aggregate_id = $1", [stale[0]])).rows).toHaveLength(0);
    await new InventorySyncOrchestrator(pool!, provider).run();
    expect((await pool!.query("SELECT * FROM events WHERE aggregate_id = $1", [stale[1]])).rows).toHaveLength(1);
  });

  it("recovers a dead dedicated session as FAILED and allows the next holder to run", async () => {
    const provider = new FakeInventoryProvider();
    provider.fetchSnapshot = async () => {
      const holder = await pool!.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted", [...INVENTORY_SYNC_LOCK]);
      await pool!.query("SELECT pg_terminate_backend($1)", [holder.rows[0].pid]);
      return { fetchedAt: new Date(), records: [] };
    };
    await expect(new InventorySyncOrchestrator(pool!, provider).run()).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    const deadRun = (await pool!.query("SELECT id, status FROM inventory_sync_runs")).rows[0];
    expect(deadRun.status).toBe("RUNNING");
    await orchestrator([{ externalKey: "key-0", quantity: 3 }, { externalKey: "key-1", quantity: 4 }]).run();
    expect((await pool!.query("SELECT status FROM inventory_sync_runs WHERE id = $1", [deadRun.id])).rows[0].status).toBe("FAILED");
    expect((await pool!.query("SELECT * FROM events WHERE aggregate_id = $1", [deadRun.id])).rows).toHaveLength(1);
  });

  it("an empty run interrupted at finalization recovers as FAILED rather than SUCCESS", async () => {
    await pool!.query("DELETE FROM inventory_items; DELETE FROM product_variants");
    await pool!.query(`CREATE FUNCTION reject_empty_finalize() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER reject_empty_finalize AFTER UPDATE ON inventory_sync_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_empty_finalize()`);
    let interrupted!: string;
    try {
      await expect(orchestrator().run()).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
      interrupted = (await pool!.query("SELECT id FROM inventory_sync_runs WHERE status = 'RUNNING'")).rows[0].id;
    } finally { await pool!.query("DROP TRIGGER reject_empty_finalize ON inventory_sync_runs; DROP FUNCTION reject_empty_finalize()"); }
    expect((await orchestrator().run()).status).toBe("SUCCESS");
    expect((await pool!.query("SELECT status FROM inventory_sync_runs WHERE id = $1", [interrupted])).rows[0].status).toBe("FAILED");
    expect((await pool!.query("SELECT * FROM events WHERE aggregate_id = $1", [interrupted])).rows).toHaveLength(1);
  });

  it("phase-F commit failure returns HTTP 503, keeps stock fresh/RUNNING, unlocks and recovers next time", async () => {
    await pool!.query(`CREATE FUNCTION reject_finalize() RETURNS trigger AS $$ BEGIN
      IF NEW.status <> 'RUNNING' THEN RAISE EXCEPTION 'injected finalization commit'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER reject_finalize AFTER UPDATE ON inventory_sync_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_finalize()`);
    const secret = Buffer.alloc(32, 8);
    const sessionId = randomUUID();
    const runner = orchestrator([{ externalKey: "key-0", quantity: 7 }, { externalKey: "key-1", quantity: 8 }]);
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent: async () => ({
        session: { id: sessionId, userId: actor, createdAt: new Date(), expiresAt: new Date(Date.now() + 1000), revokedAt: null },
        user: { id: actor, telegramUserId: "42", firstName: "Sync", lastName: null, username: null, languageCode: null, isAdmin: true, isBlocked: false }
      }) } as unknown as SessionStore, csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set(["42"]) },
      inventory: { service: new InventoryService(pool!), orchestrator: runner }
    });
    let interrupted!: string;
    let before!: unknown[];
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/admin/inventory/sync", headers: {
        cookie: `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, sessionId)
      } });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("DEPENDENCY_UNAVAILABLE");
      const runs = (await pool!.query("SELECT id, status FROM inventory_sync_runs")).rows;
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("RUNNING");
      interrupted = runs[0].id;
      before = (await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows;
      expect(before).toEqual(expect.arrayContaining([expect.objectContaining({ source_status: "OK", last_successful_sync_run_id: interrupted })]));
      const logger = { error: vi.fn() };
      await runScheduledInventorySync(runner, logger);
      expect(logger.error).toHaveBeenCalledWith({ code: "DEPENDENCY_UNAVAILABLE" }, expect.any(String));
      expect((await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows).toEqual(before);
    } finally {
      await app.close();
      await pool!.query("DROP TRIGGER reject_finalize ON inventory_sync_runs; DROP FUNCTION reject_finalize()");
    }
    const provider = new FakeInventoryProvider();
    provider.fetchSnapshot = async () => { throw new Error("offline"); };
    expect((await new InventorySyncOrchestrator(pool!, provider).run()).status).toBe("FAILED");
    expect((await pool!.query("SELECT status FROM inventory_sync_runs WHERE id = $1", [interrupted])).rows[0].status).toBe("PARTIAL");
    expect((await pool!.query("SELECT * FROM inventory_items ORDER BY variant_id")).rows).toEqual(before);
  });
});
