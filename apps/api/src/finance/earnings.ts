import type { Pool } from "pg";
import { partnerEarningsResponseSchema, type PartnerEarningsQuery } from "@watch/contracts";

export class PartnerEarningsService {
  constructor(private readonly pool: Pool) {}

  async list(partnerId: string, query: PartnerEarningsQuery) {
    const client = await this.pool.connect();
    try {
      // Balances, total and history must describe the same committed snapshot.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const balances = (await client.query<{ currency: string; pending: string; available: string }>(`
        SELECT platform_currency AS currency,
          COALESCE((SELECT SUM(amount_minor) FROM ledger_entries WHERE partner_id=$1 AND bucket='PENDING'),0)::text AS pending,
          COALESCE((SELECT SUM(amount_minor) FROM ledger_entries WHERE partner_id=$1 AND bucket='AVAILABLE'),0)::text AS available
        FROM platform_settings WHERE singleton_id=1`, [partnerId])).rows[0];
      if (!balances) throw new Error("Platform currency is not initialized");
      const total = (await client.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM commissions WHERE partner_id=$1", [partnerId])).rows[0]!.total;
      const rows = (await client.query<{
        id: string; public_number: string; state: "PENDING" | "HOLD" | "EARNED" | "VOID";
        gross_amount_minor: number; reversed_amount_minor: number; earned: string; locked: string; paid: string;
        created_at: Date; updated_at: Date; eligible_at: Date | null; available_at: Date | null;
      }>(`SELECT c.id,o.public_number,c.state,c.gross_amount_minor,c.reversed_amount_minor,
          c.created_at,c.updated_at,c.eligible_at,c.available_at,
          COALESCE((SELECT SUM(l.amount_minor) FROM ledger_entries l
            WHERE l.commission_id=c.id AND l.bucket='AVAILABLE'),0)::text AS earned,
          COALESCE((SELECT SUM(a.amount_minor) FROM payout_allocations a JOIN payouts p ON p.id=a.payout_id
            WHERE a.commission_id=c.id AND p.status='REQUESTED'),0)::text AS locked,
          COALESCE((SELECT SUM(a.amount_minor) FROM payout_allocations a JOIN payouts p ON p.id=a.payout_id
            WHERE a.commission_id=c.id AND p.status='PAID'),0)::text AS paid
        FROM commissions c JOIN orders o ON o.id=c.order_id
        WHERE c.partner_id=$1 ORDER BY c.updated_at DESC,c.id DESC LIMIT $2 OFFSET $3`,
      [partnerId,query.limit,(query.page-1)*query.limit])).rows;
      const result = partnerEarningsResponseSchema.parse({
        currency: balances.currency, pendingAmountMinor: Number(balances.pending),
        availableAmountMinor: Number(balances.available), total: Number(total), ...query,
        items: rows.map((row) => ({ id: row.id, orderPublicNumber: row.public_number, state: row.state,
          grossAmountMinor: row.gross_amount_minor, reversedAmountMinor: row.reversed_amount_minor,
          netEarnedAmountMinor: Number(row.earned), lockedAmountMinor: Number(row.locked), paidAmountMinor: Number(row.paid), createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(), eligibleAt: row.eligible_at?.toISOString() ?? null,
          availableAt: row.available_at?.toISOString() ?? null }))
      });
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
