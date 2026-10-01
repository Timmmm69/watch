import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LegalDocuments } from "../legal/legal.js";
import { PartnerService } from "./partner.js";
import { ReferralService } from "../referral/referral.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `partner_t39_${randomUUID().replaceAll("-", "")}`;
const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` }) : null;
const docs = [randomUUID(), randomUUID(), randomUUID()];
const userId = randomUUID();
let service: PartnerService, referral: ReferralService;
let partnerId: string;
function configure(index: number) {
  const legal = new LegalDocuments(pool!, { PARTNER_TERMS: { id: docs[index]!, version: `t39-v${index}` } });
  service = new PartnerService(pool!, legal); referral = new ReferralService(pool!, legal, "watch_dev_bot");
}

beforeAll(async () => {
  if (!pool || !admin) return;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL("../../../../packages/db/prisma/migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter((entry) => /^\d/.test(entry)).sort()) {
    await pool.query(await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"));
  }
  await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, 39, 'T39')", [userId]);
  for (let index = 0; index < docs.length; index++) {
    const content = `T39 immutable terms ${index}`;
    await pool.query(`INSERT INTO legal_documents (id, type, version, sha256, content_markdown, effective_at, requires_reacceptance)
      VALUES ($1, 'PARTNER_TERMS', $2, $3, $4, now(), $5)`,
    [docs[index], `t39-v${index}`, createHash("sha256").update(content).digest("hex"), content, index === 2]);
  }
  configure(0);
}, 30_000);

afterAll(async () => {
  if (!pool || !admin) return;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

describe.skipIf(!databaseUrl)("T39 onboarding against migrated PostgreSQL", () => {
  it("rejects stale document identity and version before creating Partner", async () => {
    expect((await service.onboard(userId, docs[1]!, "t39-v1")).kind).toBe("stale");
    expect((await service.onboard(userId, docs[0]!, "stale")).kind).toBe("stale");
    expect((await pool!.query("SELECT count(*)::int AS n FROM partners")).rows[0].n).toBe(0);
  });

  it("concurrent onboarding creates one ACTIVE Partner, acceptance and activation event", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => service.onboard(userId, docs[0]!, "t39-v0")));
    expect(results.every((result) => result.kind === "ok")).toBe(true);
    if (results[0]!.kind !== "ok") throw new Error("Expected Partner");
    partnerId = results[0]!.partner.id;
    for (const result of results) expect(result).toEqual({ kind: "ok", partner: { id: partnerId, status: "ACTIVE" } });
    expect((await pool!.query("SELECT count(*)::int AS n FROM partners")).rows[0].n).toBe(1);
    expect((await pool!.query("SELECT count(*)::int AS n FROM partner_terms_acceptances")).rows[0].n).toBe(1);
    expect((await pool!.query("SELECT count(*)::int AS n FROM events WHERE type = 'PARTNER_ACTIVATED'")).rows[0].n).toBe(1);
  });

  it("new non-reaccept-required document permits referral without synthetic acceptance", async () => {
    configure(1);
    expect((await service.loadState(userId)).partnerTermsReacceptRequired).toBe(false);
    expect((await referral.getOrCreate(userId, null)).status).toBe("ACTIVE");
    expect((await pool!.query("SELECT count(*)::int AS n FROM partner_terms_acceptances WHERE legal_document_id = $1", [docs[1]])).rows[0].n).toBe(0);
  });

  it("required reaccept blocks referral until explicit acceptance, preserving Partner and history", async () => {
    configure(2);
    expect((await service.loadState(userId)).partnerTermsReacceptRequired).toBe(true);
    await expect(referral.getOrCreate(userId, null)).rejects.toMatchObject({ code: "TERMS_REACCEPT_REQUIRED" });
    expect((await service.onboard(userId, docs[1]!, "t39-v1")).kind).toBe("stale");
    expect(await service.onboard(userId, docs[2]!, "t39-v2")).toEqual({ kind: "ok", partner: { id: partnerId, status: "ACTIVE" } });
    expect((await service.loadState(userId)).partnerTermsReacceptRequired).toBe(false);
    expect((await referral.getOrCreate(userId, null)).status).toBe("ACTIVE");
    await service.onboard(userId, docs[2]!, "t39-v2");
    expect((await pool!.query("SELECT count(*)::int AS n FROM partner_terms_acceptances")).rows[0].n).toBe(2);
    expect((await pool!.query("SELECT count(*)::int AS n FROM events WHERE type = 'PARTNER_ACTIVATED'")).rows[0].n).toBe(1);
  });

  it("repeated acceptance cannot unblock a BLOCKED Partner", async () => {
    await pool!.query("UPDATE partners SET status = 'BLOCKED' WHERE id = $1", [partnerId]);
    expect(await service.onboard(userId, docs[2]!, "t39-v2")).toEqual({ kind: "ok", partner: { id: partnerId, status: "BLOCKED" } });
    expect((await service.loadState(userId)).partner?.status).toBe("BLOCKED");
    await expect(referral.getOrCreate(userId, null)).rejects.toMatchObject({ code: "PARTNER_BLOCKED" });
  });
});
