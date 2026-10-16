import type { Pool, PoolClient } from "pg";
import { ownerReportSchema, ownerWorkSchema, type AnalyticsQuery, type OwnerQueue,
  type OwnerReport, type OwnerWork } from "@watch/contracts";
import { commissionPayable } from "../finance/coverage.js";

// Shared by counter and paginated queue: no UI-only approximation of membership.
const workFacts = `WITH stock AS (
  SELECT v.id,p.id AS product_id,v.sku,p.title,i.*,
    COALESCE((SELECT sum(r.quantity) FROM inventory_reservations r WHERE r.variant_id=v.id AND r.status='ACTIVE'),0) AS reserved
  FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN inventory_items i ON i.variant_id=v.id),
  retained AS (SELECT oi.order_id,sum(oi.customer_unit_price_minor::bigint*(oi.quantity-COALESCE((
    SELECT sum(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id
    WHERE ri.order_item_id=oi.id AND r.status='COMPLETED'),0))) AS sales FROM order_items oi GROUP BY oi.order_id),
  cash AS (SELECT order_id,sum(amount_minor) AS amount FROM order_money_entries GROUP BY order_id),
  owed AS (SELECT o.order_id,sum(o.amount_minor+COALESCE((SELECT sum(m.amount_minor) FROM order_money_entries m
    WHERE m.obligation_id=o.id),0)) AS amount FROM customer_obligations o GROUP BY o.order_id)`;
const workSelects: Record<OwnerQueue, string> = {
  new: `SELECT o.id::text,o.public_number AS label,o.status::text AS detail,'/admin/orders/'||o.id AS href
    FROM orders o WHERE o.status='PLACED'`,
  overdue: `SELECT o.id::text,o.public_number AS label,o.status::text AS detail,'/admin/orders/'||o.id AS href
    FROM orders o WHERE o.status IN ('PLACED','CONFIRMED','FULFILLING','SHIPPED')
    AND COALESCE(o.shipped_at,o.fulfilling_at,o.confirmed_at,o.created_at)<=now()-$1::int*interval '1 second'
    AND NOT(o.economic_regime='DROPSHIP_MARKUP' AND o.status='SHIPPED'
      AND NOT EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.quantity>COALESCE((
        SELECT sum(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id
        WHERE ri.order_item_id=i.id AND r.status='COMPLETED'),0)))`,
  unpaid: `SELECT o.id::text,o.public_number AS label,'Недостающее покрытие: '||
    (r.sales-COALESCE(c.amount,0)+COALESCE(d.amount,0))::text||' коп.' AS detail,'/admin/orders/'||o.id AS href
    FROM orders o JOIN retained r ON r.order_id=o.id LEFT JOIN cash c ON c.order_id=o.id LEFT JOIN owed d ON d.order_id=o.id
    WHERE o.economic_regime='DROPSHIP_MARKUP' AND o.status IN ('DELIVERED','COMPLETED')
    AND COALESCE(c.amount,0)-COALESCE(d.amount,0)<r.sales`,
  returns: `SELECT r.id::text,o.public_number AS label,r.status::text||' · '||r.reason AS detail,'/admin/returns/'||r.id AS href
    FROM returns r JOIN orders o ON o.id=r.order_id WHERE r.status='REQUESTED' OR (r.status='COMPLETED'
    AND o.economic_regime='DROPSHIP_MARKUP' AND (EXISTS(SELECT 1 FROM return_items ri WHERE ri.return_id=r.id
      AND ri.quantity>COALESCE((SELECT sum(m.quantity) FROM inventory_movements m WHERE m.return_item_id=ri.id
        AND m.kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS')),0)) OR EXISTS(SELECT 1 FROM customer_obligations d
      WHERE d.return_id=r.id AND d.kind='RETURN_REFUND' AND d.amount_minor+COALESCE((SELECT sum(m.amount_minor)
        FROM order_money_entries m WHERE m.obligation_id=d.id),0)>0)))`,
  payouts: `SELECT p.id::text,'Выплата '||p.amount_minor::text||' коп.' AS label,p.partner_id::text AS detail,
    '/admin/payouts/'||p.id AS href FROM payouts p WHERE p.status='REQUESTED'`,
  inventory: `SELECT id::text,sku AS label,CASE WHEN native_initialization_id IS NULL THEN 'Не инициализирован'
    ELSE 'Дефицит или несогласованные резервы' END AS detail,'/admin/products/'||product_id AS href FROM stock
    WHERE native_initialization_id IS NULL OR native_on_hand<reserved+safety_buffer
      OR native_reserved_quantity IS DISTINCT FROM reserved OR EXISTS(SELECT 1 FROM inventory_reservations r
        JOIN orders o ON o.id=r.order_id WHERE r.variant_id=stock.id AND r.status='ACTIVE'
        AND o.status IN ('SHIPPED','DELIVERED','COMPLETED','DELIVERY_FAILED','CANCELLED'))`
};

type Contribution = OwnerReport["cohort"]["contribution"];
const contribution = (): Contribution => ({ closedOrders: 0, coveredOrders: 0, coveredMinor: null, fullMinor: null, coverageRate: null });
function addContribution(target: Contribution, closed: boolean, value: number | null) {
  if (!closed) return;
  target.closedOrders++;
  if (value !== null) { target.coveredOrders++; target.coveredMinor = (target.coveredMinor ?? 0) + value; }
  target.coverageRate = target.coveredOrders / target.closedOrders;
  target.fullMinor = target.closedOrders === target.coveredOrders ? target.coveredMinor : null;
}
const result = (): OwnerReport["cohort"] => ({ orders: 0, unfinishedOrders: 0, deliveredOrders: 0,
  retainedOrders: 0, retainedUnits: 0, retainedRMinor: 0, retainedDMinor: 0, markupMinor: 0,
  cancelledOrders: 0, failedOrders: 0, returnedOrders: 0, returnedUnits: 0, createdValueRMinor: 0,
  cancellationRate: null, returnRate: null, contribution: contribution() });
const obligations = (): OwnerReport["obligations"] => ({ pendingMinor: 0, availableMinor: 0, lockedMinor: 0,
  paidMinor: 0, debtMinor: 0, payoutBlocked: false });
type Line = { id: string; variant_id: string; quantity: number; dropship_unit_price_minor: number;
  customer_unit_price_minor: number; allocated_procurement_cost_minor: number | null;
  returned: string; inspected: string; recovered: string; has_unknown_recovery: boolean; requested: boolean };

export class OwnerAnalyticsService {
  constructor(private readonly pool: Pool, private readonly currency: string, private readonly overdueSeconds?: number) {}

  private async snapshot<T>(read: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const value = await read(client); await client.query("COMMIT"); return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  work(query: { queue: OwnerQueue; page: number; limit: number }): Promise<OwnerWork> {
    return this.snapshot(async client => {
      const sql = `${workFacts}, work AS (${workSelects[query.queue]})`;
      // Always bind SLA, even in queues that do not reference it.
      const bind = `, settings AS (SELECT $1::int AS sla)`;
      const total = Number((await client.query(`${sql}${bind} SELECT count(*) FROM work`, [this.overdueSeconds ?? null])).rows[0].count);
      const items = (await client.query(`${sql}${bind} SELECT * FROM work ORDER BY label,id LIMIT $2 OFFSET $3`,
        [this.overdueSeconds ?? null, query.limit, (query.page-1)*query.limit])).rows;
      return ownerWorkSchema.parse({ ...query, total, items });
    });
  }

  report(query: AnalyticsQuery): Promise<OwnerReport> {
    return this.snapshot(async client => {
      const asOf = (await client.query("SELECT now() AS now")).rows[0].now as Date;
      const counts = (Object.keys(workSelects) as OwnerQueue[]).map(key =>
        `(SELECT count(*) FROM (${workSelects[key]}) queue_rows)::int AS "${key}"`).join(",");
      const queues = (await client.query<OwnerReport["queues"]>(`${workFacts}, settings AS (SELECT $1::int AS sla) SELECT ${counts}`,
        [this.overdueSeconds ?? null])).rows[0]!;
      const orders = (await client.query(`SELECT o.*,COALESCE(e.total,0)::text AS expense_total,COALESCE(e.entries,0)::int AS expense_entries,
        review.reviewed_total_minor,review.expense_entry_count FROM orders o
        LEFT JOIN LATERAL(SELECT sum(amount_minor) AS total,count(*) AS entries FROM order_direct_expenses WHERE order_id=o.id) e ON true
        LEFT JOIN LATERAL(SELECT * FROM order_expense_reviews WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) review ON true
        WHERE o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz ORDER BY o.created_at,o.id`, [query.from,query.to])).rows;
      const lines = (await client.query<Line & { order_id: string }>(`SELECT i.*,
        COALESCE((SELECT sum(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id
          WHERE ri.order_item_id=i.id AND r.status='COMPLETED'),0)::text AS returned,
        COALESCE(m.inspected,0)::text AS inspected,COALESCE(m.recovered,0)::text AS recovered,
        COALESCE(m.unknown,false) AS has_unknown_recovery,
        EXISTS(SELECT 1 FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE ri.order_item_id=i.id AND r.status='REQUESTED') AS requested
        FROM order_items i JOIN orders o ON o.id=i.order_id
        LEFT JOIN LATERAL(SELECT sum(m.quantity) AS inspected,sum(m.saleable_cost_minor) AS recovered,
          bool_or(m.saleable_quantity>0 AND m.saleable_cost_minor IS NULL) AS unknown
          FROM inventory_movements m JOIN return_items ri ON ri.id=m.return_item_id
          WHERE ri.order_item_id=i.id AND m.kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS')) m ON true
        WHERE o.economic_regime='DROPSHIP_MARKUP' AND o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz
        ORDER BY i.order_id,i.id`, [query.from,query.to])).rows;
      const stock = (await client.query(`${workFacts} SELECT id,product_id,sku,title,native_on_hand,native_initialization_id,
        reserved::text,GREATEST(0,native_on_hand-reserved-safety_buffer)::text AS sellable FROM stock`, [])).rows;
      const skus = new Map<string, OwnerReport["skus"][number]>(stock.map(s => [s.id, { variantId:s.id,productId:s.product_id,
        sku:s.sku,title:s.title,onHand:s.native_on_hand,reserved:Number(s.reserved),sellable:s.native_initialization_id ? Number(s.sellable) : null,
        retainedUnits:0,retainedDMinor:0,returnedUnits:0,cancelledUnits:0,contribution:contribution() }]));
      const drops = new Map<string, OwnerReport["drops"][number]>();
      const partners = (await client.query(`SELECT p.id,concat_ws(' ',u.first_name,u.last_name,
        CASE WHEN u.username IS NOT NULL THEN '@'||u.username END) AS name
        FROM partners p JOIN users u ON u.id=p.user_id ORDER BY p.id`)).rows;
      for (const p of partners) drops.set(p.id,{ ...result(),partnerId:p.id,name:p.name,obligations:obligations() });
      const ledger = (await client.query(`SELECT partner_id,
        COALESCE(sum(amount_minor) FILTER(WHERE bucket='PENDING'),0)::text AS pending,
        COALESCE(sum(amount_minor) FILTER(WHERE bucket='AVAILABLE'),0)::text AS available FROM ledger_entries GROUP BY partner_id`)).rows;
      for (const l of ledger) { const d=drops.get(l.partner_id); if (d) { d.obligations.pendingMinor=Number(l.pending);
        d.obligations.availableMinor=Math.max(0,Number(l.available)); d.obligations.debtMinor=Math.max(0,-Number(l.available)); } }
      const payouts = (await client.query(`SELECT partner_id,
        COALESCE(sum(amount_minor) FILTER(WHERE status='REQUESTED'),0)::text AS locked,
        COALESCE(sum(amount_minor) FILTER(WHERE status='PAID'),0)::text AS paid FROM payouts GROUP BY partner_id`)).rows;
      for (const p of payouts) { const d=drops.get(p.partner_id); if (d) { d.obligations.lockedMinor=Number(p.locked); d.obligations.paidMinor=Number(p.paid); } }
      // Reuse the T50 payable gate, including old debt and a late Return/payment correction.
      const candidates = (await client.query(`SELECT c.id,c.partner_id FROM commissions c WHERE c.state='EARNED'
        AND c.gross_amount_minor-c.reversed_amount_minor>COALESCE((SELECT sum(a.amount_minor) FROM payout_allocations a
          JOIN payouts p ON p.id=a.payout_id WHERE a.commission_id=c.id AND p.status IN ('REQUESTED','PAID')),0)`)).rows;
      for (const c of candidates) if (!await commissionPayable(client,c.id,asOf)) drops.get(c.partner_id)!.obligations.payoutBlocked=true;
      const cohort=result(), details: OwnerReport["orders"]=[];
      const byOrder = new Map<string,Line[]>();
      for (const l of lines) { const list=byOrder.get(l.order_id) ?? []; list.push(l); byOrder.set(l.order_id,list); }
      for (const o of orders.filter(o=>o.economic_regime==='DROPSHIP_MARKUP')) {
        const items=byOrder.get(o.id) ?? [];
        // T49 keeps refused native Orders SHIPPED, without a false delivery or a
        // new DELIVERY_FAILED transition. Completed full Returns close their outcome.
        const fullyReturned=['SHIPPED','DELIVERED'].includes(o.status) && items.length>0 && items.every(i=>Number(i.returned)===i.quantity);
        const failed=o.status==='DELIVERY_FAILED' || (fullyReturned && !o.delivered_at);
        const closed=['COMPLETED','CANCELLED','DELIVERY_FAILED'].includes(o.status) || fullyReturned;
        const limitations=new Set<string>();
        if (!closed) limitations.add('Заказ не завершён');
        if (o.reviewed_total_minor!==Number(o.expense_total) || o.expense_entry_count!==o.expense_entries) limitations.add('Расходы не проверены');
        const q=items.reduce((n,i)=>n+i.quantity,0);
        let before=0, value=0, units=0, r=0, d=0;
        const skuValues=new Map<string,number>();
        for (const i of items) {
          const returned=Number(i.returned), kept=o.status==='COMPLETED' ? i.quantity-returned : 0;
          const sku=skus.get(i.variant_id)!;
          const allocatedExpense=Number(BigInt(o.expense_total)*BigInt(before+i.quantity)/BigInt(q)-BigInt(o.expense_total)*BigInt(before)/BigInt(q));
          before+=i.quantity;
          let cost=0;
          if (o.shipped_at) {
            if (i.allocated_procurement_cost_minor===null) limitations.add('Неизвестна закупка');
            else cost=i.allocated_procurement_cost_minor-Number(i.recovered);
            const expected=failed ? i.quantity : returned;
            if (Number(i.inspected)<expected || i.has_unknown_recovery) limitations.add('Не определены потери/приёмка возврата');
          }
          if (i.requested) limitations.add('Открытый возврат');
          const lineValue=kept*i.dropship_unit_price_minor-cost-allocatedExpense;
          value+=lineValue; skuValues.set(i.variant_id,(skuValues.get(i.variant_id)??0)+lineValue);
          units+=kept; r+=kept*i.customer_unit_price_minor; d+=kept*i.dropship_unit_price_minor;
          sku.retainedUnits+=kept; sku.retainedDMinor+=kept*i.dropship_unit_price_minor; sku.returnedUnits+=returned;
          if (o.status==='CANCELLED') sku.cancelledUnits+=i.quantity;
        }
        const known=closed && limitations.size===0 ? value : null;
        for (const [id,amount] of skuValues) addContribution(skus.get(id)!.contribution,closed,known===null ? null : amount);
        for (const group of [cohort,drops.get(o.partner_id_snapshot)!]) {
          group.orders++; group.createdValueRMinor+=o.total_minor;
          if (!closed) group.unfinishedOrders++;
          if (o.delivered_at) group.deliveredOrders++;
          if (units>0) group.retainedOrders++;
          group.retainedUnits+=units; group.retainedRMinor+=r; group.retainedDMinor+=d; group.markupMinor+=r-d;
          if (o.status==='CANCELLED') group.cancelledOrders++;
          if (failed) group.failedOrders++;
          const returned=items.reduce((n,i)=>n+Number(i.returned),0);
          if (returned>0) group.returnedOrders++;
          group.returnedUnits+=returned;
          group.cancellationRate=group.cancelledOrders/group.orders;
          // Completed returns of refused shipments are not customer-after-delivery returns.
          // Return rate uses only delivered orders, with current outcomes.
          group.returnRate=null;
          addContribution(group.contribution,closed,known);
        }
        details.push({ id:o.id,number:o.public_number,status:fullyReturned ? `${o.status} · полный возврат${failed ? ' без доставки' : ''}` : o.status,retainedUnits:units,retainedRMinor:r,retainedDMinor:d,
          contributionMinor:known,limitations:[...limitations] });
      }
      for (const group of [cohort,...drops.values()]) {
        const ids=orders.filter(o=>o.economic_regime==='DROPSHIP_MARKUP' && o.delivered_at &&
          (!('partnerId' in group) || group.partnerId===o.partner_id_snapshot)).map(o=>o.id);
        const returned=ids.filter(id=>(byOrder.get(id)??[]).some(i=>Number(i.returned)>0)).length;
        group.returnRate=ids.length ? returned/ids.length : null;
      }
      const totals=obligations();
      for (const d of drops.values()) { for (const key of ['pendingMinor','availableMinor','lockedMinor','paidMinor','debtMinor'] as const)
        totals[key]+=d.obligations[key]; totals.payoutBlocked ||= d.obligations.payoutBlocked; }
      const flow=(await client.query(`SELECT count(*)::int AS orders,COALESCE(sum((SELECT sum(i.quantity-COALESCE((
        SELECT sum(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE ri.order_item_id=i.id
          AND r.status='COMPLETED' AND r.updated_at<=o.delivered_at),0)) FROM order_items i WHERE i.order_id=o.id)),0)::text AS units
        FROM orders o WHERE o.economic_regime='DROPSHIP_MARKUP' AND o.delivered_at >= $1::timestamptz AND o.delivered_at < $2::timestamptz`,[query.from,query.to])).rows[0];
      const cash=(await client.query(`SELECT COALESCE(sum(m.amount_minor) FILTER(WHERE m.kind='RECEIPT'),0)::text AS receipts,
        COALESCE(-sum(m.amount_minor) FILTER(WHERE m.kind='REFUND'),0)::text AS refunds,
        COALESCE(sum(m.amount_minor) FILTER(WHERE m.kind='CORRECTION'),0)::text AS corrections,COALESCE(sum(m.amount_minor),0)::text AS net
        FROM order_money_entries m JOIN orders o ON o.id=m.order_id WHERE o.economic_regime='DROPSHIP_MARKUP'
        AND m.occurred_at >= $1::timestamptz AND m.occurred_at < $2::timestamptz`,[query.from,query.to])).rows[0];
      return ownerReportSchema.parse({ ...query,timezone:'Europe/Minsk',currency:this.currency,asOf:asOf.toISOString(),
        legacyOrdersExcluded:orders.filter(o=>o.economic_regime!=='DROPSHIP_MARKUP').length,queues,overdueConfigured:this.overdueSeconds!==undefined,
        cohort,obligations:totals,deliveries:{orders:flow.orders,units:Number(flow.units)},
        cash:{receiptsMinor:Number(cash.receipts),refundsMinor:Number(cash.refunds),correctionsMinor:Number(cash.corrections),netMinor:Number(cash.net)},
        skus:[...skus.values()].sort((a,b)=>b.retainedUnits-a.retainedUnits || a.sku.localeCompare(b.sku)),drops:[...drops.values()],orders:details });
    });
  }
}
