import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSupplier } from "../catalog/catalog.js";
import type { CurrentUser } from "../auth/session.js";
import type { TelegramIdentity } from "../auth/telegram.js";
import type { LegalDocuments } from "../legal/legal.js";
import { ReferralError, ReferralService } from "./referral.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const ids = { partnerUser: randomUUID(), otherUser: randomUUID(), buyer: randomUUID(), admin: randomUUID(),
  partner: randomUUID(), otherPartner: randomUUID(), product: randomUUID(), document: randomUUID() };
const token = randomBytes(4).toString("hex");
const legal = { getCurrent: async () => ({ id: ids.document, requiresReacceptance: true }) } as unknown as LegalDocuments;
const referral = pool ? new ReferralService(pool, legal, "watch_dev_bot") : null;
let productLinkId = "";
let genericLinkId = "";
let genericToken = "";
const buyer: CurrentUser = { id: ids.buyer, telegramUserId: "1", firstName: "Buyer", lastName: null,
  username: null, languageCode: null, isAdmin: false, isBlocked: false };

function identity(startParam: string, replayIdentity = randomBytes(32).toString("hex")): TelegramIdentity {
  return { telegramUserId: "1", firstName: "Buyer", lastName: null, username: null,
    languageCode: null, startParam, replayIdentity };
}

beforeAll(async () => {
  if (!pool) return;
  const supplier = await seedSupplier(pool, "Referral test supplier");
  for (const [id, offset] of [[ids.partnerUser, 1], [ids.buyer, 2], [ids.admin, 3], [ids.otherUser, 4]] as const) {
    await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1, $2, 'Referral test')",
      [id, (BigInt(Date.now()) * 100000n + BigInt(offset) * 10000n + BigInt(`0x${token}`) % 10000n).toString()]);
  }
  await pool.query("INSERT INTO partners (id, user_id) VALUES ($1, $2)", [ids.partner, ids.partnerUser]);
  await pool.query("INSERT INTO partners (id, user_id) VALUES ($1, $2)", [ids.otherPartner, ids.otherUser]);
  await pool.query(`INSERT INTO legal_documents
    (id, type, version, sha256, content_markdown, effective_at, requires_reacceptance)
    VALUES ($1, 'PARTNER_TERMS', $2, $3, 'Referral test terms', now(), true)`, [ids.document, token, randomBytes(32).toString("hex")]);
  await pool.query("INSERT INTO partner_terms_acceptances (partner_id, legal_document_id) VALUES ($1, $2)", [ids.partner, ids.document]);
  await pool.query(`INSERT INTO products (id, supplier_id, title, slug, status)
    VALUES ($1, $2, 'Referral test product', $3, 'ACTIVE')`, [ids.product, supplier.supplierId, `referral-${token}`]);
});

afterAll(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM attribution_touches WHERE buyer_user_id = $1", [ids.buyer]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])", [[ids.buyer, ids.admin, ids.partnerUser]]);
  await pool.query("DELETE FROM referral_links WHERE partner_id = $1", [ids.partner]);
  await pool.query("DELETE FROM partner_terms_acceptances WHERE partner_id = $1", [ids.partner]);
  await pool.query("DELETE FROM legal_documents WHERE id = $1", [ids.document]);
  await pool.query("DELETE FROM partners WHERE id = $1", [ids.partner]);
  await pool.query("DELETE FROM partners WHERE id = $1", [ids.otherPartner]);
  await pool.query("DELETE FROM products WHERE id = $1", [ids.product]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[ids.partnerUser, ids.otherUser, ids.buyer, ids.admin]]);
  await pool.end();
});

describe.skipIf(!databaseUrl)("Referral attribution against PostgreSQL", () => {
  it("creates one active link per scope and rotates after an audited disable", async () => {
    const [first, same] = await Promise.all([
      referral!.getOrCreate(ids.partnerUser, null), referral!.getOrCreate(ids.partnerUser, null)
    ]);
    expect(same.id).toBe(first.id);
    genericLinkId = first.id;
    genericToken = first.url.split("r_")[1]!;
    expect(genericToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const product = await referral!.getOrCreate(ids.partnerUser, ids.product);
    productLinkId = product.id;
    expect(product.productId).toBe(ids.product);
    expect((await referral!.disable(ids.admin, first.id, "Compromised")).status).toBe("DISABLED");
    expect((await referral!.disable(ids.admin, first.id, "Repeat")).status).toBe("DISABLED");
    const rotated = await referral!.getOrCreate(ids.partnerUser, null);
    expect(rotated.id).not.toBe(first.id);
    expect(rotated.url).not.toBe(first.url);
    expect((await pool!.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'REFERRAL_LINK_DISABLED'", [first.id])).rows[0].n).toBe(1);
  });

  it("serializes launch under Buyer lock and preserves valid history on invalid launches", async () => {
    const productToken = (await pool!.query<{ token: string }>("SELECT token FROM referral_links WHERE id = $1", [productLinkId])).rows[0]!.token;
    const launch = identity(`r_${productToken}`);
    const run = async () => {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ids.buyer]);
        const target = await referral!.processLaunch(client, buyer, launch);
        await client.query("COMMIT");
        return target;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    };
    const [first, repeated] = await Promise.all([run(), run()]);
    expect([first, repeated]).toContain(`/shop?product=referral-${token}`);
    expect([first, repeated]).toContain(null);
    const touches = await pool!.query("SELECT id FROM attribution_touches WHERE buyer_user_id = $1", [ids.buyer]);
    expect(touches.rowCount).toBe(1);
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ids.buyer]);
      expect(await referral!.processLaunch(client, buyer, identity(`r_${genericToken}`))).toBeNull();
      await client.query("COMMIT");
    } finally { client.release(); }
    expect((await pool!.query("SELECT count(*)::int AS n FROM attribution_touches WHERE buyer_user_id = $1", [ids.buyer])).rows[0].n).toBe(1);
    const replacement = await referral!.getOrCreate(ids.partnerUser, null);
    const latestClient = await pool!.connect();
    try {
      await latestClient.query("BEGIN");
      await latestClient.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ids.buyer]);
      expect(await referral!.processLaunch(latestClient, buyer, identity(`r_${replacement.url.split("r_")[1]}`))).toBe("/shop");
      const latest = await referral!.latestValidTouch(latestClient, ids.buyer);
      expect(latest?.referralLinkId).toBe(replacement.id);
      await latestClient.query("COMMIT");
      await pool!.query(`UPDATE attribution_touches SET occurred_at = now() - interval '31 days',
        expires_at = now() - interval '1 day' WHERE id = $1`, [latest!.id]);
      expect((await referral!.latestValidTouch(latestClient, ids.buyer))?.referralLinkId).toBe(productLinkId);
    } finally { latestClient.release(); }
  });

  it("audits self-referral without creating a touch", async () => {
    const productToken = (await pool!.query<{ token: string }>("SELECT token FROM referral_links WHERE id = $1", [productLinkId])).rows[0]!.token;
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ids.partnerUser]);
      expect(await referral!.processLaunch(client, { ...buyer, id: ids.partnerUser }, identity(`r_${productToken}`))).toBeNull();
      await client.query("COMMIT");
    } finally { client.release(); }
    expect((await pool!.query("SELECT count(*)::int AS n FROM attribution_touches WHERE buyer_user_id = $1", [ids.partnerUser])).rows[0].n).toBe(0);
    expect((await pool!.query("SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id = $1 AND action = 'SELF_REFERRAL_ATTEMPT'", [ids.partnerUser])).rows[0].n).toBe(1);
  });

  it("rejects blocked, stale terms and archived scopes, and enforces link-owner integrity", async () => {
    await pool!.query("UPDATE partners SET status = 'BLOCKED' WHERE id = $1", [ids.partner]);
    await expect(referral!.getOrCreate(ids.partnerUser, null)).rejects.toMatchObject({ code: "PARTNER_BLOCKED" } satisfies Partial<ReferralError>);
    const blockedLink = (await pool!.query<{ token: string }>("SELECT token FROM referral_links WHERE id = $1", [productLinkId])).rows[0]!.token;
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ids.buyer]);
      expect(await referral!.processLaunch(client, buyer, identity(`r_${blockedLink}`))).toBeNull();
      await client.query("COMMIT");
    } finally { client.release(); }
    await pool!.query("UPDATE partners SET status = 'ACTIVE' WHERE id = $1", [ids.partner]);
    await pool!.query("DELETE FROM partner_terms_acceptances WHERE partner_id = $1", [ids.partner]);
    await expect(referral!.getOrCreate(ids.partnerUser, null)).rejects.toMatchObject({ code: "TERMS_REACCEPT_REQUIRED" });
    await pool!.query("INSERT INTO partner_terms_acceptances (partner_id, legal_document_id) VALUES ($1, $2)", [ids.partner, ids.document]);
    await pool!.query("UPDATE products SET status = 'ARCHIVED' WHERE id = $1", [ids.product]);
    await expect(referral!.getOrCreate(ids.partnerUser, ids.product)).rejects.toMatchObject({ code: "PRODUCT_NOT_ACTIVE" });
    const archivedClient = await pool!.connect();
    try {
      await archivedClient.query("BEGIN");
      await archivedClient.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ids.buyer]);
      expect(await referral!.processLaunch(archivedClient, buyer, identity(`r_${blockedLink}`))).toBeNull();
      await archivedClient.query("COMMIT");
    } finally { archivedClient.release(); }
    await expect(pool!.query(`INSERT INTO attribution_touches
      (id, buyer_user_id, partner_id, referral_link_id, source_fingerprint, expires_at)
      VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
      [randomUUID(), ids.buyer, ids.otherPartner, genericLinkId, randomBytes(32).toString("hex")]))
      .rejects.toMatchObject({ code: "23503" });
  });
});
