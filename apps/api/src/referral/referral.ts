import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LegalDocuments } from "../legal/legal.js";
import { partnerProgramMutationAllowed, partnerTermsCurrent, type PartnerStatus } from "../partner/partner.js";
import type { CurrentUser } from "../auth/session.js";
import type { TelegramIdentity } from "../auth/telegram.js";

interface PartnerRow { id: string; status: PartnerStatus; user_id: string }
interface LinkRow { id: string; token: string; partner_id: string; product_id: string | null; status: "ACTIVE" | "DISABLED" }
interface ProductRow { id: string; slug: string; status: string }
export interface ReferralLinkView { id: string; productId: string | null; status: "ACTIVE" | "DISABLED"; url: string }
export interface AttributionSelection { id: string; partnerId: string; referralLinkId: string }

export class ReferralError extends Error {
  constructor(public readonly code: "PARTNER_REQUIRED" | "PARTNER_BLOCKED" | "TERMS_REACCEPT_REQUIRED" | "PRODUCT_NOT_ACTIVE" | "NOT_FOUND") { super(code); }
}

function isUniqueConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "23505";
}

export class ReferralService {
  constructor(private readonly pool: Pool, private readonly legal: LegalDocuments, private readonly botUsername: string) {}

  private view(row: LinkRow): ReferralLinkView {
    return { id: row.id, productId: row.product_id, status: row.status,
      url: `https://t.me/${this.botUsername}?startapp=r_${row.token}` };
  }

  async latestValidTouch(client: PoolClient, buyerUserId: string): Promise<AttributionSelection | null> {
    const found = await client.query<{ id: string; partner_id: string; referral_link_id: string }>(`
      SELECT id, partner_id, referral_link_id FROM attribution_touches
      WHERE buyer_user_id = $1 AND expires_at > now()
      ORDER BY occurred_at DESC, id DESC LIMIT 1
    `, [buyerUserId]);
    const row = found.rows[0];
    return row ? { id: row.id, partnerId: row.partner_id, referralLinkId: row.referral_link_id } : null;
  }

  private async termsCurrent(client: PoolClient, partnerId: string): Promise<boolean> {
    const current = await this.legal.getCurrent("PARTNER_TERMS");
    if (!current) return false;
    const acceptance = await client.query(
      "SELECT 1 FROM partner_terms_acceptances WHERE partner_id = $1 AND legal_document_id = $2", [partnerId, current.id]);
    return partnerTermsCurrent(current.requiresReacceptance, acceptance.rowCount !== 0);
  }

  private async requireEligible(client: PoolClient, partner: PartnerRow): Promise<void> {
    const user = await client.query<{ is_blocked: boolean }>("SELECT is_blocked FROM users WHERE id = $1", [partner.user_id]);
    const userBlocked = user.rows[0]?.is_blocked ?? true;
    const termsCurrent = await this.termsCurrent(client, partner.id);
    if (partnerProgramMutationAllowed({ userBlocked, partnerStatus: partner.status, partnerTermsCurrent: termsCurrent })) return;
    throw new ReferralError(userBlocked || partner.status !== "ACTIVE" ? "PARTNER_BLOCKED" : "TERMS_REACCEPT_REQUIRED");
  }

  async getOrCreate(userId: string, productId: string | null): Promise<ReferralLinkView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<PartnerRow>(`
      SELECT p.id, p.status, p.user_id FROM partners p
        WHERE p.user_id = $1 FOR UPDATE OF p
      `, [userId]);
      const partner = selected.rows[0];
      if (!partner) throw new ReferralError("PARTNER_REQUIRED");
      await this.requireEligible(client, partner);
      const findActive = () => client.query<LinkRow>(`
        SELECT id, token, partner_id, product_id, status FROM referral_links
        WHERE partner_id = $1 AND product_id IS NOT DISTINCT FROM $2::uuid AND status = 'ACTIVE'
        FOR UPDATE
      `, [partner.id, productId]);
      let link = (await findActive()).rows[0];
      if (productId) {
        const product = (await client.query<ProductRow>(
          "SELECT id, slug, status FROM products WHERE id = $1 FOR UPDATE", [productId])).rows[0];
        if (!product || product.status !== "ACTIVE") throw new ReferralError("PRODUCT_NOT_ACTIVE");
      }
      if (!link) {
        await client.query("SAVEPOINT referral_create");
        try {
          const created = await client.query<LinkRow>(`
            INSERT INTO referral_links (id, token, partner_id, product_id)
            VALUES ($1, $2, $3, $4)
            RETURNING id, token, partner_id, product_id, status
          `, [randomUUID(), randomBytes(24).toString("base64url"), partner.id, productId]);
          link = created.rows[0];
          await client.query("RELEASE SAVEPOINT referral_create");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT referral_create");
          if (!isUniqueConflict(error)) throw error;
          link = (await findActive()).rows[0];
          if (!link) throw error;
        }
      }
      if (!link) throw new Error("Referral link creation failed");
      await client.query("COMMIT");
      return this.view(link);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async disable(adminUserId: string, linkId: string, reason: string): Promise<ReferralLinkView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const link = (await client.query<LinkRow>(
        "SELECT id, token, partner_id, product_id, status FROM referral_links WHERE id = $1 FOR UPDATE", [linkId])).rows[0];
      if (!link) throw new ReferralError("NOT_FOUND");
      if (link.status === "ACTIVE") {
        await client.query(`UPDATE referral_links SET status = 'DISABLED', disabled_at = now(),
          disabled_by_admin_user_id = $1, disable_reason = $2 WHERE id = $3`, [adminUserId, reason, linkId]);
        await client.query(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata)
          VALUES ($1, $2, 'REFERRAL_LINK_DISABLED', 'ReferralLink', $3, $4::jsonb)`,
        [randomUUID(), adminUserId, linkId, JSON.stringify({ reason })]);
        link.status = "DISABLED";
      }
      await client.query("COMMIT");
      return this.view(link);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async processLaunch(client: PoolClient, buyer: CurrentUser, identity: TelegramIdentity): Promise<string | null> {
    const value = identity.startParam;
    if (!value?.startsWith("r_") || !/^r_[A-Za-z0-9_-]{32}$/.test(value)) return null;
    const replay = await client.query("SELECT 1 FROM attribution_touches WHERE source_fingerprint = $1", [identity.replayIdentity]);
    if (replay.rowCount) return null;
    const candidate = (await client.query<LinkRow>(
      "SELECT id, token, partner_id, product_id, status FROM referral_links WHERE token = $1", [value.slice(2)])).rows[0];
    if (!candidate) return null;
    const partner = (await client.query<PartnerRow>(`
      SELECT p.id, p.status, p.user_id FROM partners p
      WHERE p.id = $1 FOR UPDATE OF p
    `, [candidate.partner_id])).rows[0];
    if (!partner) return null;
    const link = (await client.query<LinkRow>(
      "SELECT id, token, partner_id, product_id, status FROM referral_links WHERE id = $1 FOR UPDATE", [candidate.id])).rows[0];
    if (!link || link.status !== "ACTIVE" || link.token !== value.slice(2) || link.partner_id !== partner.id) return null;
    let product: ProductRow | undefined;
    if (link.product_id) {
      product = (await client.query<ProductRow>(
        "SELECT id, slug, status FROM products WHERE id = $1 FOR UPDATE", [link.product_id])).rows[0];
      if (!product || product.status !== "ACTIVE") return null;
    }
    if (partner.user_id === buyer.id) {
      await client.query(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id)
        VALUES ($1, $2, 'SELF_REFERRAL_ATTEMPT', 'ReferralLink', $3)`, [randomUUID(), buyer.id, link.id]);
      return null;
    }
    const partnerUser = await client.query<{ is_blocked: boolean }>("SELECT is_blocked FROM users WHERE id = $1", [partner.user_id]);
    if (!partnerProgramMutationAllowed({ userBlocked: partnerUser.rows[0]?.is_blocked ?? true, partnerStatus: partner.status,
      partnerTermsCurrent: await this.termsCurrent(client, partner.id) })) return null;
    await client.query(`INSERT INTO attribution_touches
      (id, buyer_user_id, partner_id, referral_link_id, source_fingerprint, occurred_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, now(), now() + interval '30 days')`,
    [randomUUID(), buyer.id, partner.id, link.id, identity.replayIdentity]);
    return product ? `/shop?product=${encodeURIComponent(product.slug)}` : "/shop";
  }
}
