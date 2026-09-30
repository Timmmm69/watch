import type { Pool, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { LegalDocuments } from "./legal.js";

const pastDate = new Date("2026-01-01T00:00:00Z");
const futureDate = new Date("2099-01-01T00:00:00Z");

interface Row { [column: string]: unknown }

function poolWith(handler: (sql: string, params: unknown[]) => Promise<QueryResult<Row>>): Pool {
  return { query: handler } as unknown as Pool;
}

function result(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

describe("LegalDocuments", () => {
  it("returns the configured current document projection", async () => {
    const pool = poolWith(async (sql, params) => {
      expect(sql).toContain("content_markdown");
      expect(params).toEqual(["doc-1", "PARTNER_TERMS"]);
      return result([{
        id: "doc-1", type: "PARTNER_TERMS", version: "v1", sha256: "a".repeat(64),
        content_markdown: "# Terms", requires_reacceptance: false, effective_at: pastDate
      }]);
    });
    const store = new LegalDocuments(pool, { PARTNER_TERMS: { id: "doc-1", version: "v1" } });
    const doc = await store.getCurrent("PARTNER_TERMS");
    expect(doc).toMatchObject({ id: "doc-1", type: "PARTNER_TERMS", version: "v1", contentMarkdown: "# Terms", requiresReacceptance: false });
    expect(doc?.effectiveAt).toBe(pastDate.toISOString());
  });

  it("returns null when the type is not configured", async () => {
    const pool = poolWith(async () => { throw new Error("unexpected query"); });
    const store = new LegalDocuments(pool, { PARTNER_TERMS: { id: "doc-1", version: "v1" } });
    expect(await store.getCurrent("SALES_TERMS")).toBeNull();
    expect(await store.getCurrent("PRIVACY")).toBeNull();
  });

  it("returns null when the configured document is missing", async () => {
    const pool = poolWith(async () => result([]));
    const store = new LegalDocuments(pool, { PARTNER_TERMS: { id: "doc-1", version: "v1" } });
    expect(await store.getCurrent("PARTNER_TERMS")).toBeNull();
  });

  it("verifies type, version and effective time for every configured current document", async () => {
    const pool = poolWith(async (sql, params) => {
      expect(sql).toContain("effective_at");
      expect(params).toEqual(["doc-1"]);
      return result([{ type: "PARTNER_TERMS", version: "v1", effective_at: pastDate }]);
    });
    const store = new LegalDocuments(pool, { PARTNER_TERMS: { id: "doc-1", version: "v1" } });
    await expect(store.verifyCurrentConfigured()).resolves.toBeUndefined();
  });

  it("rejects missing, mismatched and not-yet-effective configured documents", async () => {
    const cases: { rows: Row[]; message: string }[] = [
      { rows: [], message: "not published" },
      { rows: [{ type: "SALES_TERMS", version: "v1", effective_at: pastDate }], message: "has type" },
      { rows: [{ type: "PARTNER_TERMS", version: "v2", effective_at: pastDate }], message: "version mismatch" },
      { rows: [{ type: "PARTNER_TERMS", version: "v1", effective_at: futureDate }], message: "not yet effective" }
    ];
    for (const { rows, message } of cases) {
      const pool = poolWith(async () => result(rows));
      const store = new LegalDocuments(pool, { PARTNER_TERMS: { id: "doc-1", version: "v1" } });
      await expect(store.verifyCurrentConfigured()).rejects.toThrow(message);
    }
  });

  it("calls the database once per configured type", async () => {
    const query = vi.fn(async (_sql, params) => {
      const id = params[0];
      return result(id === "doc-1"
        ? [{ type: "PARTNER_TERMS", version: "v1", effective_at: pastDate }]
        : [{ type: "SALES_TERMS", version: "v2", effective_at: pastDate }]);
    });
    const pool = poolWith(query);
    const store = new LegalDocuments(pool, {
      PARTNER_TERMS: { id: "doc-1", version: "v1" },
      SALES_TERMS: { id: "doc-2", version: "v2" }
    });
    await store.verifyCurrentConfigured();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
