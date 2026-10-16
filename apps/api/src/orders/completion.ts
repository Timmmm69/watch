import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { lockOrderCommissions, releaseCommission } from "../finance/commissions.js";
import { orderMoneyCoverage } from "../finance/coverage.js";

/** Caller holds Partner → Order → OrderItems. Original hold is never restarted. */
export async function releaseUnaffectedCommissions(client: PoolClient, orderId: string, now: Date) {
  const order = (await client.query("SELECT status,completion_eligible_at FROM orders WHERE id=$1", [orderId])).rows[0];
  if (!order || order.status !== "DELIVERED" || !order.completion_eligible_at || order.completion_eligible_at > now) return;
  const blocked = new Set((await client.query<{ order_item_id: string }>(`SELECT ri.order_item_id FROM return_items ri
    JOIN returns r ON r.id=ri.return_id WHERE r.order_id=$1 AND r.status='REQUESTED'`, [orderId])).rows.map(row => row.order_item_id));
  const items = new Map((await client.query<{ id: string; order_item_id: string }>(
    "SELECT id,order_item_id FROM commissions WHERE order_id=$1", [orderId])).rows.map(row => [row.id,row.order_item_id]));
  for (const commission of await lockOrderCommissions(client, orderId)) {
    if (commission.state !== "VOID" && !blocked.has(items.get(commission.id)!)) await releaseCommission(client, commission.id, now);
  }
}

export class OrderCompletionWorker {
  constructor(private readonly pool: Pool) {}

  async completeOrder(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Ownership is immutable. Never claim an Order lock before its Partner lock.
      const owner = (await client.query<{ partner_id_snapshot: string | null }>(
        "SELECT partner_id_snapshot FROM orders WHERE id=$1", [id])).rows[0];
      if (owner?.partner_id_snapshot)
        await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [owner.partner_id_snapshot]);
      const order = (await client.query<{ public_number: string; status: string; economic_regime: string; completion_eligible_at: Date | null }>(
        "SELECT public_number,status,economic_regime,completion_eligible_at FROM orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      // Separate reads after acquiring the lock see Returns committed while we waited.
      const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      if (!order || order.status !== "DELIVERED" || !order.completion_eligible_at || order.completion_eligible_at > now) {
        await client.query("COMMIT");
        return false;
      }
      await client.query("SELECT id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE", [id]);
      await releaseUnaffectedCommissions(client, id, now);
      if (order.economic_regime === "DROPSHIP_MARKUP" && !(await orderMoneyCoverage(client, id)).covered) {
        await client.query("COMMIT");
        return false;
      }
      if ((await client.query("SELECT id FROM returns WHERE order_id=$1 AND status='REQUESTED' LIMIT 1", [id])).rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query("UPDATE orders SET status='COMPLETED',completed_at=$2,updated_at=$2 WHERE id=$1", [id, now]);
      await client.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,created_at)
        VALUES ($1,'ORDER_STATUS_CHANGED','Order',$2,$3,$4,$5)`, [randomUUID(), id,
        `order:${id}:status:COMPLETED`, JSON.stringify({ v: 1, orderId: id, publicNumber: order.public_number,
          fromStatus: "DELIVERED", toStatus: "COMPLETED" }), now]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async run(logger: { error(fields: object, message: string): void }): Promise<void> {
    // Existing partial orders_completion_worker_idx and returns_order_id_status_idx.
    const due = await this.pool.query<{ id: string }>(`SELECT id FROM orders o
      WHERE status='DELIVERED' AND completion_eligible_at<=now()
      ORDER BY completion_eligible_at,id`);
    for (const { id } of due.rows) {
      try { await this.completeOrder(id); }
      catch (error) {
        logger.error({ orderId: id, errorName: error instanceof Error ? error.name : "Unknown" }, "Order completion failed; next execution will retry");
      }
    }
  }
}

/** J-04: run at startup and every five minutes; drain before closing the pool. */
export function startScheduledOrderCompletion(worker: OrderCompletionWorker,
  logger: Parameters<OrderCompletionWorker["run"]>[0]): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (pending) return;
    pending = worker.run(logger).catch((error: unknown) => {
      logger.error({ errorName: error instanceof Error ? error.name : "Unknown" }, "Order completion scan failed; next execution will retry");
    }).finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, 5 * 60 * 1000);
  tick();
  return async () => { clearInterval(timer); await pending; };
}
