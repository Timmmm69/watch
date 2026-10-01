import type { Pool } from "pg";

/** Refuse retained pre-S12 earning data; never invent historical financial writes. */
export async function verifyS12FinancialData(pool: Pool): Promise<void> {
  const invalid = await pool.query(`
    SELECT i.id FROM order_items i JOIN orders o ON o.id=i.order_id
    LEFT JOIN commissions c ON c.order_item_id=i.id
    WHERE o.commission_eligible_snapshot AND i.partner_commission_unit_snapshot_minor>0
      AND c.id IS NULL
    UNION ALL
    SELECT c.id FROM commissions c JOIN orders o ON o.id=c.order_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(amount_minor) FILTER (WHERE entry_type='COMMISSION_CREATE'),0) AS created,
        COALESCE(-SUM(amount_minor) FILTER (WHERE entry_type='COMMISSION_REVERSAL'),0) AS reversed,
        COALESCE(SUM(amount_minor) FILTER (WHERE bucket='PENDING'),0) AS pending,
        COALESCE(SUM(amount_minor) FILTER (WHERE bucket='AVAILABLE'),0) AS available
      FROM ledger_entries WHERE commission_id=c.id
    ) l ON true
    WHERE l.created<>c.gross_amount_minor OR l.reversed<>c.reversed_amount_minor
      OR (c.state IN ('PENDING','HOLD') AND (l.pending<>c.gross_amount_minor-c.reversed_amount_minor OR l.available<>0))
      OR (c.state='EARNED' AND (l.pending<>0 OR l.available<>c.gross_amount_minor-c.reversed_amount_minor))
      OR (c.state='VOID' AND (c.reversed_amount_minor<>c.gross_amount_minor OR l.pending<>0 OR l.available<>0))
      OR (o.status='COMPLETED' AND c.state NOT IN ('EARNED','VOID'))
      OR (o.status IN ('CANCELLED','DELIVERY_FAILED') AND c.state<>'VOID')
      OR (c.state='HOLD' AND (o.status<>'DELIVERED' OR c.eligible_at IS NULL
        OR o.completion_eligible_at IS NULL OR c.eligible_at IS DISTINCT FROM o.completion_eligible_at))
    LIMIT 1`);
  if (invalid.rowCount) throw new Error("S12 financial data gate failed: reviewed backfill or clean non-production data is required");
}
