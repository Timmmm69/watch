import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

// Caller serializes Partner -> Order. Read fresh facts only AFTER acquiring locks.
export async function orderMoneyCoverage(client: PoolClient, orderId: string) {
  const order = (await client.query("SELECT economic_regime,status FROM orders WHERE id=$1", [orderId])).rows[0];
  const retained = (await client.query(`SELECT COALESCE(sum(oi.customer_unit_price_minor::bigint * (oi.quantity-
    COALESCE((SELECT sum(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id
      WHERE ri.order_item_id=oi.id AND r.status='COMPLETED'),0))),0)::text AS amount
    FROM order_items oi WHERE oi.order_id=$1`, [orderId])).rows[0]!.amount;
  const cash = (await client.query("SELECT COALESCE(sum(amount_minor),0)::text AS amount FROM order_money_entries WHERE order_id=$1", [orderId])).rows[0]!.amount;
  const obligations = (await client.query(`SELECT o.id,o.kind,(o.amount_minor::bigint+
    COALESCE((SELECT sum(a.amount_minor) FROM customer_obligations a WHERE a.adjusts_obligation_id=o.id),0)+
    COALESCE((SELECT sum(m.amount_minor) FROM order_money_entries m WHERE m.obligation_id=o.id),0))::text AS outstanding
    FROM customer_obligations o WHERE o.order_id=$1 AND o.kind<>'ADJUSTMENT' ORDER BY o.created_at,o.id`, [orderId])).rows;
  const outstanding = obligations.reduce((sum, row) => sum + BigInt(row.outstanding), 0n);
  const retainedSales = ["CANCELLED", "DELIVERY_FAILED"].includes(order?.status) ? 0n : BigInt(retained);
  return { cashMinor: Number(cash), retainedSalesMinor: Number(retainedSales), outstandingMinor: Number(outstanding),
    covered: order?.economic_regime !== "DROPSHIP_MARKUP" || BigInt(cash) - outstanding >= retainedSales,
    obligations: obligations.map(row => ({ id: row.id as string, kind: row.kind as string, outstandingMinor: Number(row.outstanding) })) };
}

// Overpayment is a liability. Reconcile by appending facts, never rewriting cash/history.
export async function reconcileOverpayment(client: PoolClient, orderId: string, actor: string, now: Date) {
  const facts = await orderMoneyCoverage(client, orderId);
  const excess = Math.max(0, facts.cashMinor - facts.retainedSalesMinor - facts.outstandingMinor);
  if (excess) await client.query(`INSERT INTO customer_obligations
    (id,order_id,operation_key,kind,amount_minor,actor_user_id,reason,occurred_at)
    VALUES($1,$2,$3,'OVERPAYMENT',$4,$5,'Observed excess cash', $6)`,
  [randomUUID(), orderId, `overpayment:${randomUUID()}`, excess, actor, now]);
  let reduction = Math.max(0, facts.retainedSalesMinor + facts.outstandingMinor - facts.cashMinor);
  for (const obligation of facts.obligations.filter(row => row.kind === "OVERPAYMENT" && row.outstandingMinor > 0)) {
    const amount = Math.min(reduction, obligation.outstandingMinor);
    if (!amount) break;
    await client.query(`INSERT INTO customer_obligations
      (id,order_id,operation_key,kind,amount_minor,adjusts_obligation_id,actor_user_id,reason,occurred_at)
      VALUES($1,$2,$3,'ADJUSTMENT',$4,$5,$6,'Reconcile excess cash',$7)`,
    [randomUUID(), orderId, `overpayment-adjustment:${randomUUID()}`, -amount, obligation.id, actor, now]);
    reduction -= amount;
  }
}

export async function commissionPayable(client: PoolClient, id: string, now: Date) {
  const row = (await client.query(`SELECT c.*,o.economic_regime,o.status,o.delivered_at,o.completion_eligible_at,
    EXISTS(SELECT 1 FROM return_items ri JOIN returns r ON r.id=ri.return_id
      WHERE ri.order_item_id=c.order_item_id AND r.status='REQUESTED') AS blocked
    FROM commissions c JOIN orders o ON o.id=c.order_id WHERE c.id=$1`, [id])).rows[0];
  if (!row) return false;
  if (row.economic_regime !== "DROPSHIP_MARKUP") return true;
  return ["DELIVERED", "COMPLETED"].includes(row.status) && !!row.delivered_at
    && !!row.completion_eligible_at && row.completion_eligible_at <= now
    && !!row.eligible_at && row.eligible_at <= now && !row.blocked
    && (await orderMoneyCoverage(client, row.order_id)).covered;
}
