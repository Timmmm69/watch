import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { adminPartnerSummarySchema, adminPartnerStateSchema, adminPartnerMutationSchema,
  type AdminPartnerListQuery, type AdminPartnerPageQuery } from "@watch/contracts";
import type { LegalDocuments } from "../legal/legal.js";
import { partnerTermsCurrent, type PartnerStatus } from "./partner.js";

export class AdminPartnerError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "VALIDATION_ERROR") { super(code); }
}

// Correlated aggregates avoid multiplying money by the number of orders/links.
const summarySql = `SELECT p.id, p.status, p.block_reason, p.blocked_at, p.created_at,
  u.id AS user_id, u.telegram_user_id::text, u.first_name, u.last_name, u.username, u.is_blocked,
  (SELECT platform_currency FROM platform_settings WHERE singleton_id=1) AS currency,
  COALESCE((SELECT SUM(amount_minor) FROM ledger_entries WHERE partner_id=p.id AND bucket='PENDING'),0)::text AS pending,
  COALESCE((SELECT SUM(amount_minor) FROM ledger_entries WHERE partner_id=p.id AND bucket='AVAILABLE'),0)::text AS available,
  (SELECT count(*) FROM orders WHERE partner_id_snapshot=p.id)::text AS attributed_orders,
  (SELECT count(*) FROM orders WHERE partner_id_snapshot=p.id AND status='COMPLETED')::text AS completed_orders,
  (SELECT count(*) FROM referral_links WHERE partner_id=p.id AND status='ACTIVE')::text AS active_links
  FROM partners p JOIN users u ON u.id=p.user_id`;
type SummaryRow = { id: string; status: PartnerStatus; block_reason: string | null; blocked_at: Date | null;
  created_at: Date; user_id: string; telegram_user_id: string; first_name: string; last_name: string | null;
  username: string | null; is_blocked: boolean; currency: string; pending: string; available: string;
  attributed_orders: string; completed_orders: string; active_links: string };
function summary(row: SummaryRow) {
  return adminPartnerSummarySchema.parse({ id: row.id, status: row.status, blockReason: row.block_reason,
    blockedAt: row.blocked_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(),
    user: { id: row.user_id, telegramUserId: row.telegram_user_id, firstName: row.first_name,
      lastName: row.last_name, username: row.username, isBlocked: row.is_blocked }, currency: row.currency,
    pendingAmountMinor: Number(row.pending), availableAmountMinor: Number(row.available),
    attributedOrders: Number(row.attributed_orders), completedOrders: Number(row.completed_orders), activeReferralLinks: Number(row.active_links) });
}

export class AdminPartnerService {
  constructor(private readonly pool: Pool, private readonly legal: LegalDocuments) {}

  private async read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async list(query: AdminPartnerListQuery) {
    return this.read(async (client) => {
      // Literal substring search; wildcard characters never expand the search.
      const where = `WHERE ($1::text IS NULL OR p.status::text=$1)
        AND ($2::text IS NULL OR strpos(lower(concat_ws(' ',u.first_name,u.last_name,u.username,u.telegram_user_id::text)),lower($2))>0)`;
      const params = [query.status ?? null, query.search ?? null];
      const total = (await client.query<{ total: string }>(`SELECT count(*)::text AS total
        FROM partners p JOIN users u ON u.id=p.user_id ${where}`, params)).rows[0]!.total;
      const rows = (await client.query<SummaryRow>(`${summarySql} ${where}
        ORDER BY p.created_at DESC,p.id DESC LIMIT $3 OFFSET $4`, [...params, query.limit, (query.page-1)*query.limit])).rows;
      return { items: rows.map(summary), total: Number(total), page: query.page, limit: query.limit };
    });
  }

  async detail(id: string, query: AdminPartnerPageQuery) {
    const current = await this.legal.getCurrent("PARTNER_TERMS");
    if (!current) throw new Error("No current PARTNER_TERMS document is configured");
    return this.read(async (client) => {
      const row = (await client.query<SummaryRow>(`${summarySql} WHERE p.id=$1`, [id])).rows[0];
      if (!row) throw new AdminPartnerError("NOT_FOUND");
      const accepted = (await client.query("SELECT 1 FROM partner_terms_acceptances WHERE partner_id=$1 AND legal_document_id=$2", [id,current.id])).rowCount !== 0;
      const total = (await client.query<{ total: string }>("SELECT count(*)::text AS total FROM referral_links WHERE partner_id=$1", [id])).rows[0]!.total;
      const links = (await client.query<{ id: string; product_id: string | null; status: "ACTIVE" | "DISABLED";
        created_at: Date; disabled_at: Date | null; disable_reason: string | null }>(`SELECT id,product_id,status,created_at,disabled_at,disable_reason
        FROM referral_links WHERE partner_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, [id,query.limit,(query.page-1)*query.limit])).rows;
      const orders = (await client.query<{ id: string; public_number: string; status: string; total_minor: number;
        commission_eligible_snapshot: boolean; created_at: Date }>(`SELECT id,public_number,status,total_minor,commission_eligible_snapshot,created_at
        FROM orders WHERE partner_id_snapshot=$1 ORDER BY created_at DESC,id DESC LIMIT 10`, [id])).rows;
      const counts = (await client.query<{ status: string; n: string }>("SELECT status,count(*)::text AS n FROM payouts WHERE partner_id=$1 GROUP BY status", [id])).rows;
      const payouts = (await client.query<{ id: string; status: "REQUESTED" | "PAID" | "REJECTED"; amount_minor: number; requested_at: Date }>(
        "SELECT id,status,amount_minor,requested_at FROM payouts WHERE partner_id=$1 ORDER BY requested_at DESC,id DESC LIMIT 10", [id])).rows;
      return { ...summary(row), partnerTermsReacceptRequired: !partnerTermsCurrent(current.requiresReacceptance,accepted),
        referralLinks: { ...query, total: Number(total), items: links.map(l => ({ id: l.id, productId: l.product_id, status: l.status,
          createdAt: l.created_at.toISOString(), disabledAt: l.disabled_at?.toISOString() ?? null, disableReason: l.disable_reason })) },
        recentOrders: orders.map(o => ({ id: o.id, publicNumber: o.public_number, status: o.status, totalMinor: o.total_minor,
          commissionEligible: o.commission_eligible_snapshot, createdAt: o.created_at.toISOString() })),
        payouts: { requested: Number(counts.find(c => c.status === "REQUESTED")?.n ?? 0),
          paid: Number(counts.find(c => c.status === "PAID")?.n ?? 0), rejected: Number(counts.find(c => c.status === "REJECTED")?.n ?? 0),
          recent: payouts.map(p => ({ id: p.id, status: p.status, amountMinor: p.amount_minor, requestedAt: p.requested_at.toISOString() })) } };
    });
  }

  async setStatus(actorId: string, id: string, target: PartnerStatus, reason: string, requestId: string) {
    const input = adminPartnerMutationSchema.safeParse({ reason });
    if (!input.success) throw new AdminPartnerError("VALIDATION_ERROR");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Same authoritative row as checkout/referral/payout eligibility.
      const before = (await client.query<{ status: PartnerStatus }>("SELECT status FROM partners WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!before) throw new AdminPartnerError("NOT_FOUND");
      if (before.status !== target) {
        await client.query(`UPDATE partners SET status=$2::text::"PartnerStatus", block_reason=CASE WHEN $2='BLOCKED' THEN $3 ELSE NULL END,
          blocked_at=CASE WHEN $2='BLOCKED' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`, [id,target,input.data.reason]);
        await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,metadata)
          VALUES ($1,$2,$3,'Partner',$4,$5::jsonb)`, [randomUUID(),actorId,target === "BLOCKED" ? "PARTNER_BLOCKED" : "PARTNER_UNBLOCKED",id,
          JSON.stringify({ reason: input.data.reason, from: before.status, to: target, requestId })]);
      }
      const row = (await client.query<{ id: string; status: PartnerStatus; block_reason: string | null; blocked_at: Date | null }>(
        "SELECT id,status,block_reason,blocked_at FROM partners WHERE id=$1", [id])).rows[0]!;
      const result = adminPartnerStateSchema.parse({ id: row.id,status: row.status,blockReason: row.block_reason,blockedAt: row.blocked_at?.toISOString() ?? null });
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
