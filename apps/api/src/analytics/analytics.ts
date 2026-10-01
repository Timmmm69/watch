import type { Pool } from "pg";
import { adminDashboardSchema, analyticsSummarySchema, type AnalyticsQuery, type AnalyticsSummary } from "@watch/contracts";

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

// A completed return removes units, not necessarily the whole order. OPEN/CANCELLED returns have no effect.
const retainedItems = `SELECT i.*, i.quantity - COALESCE((
  SELECT SUM(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id
  WHERE ri.order_item_id=i.id AND r.status='COMPLETED'),0) AS retained_quantity
  FROM order_items i`;

export class AnalyticsService {
  constructor(private readonly pool: Pool, private readonly currency: string,
    private readonly timezone = "UTC", private readonly inventoryMaxAgeSeconds = 600,
    private readonly overdueSeconds?: number) {}

  async summary(query: AnalyticsQuery): Promise<AnalyticsSummary> {
    // One statement gives all projections the same database snapshot. Order metrics use creation cohorts;
    // touch metrics deliberately include attributed orders outside the selected period, up to touch expiry.
    const result = await this.pool.query<AnalyticsSummary & { eligibleRetained: number }>(`
      WITH retained_items AS (${retainedItems}),
      cohort AS (SELECT o.*, EXISTS(SELECT 1 FROM retained_items i WHERE i.order_id=o.id AND i.retained_quantity>0)
        AND o.status='COMPLETED' AS retained,
        EXISTS(SELECT 1 FROM returns r WHERE r.order_id=o.id AND r.status='COMPLETED') AS returned
        FROM orders o WHERE o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz),
      touches AS (SELECT t.id, COUNT(o.id) AS orders FROM attribution_touches t
        LEFT JOIN orders o ON o.attribution_touch_id=t.id AND o.created_at < t.expires_at
        WHERE t.occurred_at >= $1::timestamptz AND t.occurred_at < $2::timestamptz GROUP BY t.id),
      contribution AS (SELECT COALESCE(SUM(i.retained_quantity),0)::float8 AS units,
        COALESCE(SUM(i.retained_quantity) FILTER (WHERE i.supplier_settlement_unit_snapshot_minor IS NOT NULL),0)::float8 AS covered,
        COALESCE(SUM(i.retained_quantity * (i.unit_price_minor::bigint-i.supplier_settlement_unit_snapshot_minor-
          CASE WHEN o.commission_eligible_snapshot THEN i.partner_commission_unit_snapshot_minor ELSE 0 END))
          FILTER (WHERE i.supplier_settlement_unit_snapshot_minor IS NOT NULL),0)::float8 AS margin
        FROM retained_items i JOIN cohort o ON o.id=i.order_id WHERE o.retained),
      first_sales AS (SELECT o.partner_id_snapshot AS partner_id, MIN(o.completed_at) AS sold_at
        FROM orders o WHERE o.status='COMPLETED' AND o.commission_eligible_snapshot
        AND EXISTS(SELECT 1 FROM retained_items i WHERE i.order_id=o.id AND i.retained_quantity>0)
        GROUP BY o.partner_id_snapshot),
      sale_times AS (SELECT EXTRACT(epoch FROM (s.sold_at-MIN(a.accepted_at)))::float8 AS seconds
        FROM first_sales s JOIN partner_terms_acceptances a ON a.partner_id=s.partner_id
        WHERE s.sold_at >= $1::timestamptz AND s.sold_at < $2::timestamptz GROUP BY s.partner_id,s.sold_at),
      weeks AS (SELECT w FROM generate_series(date_trunc('week',$1::timestamptz AT TIME ZONE $3),
        date_trunc('week',$2::timestamptz AT TIME ZONE $3),interval '1 week') w
        WHERE w AT TIME ZONE $3 >= $1::timestamptz AND (w+interval '2 weeks') AT TIME ZONE $3 <= $2::timestamptz),
      weekly_sellers AS (SELECT DISTINCT date_trunc('week',created_at AT TIME ZONE $3) AS week,partner_id_snapshot AS partner
        FROM cohort WHERE commission_eligible_snapshot AND partner_id_snapshot IS NOT NULL),
      retention AS (SELECT w.w, COUNT(a.partner)::int AS active, COUNT(b.partner)::int AS retained FROM weeks w
        LEFT JOIN weekly_sellers a ON a.week=w.w
        LEFT JOIN weekly_sellers b ON b.week=w.w+interval '1 week' AND b.partner=a.partner GROUP BY w.w)
      SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_minor),0)::float8 AS "gmvMinor",
        COUNT(*) FILTER (WHERE retained)::int AS "retainedCompletedOrders",
        COUNT(DISTINCT partner_id_snapshot) FILTER (WHERE commission_eligible_snapshot)::int AS "activeSellingPartners",
        COUNT(*) FILTER (WHERE retained AND commission_eligible_snapshot)::int AS "eligibleRetained",
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL OR status IN ('DELIVERED','COMPLETED'))::int AS "deliveredOrders",
        COUNT(*) FILTER (WHERE shipped_at IS NOT NULL OR status IN ('SHIPPED','DELIVERED','COMPLETED','DELIVERY_FAILED'))::int AS "shippedOrders",
        COUNT(*) FILTER (WHERE status='CANCELLED')::int AS "cancelledOrders",
        COUNT(*) FILTER (WHERE status='DELIVERY_FAILED')::int AS "deliveryFailedOrders",
        COUNT(*) FILTER (WHERE returned)::int AS "returnedOrders",
        (SELECT COUNT(*)::int FROM touches) AS "referralTouches",
        (SELECT COUNT(*)::int FROM touches WHERE orders>0) AS "convertedTouches",
        (SELECT COALESCE(SUM(orders),0)::float8 FROM touches) AS "referralOrders",
        (SELECT COALESCE(SUM(c.gross_amount_minor::bigint-c.reversed_amount_minor),0)::float8
          FROM commissions c JOIN cohort o ON o.id=c.order_id WHERE c.state IN ('PENDING','HOLD','EARNED')) AS "netPartnerCommissionMinor",
        (SELECT json_build_object('retainedUnits',units,'coveredUnits',covered,'coverageRate',covered/NULLIF(units,0),
          'coveredSettlementMarginMinor',margin,'settlementMarginMinor',CASE WHEN units>0 AND covered=units THEN margin ELSE NULL END,
          'fullContributionMinor',NULL,'limitation','U04_VARIABLE_COSTS_UNRESOLVED') FROM contribution) AS contribution,
        (SELECT json_build_object('partners',COUNT(*),'averageSeconds',AVG(seconds)) FROM sale_times) AS "firstSale",
        (SELECT COALESCE(json_agg(json_build_object('week',to_char(w,'YYYY-MM-DD'),'activePartners',active,
          'retainedPartners',retained,'rate',retained::float8/NULLIF(active,0)) ORDER BY w),'[]') FROM retention) AS "weeklyRetention"
      FROM cohort`, [query.from, query.to, this.timezone]);
    const row = result.rows[0]!;
    return analyticsSummarySchema.parse({ ...row, ...query, currency: this.currency, timezone: this.timezone,
      retainedOrdersPerActivePartner: ratio(row.eligibleRetained, row.activeSellingPartners),
      touchConversionRate: ratio(row.convertedTouches, row.referralTouches), ordersPerTouch: ratio(row.referralOrders, row.referralTouches),
      deliveryRate: ratio(row.deliveredOrders, row.orders), cancellationRate: ratio(row.cancelledOrders, row.orders),
      deliveryFailureRate: ratio(row.deliveryFailedOrders, row.shippedOrders), returnRate: ratio(row.returnedOrders, row.deliveredOrders) });
  }

  async dashboard() {
    const result = await this.pool.query(`WITH inventory AS (
      SELECT v.id,i.*, COALESCE((SELECT SUM(r.quantity) FROM inventory_reservations r
        WHERE r.variant_id=v.id AND r.status='ACTIVE'),0) AS reserved FROM product_variants v
        LEFT JOIN inventory_items i ON i.variant_id=v.id),
      health AS (SELECT *, source_status='OK' AND source_quantity IS NOT NULL
        AND last_successful_sync_at >= now()-$1*interval '1 second' AS fresh FROM inventory)
      SELECT json_build_object(
        'products',(SELECT COUNT(*) FROM products),'activeProducts',(SELECT COUNT(*) FROM products WHERE status='ACTIVE'),
        'variants',(SELECT COUNT(*) FROM product_variants),'partners',(SELECT COUNT(*) FROM partners),
        'activePartners',(SELECT COUNT(*) FROM partners WHERE status='ACTIVE'),'blockedPartners',(SELECT COUNT(*) FROM partners WHERE status='BLOCKED'),
        'orders',(SELECT COUNT(*) FROM orders),'returns',(SELECT COUNT(*) FROM returns),'payouts',(SELECT COUNT(*) FROM payouts)) AS summaries,
      json_build_object(
        'overdueOrders',(SELECT COUNT(*) FROM orders WHERE status IN ('PLACED','CONFIRMED','FULFILLING','SHIPPED')
          AND COALESCE(shipped_at,fulfilling_at,confirmed_at,created_at) <= now()-$2*interval '1 second'),
        'placedOrders',(SELECT COUNT(*) FROM orders WHERE status='PLACED'),
        'reconciliationPending',(SELECT COUNT(*) FROM inventory_reservations r JOIN orders o ON o.id=r.order_id
          WHERE r.status='ACTIVE' AND o.status IN ('SHIPPED','DELIVERED','COMPLETED','DELIVERY_FAILED')),
        'staleInventory',(SELECT COUNT(*) FROM health WHERE source_status='OK' AND source_quantity IS NOT NULL AND fresh IS NOT TRUE),
        'unknownInventory',(SELECT COUNT(*) FROM health WHERE source_status IS DISTINCT FROM 'OK' OR source_quantity IS NULL),
        'inventoryDeficits',(SELECT COUNT(*) FROM health WHERE fresh AND source_quantity<reserved+safety_buffer),
        'failedSyncs',(SELECT COUNT(*) FROM (SELECT status FROM inventory_sync_runs ORDER BY started_at DESC,id DESC LIMIT 1) latest
          WHERE status IN ('FAILED','PARTIAL')),
        'openReturns',(SELECT COUNT(*) FROM returns WHERE status='OPEN'),
        'requestedPayouts',(SELECT COUNT(*) FROM payouts WHERE status='REQUESTED'),
        'failedEvents',(SELECT COUNT(*) FROM events WHERE status='FAILED'),
        'failedTelegramUpdates',(SELECT COUNT(*) FROM telegram_updates WHERE status='FAILED')) AS actionable`,
    [this.inventoryMaxAgeSeconds, this.overdueSeconds ?? null]);
    return adminDashboardSchema.parse({ ...result.rows[0], currency: this.currency, overdueConfigured: this.overdueSeconds !== undefined });
  }
}
