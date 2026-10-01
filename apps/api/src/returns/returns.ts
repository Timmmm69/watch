import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AdminReturnCreateRequest, AdminReturnListQuery, ReturnStatus } from "@watch/contracts";
import { CommissionError, reverseCommission } from "../finance/commissions.js";

export class ReturnError extends Error {
  constructor(readonly code: "NOT_FOUND" | "VALIDATION_ERROR" | "RETURN_NOT_ALLOWED"
    | "RETURN_QUANTITY_EXCEEDED" | "INTERNAL_INVARIANT_VIOLATION") { super(code); }
}
interface ReturnRow {
  id: string; order_id: string; status: ReturnStatus; reason: string; note: string | null;
  created_by_admin_user_id: string; created_at: Date; updated_at: Date;
}
interface ItemRow {
  id: string; order_item_id: string; quantity: number; variant_id: string; sku_snapshot: string;
  title_snapshot: string; unit_price_minor: number; partner_commission_unit_snapshot_minor: number;
}

export class AdminReturnService {
  constructor(private readonly pool: Pool) {}

  private project(row: ReturnRow & { public_number: string; item_count: number }) {
    return {
      id: row.id, orderId: row.order_id, orderPublicNumber: row.public_number, status: row.status,
      reason: row.reason, note: row.note, itemCount: row.item_count,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()
    };
  }

  async list(query: AdminReturnListQuery) {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); predicates.push(sql.replace("?", `$${values.length}`)); };
    if (query.status) add("r.status = ?", query.status);
    if (query.orderId) add("r.order_id = ?", query.orderId);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    const total = Number((await this.pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM returns r ${where}`, values)).rows[0]!.total);
    const rows = (await this.pool.query<ReturnRow & { public_number: string; item_count: number }>(
      `SELECT r.*,o.public_number,(SELECT count(*)::int FROM return_items ri WHERE ri.return_id=r.id) AS item_count
       FROM returns r JOIN orders o ON o.id=r.order_id ${where} ORDER BY r.created_at DESC,r.id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, query.limit, (query.page - 1) * query.limit])).rows;
    return { items: rows.map((row) => this.project(row)), total, page: query.page, limit: query.limit };
  }

  async detail(id: string) {
    const row = (await this.pool.query<ReturnRow & { public_number: string; currency: string }>(
      `SELECT r.*,o.public_number,o.currency FROM returns r JOIN orders o ON o.id=r.order_id WHERE r.id=$1`, [id])).rows[0];
    if (!row) throw new ReturnError("NOT_FOUND");
    const items = (await this.pool.query<ItemRow>(
      `SELECT ri.id,ri.order_item_id,ri.quantity,oi.variant_id,oi.sku_snapshot,oi.title_snapshot,
        oi.unit_price_minor,oi.partner_commission_unit_snapshot_minor
       FROM return_items ri JOIN order_items oi ON oi.id=ri.order_item_id AND oi.order_id=ri.order_id
       WHERE ri.return_id=$1 ORDER BY ri.id`, [id])).rows;
    return {
      id: row.id, orderId: row.order_id, orderPublicNumber: row.public_number, status: row.status,
      reason: row.reason, note: row.note, createdByAdminUserId: row.created_by_admin_user_id, currency: row.currency,
      items: items.map((item) => ({
        id: item.id, orderItemId: item.order_item_id, variantId: item.variant_id, sku: item.sku_snapshot,
        title: item.title_snapshot, quantity: item.quantity, unitPriceMinor: item.unit_price_minor,
        partnerCommissionUnitSnapshotMinor: item.partner_commission_unit_snapshot_minor
      })),
      reversalPreviewMinor: items.reduce((sum, item) =>
        sum + item.partner_commission_unit_snapshot_minor * item.quantity, 0),
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()
    };
  }

  async create(actorUserId: string, input: AdminReturnCreateRequest, requestId?: string) {
    const client = await this.pool.connect();
    const returnId = randomUUID();
    try {
      await client.query("BEGIN");
      // Return creation locks the Order so it serializes with Order completion
      // and with concurrent Return creation for the same Order.
      const order = (await client.query<{ status: string }>(
        "SELECT status FROM orders WHERE id=$1 FOR UPDATE", [input.orderId])).rows[0];
      if (!order) throw new ReturnError("NOT_FOUND");
      if (order.status !== "DELIVERED" && order.status !== "COMPLETED") throw new ReturnError("RETURN_NOT_ALLOWED");
      const itemIds = [...new Set(input.items.map((item) => item.orderItemId))].sort();
      const locked = (await client.query<{ id: string; quantity: number }>(
        "SELECT id,quantity FROM order_items WHERE order_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
        [input.orderId, itemIds])).rows;
      const ordered = new Map(locked.map((row) => [row.id, row.quantity]));
      if (input.items.some((item) => !ordered.has(item.orderItemId))) throw new ReturnError("VALIDATION_ERROR");
      const returned = new Map((await client.query<{ order_item_id: string; returned: number }>(
        `SELECT ri.order_item_id,COALESCE(SUM(ri.quantity),0)::int AS returned
         FROM return_items ri JOIN returns r ON r.id=ri.return_id
         WHERE r.order_id=$1 AND r.status IN ('OPEN','COMPLETED') AND ri.order_item_id=ANY($2::uuid[])
         GROUP BY ri.order_item_id`, [input.orderId, itemIds])).rows.map((row) => [row.order_item_id, row.returned]));
      for (const item of input.items) {
        if ((returned.get(item.orderItemId) ?? 0) + item.quantity > ordered.get(item.orderItemId)!)
          throw new ReturnError("RETURN_QUANTITY_EXCEEDED");
      }
      const now = new Date();
      await client.query(`INSERT INTO returns (id,order_id,reason,created_by_admin_user_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$5)`, [returnId, input.orderId, input.reason, actorUserId, now]);
      for (const item of input.items) {
        await client.query(`INSERT INTO return_items (id,return_id,order_id,order_item_id,quantity)
          VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), returnId, input.orderId, item.orderItemId, item.quantity]);
      }
      // Audit metadata stays free of free-text reason that could contain fulfilment PII.
      await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
        VALUES ($1,$2,'admin.return.create','Return',$3,$4,$5,$6)`,
      [randomUUID(), actorUserId, returnId, requestId ?? null,
        JSON.stringify({ orderId: input.orderId, items: input.items.map((item) => ({ orderItemId: item.orderItemId, quantity: item.quantity })) }), now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    return await this.detail(returnId);
  }

  async complete(id: string, actorUserId: string, requestId?: string, note?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Identity is immutable; acquire financial locks before locking the Return.
      const identity = (await client.query<{ order_id: string; partner_id_snapshot: string | null }>(
        `SELECT r.order_id,o.partner_id_snapshot FROM returns r JOIN orders o ON o.id=r.order_id WHERE r.id=$1`, [id])).rows[0];
      if (!identity) throw new ReturnError("NOT_FOUND");
      if (identity.partner_id_snapshot) await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [identity.partner_id_snapshot]);
      const order = (await client.query<{ status: string; commission_eligible_snapshot: boolean }>(
        "SELECT status,commission_eligible_snapshot FROM orders WHERE id=$1 FOR UPDATE", [identity.order_id])).rows[0]!;
      const items = (await client.query<{ id: string; quantity: number; returned_quantity: number; partner_commission_unit_snapshot_minor: number }>(
        `SELECT oi.id,oi.quantity,ri.quantity AS returned_quantity,oi.partner_commission_unit_snapshot_minor
         FROM order_items oi JOIN return_items ri ON ri.order_item_id=oi.id AND ri.order_id=oi.order_id
         WHERE ri.return_id=$1 ORDER BY oi.id FOR UPDATE OF oi`, [id])).rows;
      const commissions = (await client.query<{ id: string; order_item_id: string }>(
        "SELECT id,order_item_id FROM commissions WHERE order_id=$1 AND order_item_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
        [identity.order_id, items.map((item) => item.id)])).rows;
      const row = (await client.query<ReturnRow>("SELECT * FROM returns WHERE id=$1 FOR UPDATE", [id])).rows[0]!;
      if (row.status !== "COMPLETED") {
        if (row.status !== "OPEN" || !["DELIVERED", "COMPLETED"].includes(order.status)) throw new ReturnError("RETURN_NOT_ALLOWED");
        if (!items.length) throw new ReturnError("INTERNAL_INVARIANT_VIOLATION");
        const quantities = (await client.query<{ order_item_id: string; returned: number }>(
          `SELECT ri.order_item_id,SUM(ri.quantity)::int AS returned FROM return_items ri JOIN returns r ON r.id=ri.return_id
           WHERE r.order_id=$1 AND r.status IN ('OPEN','COMPLETED') AND ri.order_item_id=ANY($2::uuid[]) GROUP BY ri.order_item_id`,
          [identity.order_id, items.map((item) => item.id)])).rows;
        const returned = new Map(quantities.map((item) => [item.order_item_id, item.returned]));
        const byItem = new Map(commissions.map((commission) => [commission.order_item_id, commission.id]));
        const now = new Date();
        let commissionReversalMinor = 0;
        for (const item of items) {
          if ((returned.get(item.id) ?? 0) > item.quantity) throw new ReturnError("RETURN_QUANTITY_EXCEEDED");
          if (!order.commission_eligible_snapshot || item.partner_commission_unit_snapshot_minor === 0) continue;
          const commissionId = byItem.get(item.id);
          if (!commissionId) throw new ReturnError("INTERNAL_INVARIANT_VIOLATION");
          commissionReversalMinor += await reverseCommission(client, commissionId,
            item.partner_commission_unit_snapshot_minor * item.returned_quantity, `return:${id}:completed`, now);
        }
        await client.query("UPDATE returns SET status='COMPLETED',note=$2,updated_at=$3 WHERE id=$1", [id, note ?? null, now]);
        await client.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,created_at)
          VALUES ($1,'RETURN_COMPLETED','Return',$2,$3,$4,$5)`, [randomUUID(), id, `return:${id}:completed`,
          JSON.stringify({ v: 1, returnId: id, orderId: identity.order_id,
            ...(identity.partner_id_snapshot ? { partnerIdSnapshot: identity.partner_id_snapshot } : {}), commissionReversalMinor }), now]);
        await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
          VALUES ($1,$2,'admin.return.complete','Return',$3,$4,$5,$6)`, [randomUUID(), actorUserId, id, requestId ?? null,
          JSON.stringify({ orderId: identity.order_id, commissionReversalMinor }), now]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CommissionError) throw new ReturnError(error.code);
      throw error;
    } finally { client.release(); }
    return await this.detail(id);
  }

  async cancel(id: string, actorUserId: string, requestId?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query<ReturnRow>("SELECT * FROM returns WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new ReturnError("NOT_FOUND");
      if (row.status === "CANCELLED") {
        await client.query("COMMIT");
        return await this.detail(id);
      }
      if (row.status !== "OPEN") throw new ReturnError("RETURN_NOT_ALLOWED");
      const now = new Date();
      await client.query("UPDATE returns SET status='CANCELLED',updated_at=$2 WHERE id=$1", [id, now]);
      await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
        VALUES ($1,$2,'admin.return.cancel','Return',$3,$4,$5,$6)`,
      [randomUUID(), actorUserId, id, requestId ?? null, JSON.stringify({ orderId: row.order_id }), now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    return await this.detail(id);
  }
}
