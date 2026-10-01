import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { LegalDocuments } from "../legal/legal.js";
import { PartnerService, partnerProgramMutationAllowed, partnerTermsCurrent } from "./partner.js";

function result(rows: unknown[]): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

function makeClient(onQuery: (sql: string, params: unknown[]) => QueryResult): PoolClient & { queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return onQuery(sql, params);
    },
    release: () => undefined,
    queries
  };
  return client as unknown as PoolClient & { queries: typeof queries };
}

describe("BR-007 partner terms predicate", () => {
  it("derives partnerTermsCurrent only from acceptance or a non-reaccept-required document", () => {
    expect(partnerTermsCurrent(false, false)).toBe(true);
    expect(partnerTermsCurrent(false, true)).toBe(true);
    expect(partnerTermsCurrent(true, true)).toBe(true);
    expect(partnerTermsCurrent(true, false)).toBe(false);
  });

  it("allows Partner-program mutation only for an unblocked ACTIVE Partner with current terms", () => {
    const base = { userBlocked: false, partnerStatus: "ACTIVE" as const, partnerTermsCurrent: true };
    expect(partnerProgramMutationAllowed(base)).toBe(true);
    expect(partnerProgramMutationAllowed({ ...base, userBlocked: true })).toBe(false);
    expect(partnerProgramMutationAllowed({ ...base, partnerStatus: "BLOCKED" })).toBe(false);
    expect(partnerProgramMutationAllowed({ ...base, partnerTermsCurrent: false })).toBe(false);
  });
});

describe("PartnerService.loadState", () => {
  function service(pool: Pool, legal: LegalDocuments): PartnerService {
    return new PartnerService(pool, legal);
  }

  it("returns no partner for a User without one", async () => {
    const pool = { query: async () => result([]) } as unknown as Pool;
    const legal = { getCurrent: async () => null } as unknown as LegalDocuments;
    expect(await service(pool, legal).loadState("user-1")).toEqual({ partner: null, partnerTermsReacceptRequired: false });
  });

  it("does not force reacceptance for a non-reaccept-required current document", async () => {
    const legal = { getCurrent: async () => ({ id: "doc-1", version: "v1", requiresReacceptance: false }) } as unknown as LegalDocuments;
    const pool = {
      query: async (sql: string) => sql.includes("FROM partners")
        ? result([{ id: "p1", status: "ACTIVE" }])
        : result([])
    } as unknown as Pool;
    expect(await service(pool, legal).loadState("user-1")).toEqual({
      partner: { id: "p1", status: "ACTIVE" }, partnerTermsReacceptRequired: false
    });
  });

  it("forces reacceptance when a reaccept-required document has no acceptance row", async () => {
    const legal = { getCurrent: async () => ({ id: "doc-1", version: "v1", requiresReacceptance: true }) } as unknown as LegalDocuments;
    const pool = {
      query: async (sql: string) => sql.includes("FROM partners")
        ? result([{ id: "p1", status: "ACTIVE" }])
        : result([])
    } as unknown as Pool;
    expect(await service(pool, legal).loadState("user-1")).toEqual({
      partner: { id: "p1", status: "ACTIVE" }, partnerTermsReacceptRequired: true
    });
  });

  it("clears reacceptance once the current document is accepted", async () => {
    const legal = { getCurrent: async () => ({ id: "doc-1", version: "v1", requiresReacceptance: true }) } as unknown as LegalDocuments;
    const pool = {
      query: async (sql: string) => sql.includes("FROM partners")
        ? result([{ id: "p1", status: "ACTIVE" }])
        : result([{ accepted: 1 }])
    } as unknown as Pool;
    expect(await service(pool, legal).loadState("user-1")).toEqual({
      partner: { id: "p1", status: "ACTIVE" }, partnerTermsReacceptRequired: false
    });
  });
});

describe("PartnerService.onboard", () => {
  const currentDoc = { id: "doc-1", version: "v1", requiresReacceptance: false };

  it("returns stale metadata for a mismatched document without touching the database", async () => {
    const legal = { getCurrent: async () => currentDoc } as unknown as LegalDocuments;
    const connect = vi.fn();
    const pool = { connect } as unknown as Pool;
    const outcome = await new PartnerService(pool, legal).onboard("user-1", "doc-old", "v0");
    expect(outcome).toEqual({ kind: "stale", currentDocument: { id: "doc-1", version: "v1" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("creates the Partner and acceptance atomically on first onboarding", async () => {
    const legal = { getCurrent: async () => currentDoc } as unknown as LegalDocuments;
    const client = makeClient((sql) => {
      if (sql.includes("INSERT INTO partners")) return result([{ id: "p1", status: "ACTIVE" }]);
      return result([]);
    });
    const pool = { connect: async () => client } as unknown as Pool;
    const outcome = await new PartnerService(pool, legal).onboard("user-1", "doc-1", "v1");
    expect(outcome).toEqual({ kind: "ok", partner: { id: "p1", status: "ACTIVE" } });
    const statements = client.queries.map((q) => q.sql);
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements.some((s) => s.includes("INSERT INTO partner_terms_acceptances"))).toBe(true);
  });

  it("is idempotent for an existing Partner and appends acceptance only when absent", async () => {
    const legal = { getCurrent: async () => currentDoc } as unknown as LegalDocuments;
    const client = makeClient((sql) => {
      if (sql.includes("INSERT INTO partners")) return result([]);
      if (sql.includes("FOR UPDATE")) return result([{ id: "p1", status: "BLOCKED" }]);
      return result([]);
    });
    const pool = { connect: async () => client } as unknown as Pool;
    const outcome = await new PartnerService(pool, legal).onboard("user-1", "doc-1", "v1");
    expect(outcome).toEqual({ kind: "ok", partner: { id: "p1", status: "BLOCKED" } });
    const statements = client.queries.map((q) => q.sql);
    expect(statements.some((s) => s.includes("ON CONFLICT DO NOTHING"))).toBe(true);
  });

  it("emits PARTNER_ACTIVATED on first onboarding only", async () => {
    const legal = { getCurrent: async () => currentDoc } as unknown as LegalDocuments;
    const client = makeClient((sql) => {
      if (sql.includes("INSERT INTO partners")) return result([{ id: "p1", status: "ACTIVE" }]);
      return result([]);
    });
    const pool = { connect: async () => client } as unknown as Pool;
    await new PartnerService(pool, legal).onboard("user-1", "doc-1", "v1");
    const event = client.queries.find((q) => q.sql.includes("INSERT INTO events") && q.sql.includes("PARTNER_ACTIVATED"));
    expect(event).toBeTruthy();
    expect(event!.params[3]).toContain('"partnerId":"p1"');
  });

  it("does not emit PARTNER_ACTIVATED on reacceptance", async () => {
    const legal = { getCurrent: async () => currentDoc } as unknown as LegalDocuments;
    const client = makeClient((sql) => {
      if (sql.includes("INSERT INTO partners")) return result([]);
      if (sql.includes("FOR UPDATE")) return result([{ id: "p1", status: "ACTIVE" }]);
      return result([]);
    });
    const pool = { connect: async () => client } as unknown as Pool;
    await new PartnerService(pool, legal).onboard("user-1", "doc-1", "v1");
    const event = client.queries.find((q) => q.sql.includes("INSERT INTO events") && q.sql.includes("PARTNER_ACTIVATED"));
    expect(event).toBeFalsy();
  });
});
