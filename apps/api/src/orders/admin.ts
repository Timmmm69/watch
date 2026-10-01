import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CommissionError, holdOrderCommissions, reverseOrderCommissions } from "../finance/commissions.js";
import { allowedAdminOrderTransitions, allowedReservationTargets, reservationReconcileSchema,
  type ReservationReconcileRequest, type AdminOrderListQuery, type OrderStatus } from "@watch/contracts";

export class OrderTransitionError extends Error {
  constructor(readonly code: "NOT_FOUND" | "INVALID_ORDER_TRANSITION" | "SYSTEM_TRANSITION_ONLY" | "INTERNAL_INVARIANT_VIOLATION"
    | "INVENTORY_SNAPSHOT_CHANGED" | "VALIDATION_ERROR" | "DEPENDENCY_UNAVAILABLE") { super(code); }
}
interface OrderRow {
  id: string; public_number: string; status: OrderStatus; currency: string; total_minor: number;
  partner_id_snapshot: string | null; attribution_touch_id: string | null; commission_eligible_snapshot: boolean;
  created_at: Date; updated_at: Date; confirmed_at: Date | null; fulfilling_at: Date | null; shipped_at: Date | null;
  delivered_at: Date | null; completed_at: Date | null; cancelled_at: Date | null; delivery_failed_at: Date | null;
  completion_eligible_at: Date | null;
}
const timestampColumns = {
  CONFIRMED: "confirmed_at", FULFILLING: "fulfilling_at", SHIPPED: "shipped_at", DELIVERED: "delivered_at",
  CANCELLED: "cancelled_at", DELIVERY_FAILED: "delivery_failed_at"
} as const;

export class AdminOrderService {
  constructor(private readonly pool: Pool, private readonly holdDays = 14, private readonly overdueSeconds?: number,
    private readonly reconciliationMode: "MANUAL" | "NONE" = "MANUAL") {}

  private project(row: OrderRow, now = new Date()) {
    const stateAt = row.shipped_at ?? row.fulfilling_at ?? row.confirmed_at ?? row.created_at;
    return { id: row.id, publicNumber: row.public_number, status: row.status, currency: row.currency, totalMinor: row.total_minor,
      partnerIdSnapshot: row.partner_id_snapshot, attributionTouchId: row.attribution_touch_id,
      commissionEligibleSnapshot: row.commission_eligible_snapshot,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      completionEligibleAt: row.completion_eligible_at?.toISOString() ?? null,
      allowedTransitions: allowedAdminOrderTransitions[row.status],
      overdue: this.overdueSeconds !== undefined && ["PLACED", "CONFIRMED", "FULFILLING", "SHIPPED"].includes(row.status)
        && now.getTime() - stateAt.getTime() >= this.overdueSeconds * 1000,
      timeline: [{ status: "PLACED", at: row.created_at.toISOString() },
        ...Object.entries({ CONFIRMED: row.confirmed_at, FULFILLING: row.fulfilling_at, SHIPPED: row.shipped_at,
          DELIVERED: row.delivered_at, COMPLETED: row.completed_at, CANCELLED: row.cancelled_at, DELIVERY_FAILED: row.delivery_failed_at })
          .flatMap(([status, at]) => at ? [{ status, at: at.toISOString() }] : [])] };
  }

  async list(query: AdminOrderListQuery) {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); predicates.push(sql.replace("?", `$${values.length}`)); };
    if (query.status) add("o.status = ?", query.status);
    if (query.number) add("o.public_number = ?", query.number);
    if (query.partnerId) add("o.partner_id_snapshot = ?", query.partnerId);
    if (query.dateFrom) add("o.created_at >= ?", query.dateFrom);
    if (query.dateTo) add("o.created_at <= ?", query.dateTo);
    if (query.overdue) {
      if (this.overdueSeconds === undefined) predicates.push("false");
      else add("o.status IN ('PLACED','CONFIRMED','FULFILLING','SHIPPED') AND COALESCE(o.shipped_at,o.fulfilling_at,o.confirmed_at,o.created_at) <= now() - ? * interval '1 second'", this.overdueSeconds);
    }
    if (query.reconciliationPending) predicates.push(`o.status IN ('SHIPPED','DELIVERED','COMPLETED','DELIVERY_FAILED')
      AND EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.order_id=o.id AND r.status='ACTIVE')`);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    const total = Number((await this.pool.query<{ total: string }>(`SELECT count(*) AS total FROM orders o ${where}`, values)).rows[0]!.total);
    const rows = (await this.pool.query<OrderRow>(`SELECT o.* FROM orders o ${where} ORDER BY o.created_at DESC,o.id
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, query.limit, (query.page - 1) * query.limit])).rows;
    return { items: rows.map((row) => this.project(row)), total, page: query.page, limit: query.limit };
  }

  async detail(id: string) {
    const row = (await this.pool.query<OrderRow>("SELECT * FROM orders WHERE id=$1", [id])).rows[0];
    if (!row) throw new OrderTransitionError("NOT_FOUND");
    const fulfillment = (await this.pool.query(`SELECT recipient_name AS "recipientName",phone,address,comment,redacted_at AS "redactedAt"
      FROM order_fulfillment_details WHERE order_id=$1`, [id])).rows[0] ?? null;
    const items = (await this.pool.query(`SELECT id,variant_id AS "variantId",sku_snapshot AS sku,title_snapshot AS title,
      attributes_snapshot AS attributes,quantity,unit_price_minor AS "unitPriceMinor",line_total_minor AS "lineTotalMinor",
      partner_commission_unit_snapshot_minor AS "partnerCommissionUnitMinor",supplier_settlement_unit_snapshot_minor AS "supplierSettlementUnitMinor"
      FROM order_items WHERE order_id=$1 ORDER BY id`, [id])).rows;
    const reservations = (await this.pool.query(`SELECT r.id,r.status,r.quantity,r.variant_id AS "variantId",
      r.reconciliation_method AS "reconciliationMethod",r.reconciliation_reference AS "reconciliationReference",
      r.reconciliation_source_version AS "reconciliationSourceVersion",r.reconciliation_inventory_sync_run_id AS "reconciliationInventorySyncRunId",
      r.reconciled_by_admin_user_id AS "reconciledByAdminUserId",r.reconciled_at AS "reconciledAt",r.released_at AS "releasedAt",r.consumed_at AS "consumedAt",
      i.source_status AS "sourceStatus",i.source_version AS "sourceVersion",i.last_successful_sync_at AS "lastSuccessfulSyncAt",
      i.last_successful_sync_run_id AS "lastSuccessfulSyncRunId"
      FROM inventory_reservations r LEFT JOIN inventory_items i ON i.variant_id=r.variant_id WHERE r.order_id=$1 ORDER BY r.id`, [id])).rows;
    return { ...this.project(row), fulfillment, items, reservations: reservations.map((reservation) => ({ ...reservation,
      allowedManualTargets: this.reconciliationMode === "MANUAL" && reservation.status === "ACTIVE"
        ? allowedReservationTargets[row.status] : [] })) };
  }

  async reconcileReservation(id: string, actorUserId: string, input: ReservationReconcileRequest, requestId?: string) {
    if (this.reconciliationMode !== "MANUAL") throw new OrderTransitionError("DEPENDENCY_UNAVAILABLE");
    const parsed = reservationReconcileSchema.safeParse(input);
    if (!parsed.success) throw new OrderTransitionError("VALIDATION_ERROR");
    const data = parsed.data;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Immutable ownership lookup only; business locks are always Order → Reservation → InventoryItem.
      const owner = (await client.query<{ order_id: string }>("SELECT order_id FROM inventory_reservations WHERE id=$1", [id])).rows[0];
      if (!owner) throw new OrderTransitionError("NOT_FOUND");
      const order = (await client.query<{ status: OrderStatus }>("SELECT status FROM orders WHERE id=$1 FOR UPDATE", [owner.order_id])).rows[0];
      const reservation = (await client.query("SELECT * FROM inventory_reservations WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!order || !reservation) throw new OrderTransitionError("INTERNAL_INVARIANT_VIOLATION");
      if (!allowedReservationTargets[order.status].includes(data.target)) throw new OrderTransitionError("INVALID_ORDER_TRANSITION");
      if (reservation.status !== "ACTIVE") {
        if (reservation.status !== data.target) throw new OrderTransitionError("INVALID_ORDER_TRANSITION");
        await client.query("COMMIT");
        return reservation;
      }
      const inventory = (await client.query(`SELECT source_status,source_version,last_successful_sync_run_id
        FROM inventory_items WHERE variant_id=$1 FOR UPDATE`, [reservation.variant_id])).rows[0];
      if (!inventory || inventory.source_status !== "OK") throw new OrderTransitionError("INTERNAL_INVARIANT_VIOLATION");
      if (inventory.last_successful_sync_run_id !== data.expectedInventorySyncRunId)
        throw new OrderTransitionError("INVENTORY_SNAPSHOT_CHANGED");
      const now = new Date();
      const updated = (await client.query(`UPDATE inventory_reservations SET status=$2,reconciliation_method='MANUAL',
        reconciliation_reference=$3,reconciliation_source_version=$4,reconciliation_inventory_sync_run_id=$5,
        reconciled_by_admin_user_id=$6,reconciled_at=$7,${data.target === "CONSUMED" ? "consumed_at" : "released_at"}=$7
        WHERE id=$1 RETURNING *`, [id,data.target,data.evidenceReference ?? null,inventory.source_version,
        inventory.last_successful_sync_run_id,actorUserId,now])).rows[0]!;
      await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
        VALUES ($1,$2,'admin.inventory.reservation.reconcile','InventoryReservation',$3,$4,$5,$6)`,
      [randomUUID(),actorUserId,id,requestId ?? null,JSON.stringify({ orderId: owner.order_id,target: data.target,
        reason: data.reason,evidenceReference: data.evidenceReference ?? null,inventorySyncRunId: inventory.last_successful_sync_run_id,
        sourceVersion: inventory.source_version,confirmSnapshotReflectsOutcome: true }),now]);
      await client.query("COMMIT");
      return updated;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async transition(id: string, actorUserId: string, target: OrderStatus, requestId?: string) {
    if (target === "COMPLETED") throw new OrderTransitionError("SYSTEM_TRANSITION_ONLY");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Immutable Partner ownership lookup before the global Partner → Order lock order.
      if (["DELIVERED","CANCELLED","DELIVERY_FAILED"].includes(target)) {
        const owner = (await client.query<{ partner_id_snapshot: string | null }>(
          "SELECT partner_id_snapshot FROM orders WHERE id=$1", [id])).rows[0];
        if (owner?.partner_id_snapshot) await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [owner.partner_id_snapshot]);
      }
      const row = (await client.query<OrderRow>("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new OrderTransitionError("NOT_FOUND");
      if (row.status === target && target in timestampColumns) {
        await client.query("COMMIT");
        return this.project(row);
      }
      if (!allowedAdminOrderTransitions[row.status].some((allowed) => allowed === target)) throw new OrderTransitionError("INVALID_ORDER_TRANSITION");
      const now = new Date(); // Time is captured after lock acquisition.
      if (["DELIVERED","CANCELLED","DELIVERY_FAILED"].includes(target))
        await client.query("SELECT id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE", [id]);
      if (target === "CANCELLED") {
        const reservations = (await client.query<{ status: string }>("SELECT status FROM inventory_reservations WHERE order_id=$1 ORDER BY id FOR UPDATE", [id])).rows;
        if (reservations.some((r) => r.status !== "ACTIVE")) throw new OrderTransitionError("INTERNAL_INVARIANT_VIOLATION");
        await client.query("UPDATE inventory_reservations SET status='RELEASED',released_at=$2 WHERE order_id=$1 AND status='ACTIVE'", [id, now]);
      }
      const column = timestampColumns[target as keyof typeof timestampColumns];
      if (row[column] !== null || (target === "DELIVERED" && row.completion_eligible_at !== null)) throw new OrderTransitionError("INTERNAL_INVARIANT_VIOLATION");
      const updated = (await client.query<OrderRow>(`UPDATE orders SET status=$2,${column}=$3,updated_at=$3
        ${target === "DELIVERED" ? ",completion_eligible_at=$4" : ""} WHERE id=$1 RETURNING *`,
      [id, target, now, ...(target === "DELIVERED" ? [new Date(now.getTime() + this.holdDays * 86400000)] : [])])).rows[0]!;
      if (target === "DELIVERED") await holdOrderCommissions(client,id,updated.completion_eligible_at!,now);
      if (target === "CANCELLED" || target === "DELIVERY_FAILED")
        await reverseOrderCommissions(client,id,`order:${id}:${target.toLowerCase()}`,now);
      await this.event(client, id, "ORDER_STATUS_CHANGED", `order:${id}:status:${target}`,
        { v: 1, orderId: id, publicNumber: row.public_number, fromStatus: row.status, toStatus: target }, now);
      if (target === "CANCELLED" || target === "DELIVERY_FAILED") await this.event(client, id,
        target === "CANCELLED" ? "ORDER_CANCELLED" : "ORDER_DELIVERY_FAILED", `order:${id}:${target.toLowerCase()}`,
        { v: 1, orderId: id, publicNumber: row.public_number, ...(row.partner_id_snapshot ? { partnerIdSnapshot: row.partner_id_snapshot } : {}) }, now);
      // Free-form notes may contain fulfilment PII; do not copy them to Event/AuditLog metadata.
      await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
        VALUES ($1,$2,'admin.order.transition','Order',$3,$4,$5,$6)`,
      [randomUUID(), actorUserId, id, requestId ?? null, JSON.stringify({ fromStatus: row.status, toStatus: target }), now]);
      await client.query("COMMIT");
      return this.project(updated);
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CommissionError) throw new OrderTransitionError(error.code);
      throw error;
    }
    finally { client.release(); }
  }

  private async event(client: PoolClient, id: string, type: string, key: string, payload: object, now: Date) {
    await client.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,created_at)
      VALUES ($1,$2,'Order',$3,$4,$5,$6)`, [randomUUID(), type, id, key, JSON.stringify(payload), now]);
  }
}
