import { createHash, randomUUID } from "node:crypto";
import { reconcileOverpayment } from "../finance/coverage.js";
import type { Pool } from "pg";
import { adminReturnCreateRequestSchema, adminReturnInspectionSchema,
  type AdminReturnInspection, type AdminReturnCreateRequest, type AdminReturnListQuery, type ReturnStatus } from "@watch/contracts";
import { CommissionError, reverseCommission } from "../finance/commissions.js";
import { NativeInventoryError, NativeInventoryService, usesNativeInventory } from "../inventory/native.js";
import { releaseUnaffectedCommissions } from "../orders/completion.js";

export class ReturnError extends Error {
  constructor(readonly code: "NOT_FOUND" | "VALIDATION_ERROR" | "RETURN_NOT_ALLOWED"
    | "RETURN_QUANTITY_EXCEEDED" | "IDEMPOTENCY_CONFLICT" | "INTERNAL_INVARIANT_VIOLATION") { super(code); }
}
interface ReturnRow {
  id: string; order_id: string; status: ReturnStatus; reason: string; note: string | null;
  created_by_admin_user_id: string; created_at: Date; updated_at: Date;
}
interface ItemRow {
  id: string; order_item_id: string; quantity: number; variant_id: string; sku_snapshot: string;
  title_snapshot: string; unit_price_minor: number; partner_commission_unit_snapshot_minor: number;
  economic_regime: string; inventory_mode?: string | null; inspected_quantity: number; saleable_quantity: number;
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
        oi.unit_price_minor,oi.partner_commission_unit_snapshot_minor,oi.economic_regime,
        (SELECT to_jsonb(o)->>'inventory_mode' FROM orders o WHERE o.id=oi.order_id) AS inventory_mode,
        COALESCE((SELECT sum(m.quantity)::int FROM inventory_movements m WHERE m.return_item_id=ri.id),0) AS inspected_quantity,
        COALESCE((SELECT sum(m.saleable_quantity)::int FROM inventory_movements m WHERE m.return_item_id=ri.id),0) AS saleable_quantity
       FROM return_items ri JOIN order_items oi ON oi.id=ri.order_item_id AND oi.order_id=ri.order_id
       WHERE ri.return_id=$1 ORDER BY ri.id`, [id])).rows;
    return {
      id: row.id, orderId: row.order_id, orderPublicNumber: row.public_number, status: row.status,
      reason: row.reason, note: row.note, createdByAdminUserId: row.created_by_admin_user_id, currency: row.currency,
      economicRegime: items.some(item => item.economic_regime === "DROPSHIP_MARKUP") ? "DROPSHIP_MARKUP" : "LEGACY_FIXED",
      items: items.map((item) => ({
        id: item.id, orderItemId: item.order_item_id, variantId: item.variant_id, sku: item.sku_snapshot,
        title: item.title_snapshot, quantity: item.quantity, unitPriceMinor: item.unit_price_minor,
        partnerCommissionUnitSnapshotMinor: item.partner_commission_unit_snapshot_minor,
        physicalAcceptanceAllowed: usesNativeInventory(item) && row.status === "COMPLETED",
        inspectedQuantity: item.inspected_quantity, saleableQuantity: item.saleable_quantity
      })),
      reversalPreviewMinor: items.reduce((sum, item) =>
        sum + item.partner_commission_unit_snapshot_minor * item.quantity, 0),
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()
    };
  }

  async create(actorUserId: string, input: AdminReturnCreateRequest, requestId?: string, idempotencyKey?: string) {
    const parsed = adminReturnCreateRequestSchema.safeParse(input);
    if (!parsed.success || idempotencyKey !== undefined && (!idempotencyKey.trim() || idempotencyKey.length > 100))
      throw new ReturnError("VALIDATION_ERROR");
    input = parsed.data;
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...input,
      items: [...input.items].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)) })).digest("hex");
    const client = await this.pool.connect();
    let returnId = randomUUID();
    try {
      await client.query("BEGIN");
      if (idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`return-create:${actorUserId}:${idempotencyKey}`]);
        const previous = (await client.query("SELECT id,create_fingerprint FROM returns WHERE created_by_admin_user_id=$1 AND create_idempotency_key=$2", [actorUserId, idempotencyKey])).rows[0];
        if (previous) {
          if (previous.create_fingerprint !== fingerprint) throw new ReturnError("IDEMPOTENCY_CONFLICT");
          returnId = previous.id;
          await client.query("COMMIT");
          // Do not await another pool checkout while retaining this client.
          return this.detail(returnId);
        }
      }
      // Return creation locks the Order so it serializes with Order completion
      // and with concurrent Return creation for the same Order.
      const owner = (await client.query("SELECT partner_id_snapshot FROM orders WHERE id=$1", [input.orderId])).rows[0];
      if (owner?.partner_id_snapshot) await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [owner.partner_id_snapshot]);
      const order = (await client.query<{ status: string }>(
        "SELECT status FROM orders WHERE id=$1 FOR UPDATE", [input.orderId])).rows[0];
      if (!order) throw new ReturnError("NOT_FOUND");
      if (!["SHIPPED", "DELIVERED", "COMPLETED"].includes(order.status)) throw new ReturnError("RETURN_NOT_ALLOWED");
      const itemIds = [...new Set(input.items.map((item) => item.orderItemId))].sort();
      const locked = (await client.query<{ id: string; quantity: number }>(
        "SELECT id,quantity FROM order_items WHERE order_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
        [input.orderId, itemIds])).rows;
      const ordered = new Map(locked.map((row) => [row.id, row.quantity]));
      if (input.items.some((item) => !ordered.has(item.orderItemId))) throw new ReturnError("VALIDATION_ERROR");
      const returned = new Map((await client.query<{ order_item_id: string; returned: number }>(
        `SELECT ri.order_item_id,COALESCE(SUM(ri.quantity),0)::int AS returned
         FROM return_items ri JOIN returns r ON r.id=ri.return_id
         WHERE r.order_id=$1 AND r.status IN ('REQUESTED','COMPLETED') AND ri.order_item_id=ANY($2::uuid[])
         GROUP BY ri.order_item_id`, [input.orderId, itemIds])).rows.map((row) => [row.order_item_id, row.returned]));
      for (const item of input.items) {
        if ((returned.get(item.orderItemId) ?? 0) + item.quantity > ordered.get(item.orderItemId)!)
          throw new ReturnError("RETURN_QUANTITY_EXCEEDED");
      }
      const now = new Date();
      await client.query(`INSERT INTO returns (id,order_id,reason,created_by_admin_user_id,created_at,updated_at,create_idempotency_key,create_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`, [returnId, input.orderId, input.reason, actorUserId, now,
          idempotencyKey ?? null, idempotencyKey ? fingerprint : null]);
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
        if (row.status !== "REQUESTED" || !["SHIPPED", "DELIVERED", "COMPLETED"].includes(order.status)) throw new ReturnError("RETURN_NOT_ALLOWED");
        if (!items.length) throw new ReturnError("INTERNAL_INVARIANT_VIOLATION");
        const quantities = (await client.query<{ order_item_id: string; returned: number }>(
          `SELECT ri.order_item_id,SUM(ri.quantity)::int AS returned FROM return_items ri JOIN returns r ON r.id=ri.return_id
           WHERE r.order_id=$1 AND r.status IN ('REQUESTED','COMPLETED') AND ri.order_item_id=ANY($2::uuid[]) GROUP BY ri.order_item_id`,
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
        const economics = (await client.query("SELECT * FROM orders WHERE id=$1", [identity.order_id])).rows[0];
        if (usesNativeInventory(economics)) {
          const amount = Number((await client.query(`SELECT sum(oi.unit_price_minor::bigint*ri.quantity)::text AS amount
            FROM return_items ri JOIN order_items oi ON oi.id=ri.order_item_id WHERE ri.return_id=$1`, [id])).rows[0].amount);
          if (amount > 0) await client.query(`INSERT INTO customer_obligations(id,order_id,operation_key,kind,amount_minor,return_id,actor_user_id,reason,occurred_at)
            VALUES($1,$2,$3,'RETURN_REFUND',$4,$5,$6,'Completed return',$7)`,
          [randomUUID(), identity.order_id, `return:${id}:refund`, amount, id, actorUserId, now]);
          await reconcileOverpayment(client, identity.order_id, actorUserId, now);
        }
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

  async reject(id: string, actorUserId: string, requestId?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = (await client.query(`SELECT r.order_id,o.partner_id_snapshot FROM returns r
        JOIN orders o ON o.id=r.order_id WHERE r.id=$1`, [id])).rows[0];
      if (!identity) throw new ReturnError("NOT_FOUND");
      if (identity.partner_id_snapshot) await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [identity.partner_id_snapshot]);
      await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [identity.order_id]);
      await client.query("SELECT id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE", [identity.order_id]);
      const row = (await client.query<ReturnRow>("SELECT * FROM returns WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new ReturnError("NOT_FOUND");
      if (row.status === "REJECTED") {
        await client.query("COMMIT");
        return this.detail(id);
      }
      if (row.status !== "REQUESTED") throw new ReturnError("RETURN_NOT_ALLOWED");
      const now = new Date();
      await client.query("UPDATE returns SET status='REJECTED',updated_at=$2 WHERE id=$1", [id, now]);
      // The original delivery date/eligible_at never changes. Only affected
      // commissions become unblocked; any other requested Return still gates them.
      await releaseUnaffectedCommissions(client, identity.order_id, now);
      await client.query(`INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
        VALUES ($1,$2,'admin.return.reject','Return',$3,$4,$5,$6)`,
      [randomUUID(), actorUserId, id, requestId ?? null, JSON.stringify({ orderId: row.order_id }), now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof CommissionError) throw new ReturnError(error.code);
      throw error;
    } finally { client.release(); }
    return await this.detail(id);
  }

  // Retained internal/HTTP alias for old clients. Its result uses REJECTED.
  async cancel(id: string, actorUserId: string, requestId?: string) {
    return this.reject(id, actorUserId, requestId);
  }

  async inspect(id: string, actorUserId: string, input: AdminReturnInspection, requestId?: string) {
    const parsed = adminReturnInspectionSchema.safeParse(input);
    if (!parsed.success) throw new ReturnError("VALIDATION_ERROR");
    const data = parsed.data;
    const key = `return-inspection:${data.operationKey}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const identity = (await client.query(`SELECT r.order_id,o.partner_id_snapshot,o.economic_regime,to_jsonb(o)->>'inventory_mode' AS inventory_mode FROM returns r
        JOIN orders o ON o.id=r.order_id WHERE r.id=$1`, [id])).rows[0];
      if (!identity) throw new ReturnError("NOT_FOUND");
      if (!usesNativeInventory(identity)) throw new ReturnError("RETURN_NOT_ALLOWED");
      if (identity.partner_id_snapshot) await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [identity.partner_id_snapshot]);
      const inventory = new NativeInventoryService(this.pool);
      const lines = (await client.query(`SELECT oi.id,oi.variant_id,oi.quantity AS original_quantity,oi.allocated_procurement_cost_minor,
        ri.id AS return_item_id,ri.quantity FROM return_items ri JOIN order_items oi ON oi.id=ri.order_item_id
        WHERE ri.return_id=$1 ORDER BY oi.id`, [id])).rows;
      await inventory.lockCatalog(client, lines.map(line => line.variant_id));
      await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [identity.order_id]);
      await client.query("SELECT id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE", [identity.order_id]);
      const row = (await client.query<ReturnRow>("SELECT * FROM returns WHERE id=$1 FOR UPDATE", [id])).rows[0]!;
      if (row.status !== "COMPLETED") throw new ReturnError("RETURN_NOT_ALLOWED");
      const previous = (await client.query("SELECT * FROM inventory_movements WHERE operation_key=$1 ORDER BY return_item_id", [key])).rows;
      const entries = [...data.items].sort((a,b) => a.returnItemId.localeCompare(b.returnItemId));
      if (previous.length) {
        if (previous.length !== entries.length || previous.some((old, index) => {
          const entry = entries[index]!;
          return !lines.some(line => line.return_item_id === old.return_item_id) || old.return_item_id !== entry.returnItemId
            || old.quantity !== entry.quantity || old.saleable_quantity !== entry.saleableQuantity
            || old.actor_user_id !== actorUserId || old.reason !== data.reason;
        })) throw new ReturnError("IDEMPOTENCY_CONFLICT");
      } else {
        const stocks = await inventory.lockStock(client, lines.map(line => line.variant_id));
        const now = new Date();
        for (const entry of entries) {
          const line = lines.find(line => line.return_item_id === entry.returnItemId);
          if (!line) throw new ReturnError("VALIDATION_ERROR");
          const inspected = (await client.query(`SELECT COALESCE(sum(m.quantity),0)::int AS total,
            COALESCE(sum(m.quantity) FILTER (WHERE m.return_item_id=$2),0)::int AS item
            FROM inventory_movements m JOIN return_items ri ON ri.id=m.return_item_id
            WHERE ri.order_item_id=$1 AND m.kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS')`, [line.id, entry.returnItemId])).rows[0]!;
          if (inspected.item + entry.quantity > line.quantity || inspected.total + entry.quantity > line.original_quantity)
            throw new ReturnError("RETURN_QUANTITY_EXCEEDED");
          await inventory.inspectReturn(client, { actorUserId, operationKey: key, reason: data.reason, occurredAt: now },
            stocks.get(line.variant_id)!, { ...entry, returnedQuantityBefore: inspected.total,
              originalQuantity: line.original_quantity, originalCost: line.allocated_procurement_cost_minor });
        }
        await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,request_id,metadata)
          VALUES($1,$2,'admin.return.inspect','Return',$3,$4,$5)`,
        [randomUUID(), actorUserId, id, requestId ?? null, { operationKey: data.operationKey, items: entries }]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof NativeInventoryError) throw new ReturnError("VALIDATION_ERROR");
      throw error;
    } finally { client.release(); }
    return this.detail(id);
  }
}
