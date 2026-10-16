import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { INVENTORY_SYNC_LOCK } from "./orchestrator.js";

// Distinct from sync: ordinary legacy checkout must not contend with periodic sync.
export const INVENTORY_CUTOVER_LOCK = [1463899203,2] as const;

export class NativeInventoryError extends Error {}
export interface InventoryOperation {
  actorUserId: string; operationKey: string; reason: string; occurredAt: Date;
}
export interface NativeStock {
  variant_id: string; native_initialization_id: string | null; native_on_hand: number;
  native_reserved_quantity: number; native_free_value_minor: number | null;
  native_reserved_known_value_minor: number; native_reserved_unknown_quantity: number; safety_buffer: number;
}
export interface NativeReservation {
  id: string; variant_id: string; economic_regime: string; status: string;
  quantity: number; allocated_procurement_cost_minor: number | null;
}
export function validateOperation(op: InventoryOperation): void {
  if (!op.operationKey.trim() || op.operationKey.length > 200 || !op.reason.trim() || op.reason.length > 500
    || !Number.isFinite(op.occurredAt.getTime()) || op.occurredAt > new Date()) throw new NativeInventoryError("INVALID_OPERATION");
}
export function minorInteger(value: number, max = 2147483647): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new NativeInventoryError("INVALID_QUANTITY_OR_VALUE");
}
export function allocateCost(value: number | null, free: number, quantity: number): number | null {
  if (free <= 0 || quantity <= 0 || quantity > free) throw new NativeInventoryError("INSUFFICIENT_STOCK");
  return value === null ? null : Number(BigInt(value) * BigInt(quantity) / BigInt(free));
}
export async function inventoryTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function assertInventoryMode(pool: Pick<Pool, "query">, mode: string | undefined, requireInitialization=true): Promise<void> {
  const selected = await pool.query("SELECT 1 FROM inventory_authority");
  if (selected.rowCount && mode !== "native") throw new NativeInventoryError("NATIVE_AUTHORITY_CONFIG_REQUIRED");
  if (mode === "native" && !selected.rowCount && requireInitialization) throw new NativeInventoryError("NATIVE_INITIALIZATION_REQUIRED");
  const initialized = await pool.query("SELECT 1 FROM inventory_items WHERE native_initialization_id IS NOT NULL LIMIT 1");
  if (initialized.rowCount && (!selected.rowCount || mode !== "native")) throw new NativeInventoryError("NATIVE_CUTOVER_REQUIRED");
}

/** Existing-row order: Partner → Products → Variants → Order → OrderItems →
 * Reservations → InventoryItems. Use the split locks when an existing Order is
 * involved. No network calls in reservation/receipt transactions. */
export class NativeInventoryService {
  constructor(private readonly pool: Pool) {}

  async lockCatalog(client: PoolClient, variantIds: string[]): Promise<void> {
    const ids = [...new Set(variantIds)].sort();
    await client.query(`SELECT id FROM products WHERE id IN
      (SELECT product_id FROM product_variants WHERE id=ANY($1::uuid[])) ORDER BY id FOR UPDATE`, [ids]);
    await client.query("SELECT id FROM product_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
  }

  async lockStock(client: PoolClient, variantIds: string[]): Promise<Map<string, NativeStock>> {
    const ids=[...new Set(variantIds)].sort();
    const rows = await client.query<NativeStock>("SELECT * FROM inventory_items WHERE variant_id=ANY($1::uuid[]) ORDER BY variant_id FOR UPDATE", [ids]);
    if (rows.rowCount !== ids.length) throw new NativeInventoryError("UNKNOWN_VARIANT");
    return new Map(rows.rows.map(row => [row.variant_id, row]));
  }

  async lock(client: PoolClient, variantIds: string[]): Promise<Map<string, NativeStock>> {
    await this.lockCatalog(client,variantIds);
    return this.lockStock(client,variantIds);
  }

  async write(client: PoolClient, stock: NativeStock, op: InventoryOperation, movement: {
    kind: "INITIALIZATION" | "RECEIPT" | "CORRECTION" | "VALUATION" | "RESERVE" | "RELEASE" | "SHIPMENT" | "RETURN_INSPECTION";
    quantity: number; cost: number | null; onHandDelta: number; reservedDelta?: number;
    initializationId?: string; reservationId?: string; returnItemId?: string;
    returnedQuantityBefore?: number; saleableQuantity?: number; saleableCost?: number | null;
  }): Promise<void> {
    validateOperation(op);
    const id = randomUUID();
    await client.query(`UPDATE inventory_items SET native_initialization_id=$2,native_on_hand=$3,
      native_reserved_quantity=$4,native_free_value_minor=$5,native_reserved_known_value_minor=$6,
      native_reserved_unknown_quantity=$7,updated_at=now() WHERE variant_id=$1`,
    [stock.variant_id, stock.native_initialization_id, stock.native_on_hand, stock.native_reserved_quantity,
      stock.native_free_value_minor, stock.native_reserved_known_value_minor, stock.native_reserved_unknown_quantity]);
    await client.query(`INSERT INTO inventory_movements(id,operation_key,variant_id,sequence,kind,quantity,
      on_hand_delta,reserved_delta,procurement_cost_minor,initialization_id,reservation_id,on_hand_after,
      reserved_quantity_after,free_value_after_minor,reserved_known_value_after_minor,reserved_unknown_quantity_after,
      actor_user_id,reason,occurred_at,return_item_id,returned_quantity_before,saleable_quantity,saleable_cost_minor)
      VALUES($1,$2,$3,(SELECT COALESCE(max(sequence),0)+1 FROM inventory_movements WHERE variant_id=$3),
      $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [id,op.operationKey,stock.variant_id,movement.kind,movement.quantity,movement.onHandDelta,movement.reservedDelta ?? 0,
      movement.cost,movement.initializationId ?? null,movement.reservationId ?? null,stock.native_on_hand,
      stock.native_reserved_quantity,stock.native_free_value_minor,stock.native_reserved_known_value_minor,
      stock.native_reserved_unknown_quantity,op.actorUserId,op.reason,op.occurredAt,movement.returnItemId ?? null,
      movement.returnedQuantityBefore ?? null,movement.saleableQuantity ?? null,movement.saleableCost ?? null]);
    await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,$2,'inventory.native.movement','inventory_movement',$3,$4)`,
    [randomUUID(),op.actorUserId,id,{ variantId: stock.variant_id, kind: movement.kind, operationKey: op.operationKey }]);
    // Existing durable event stream; no new notification type is needed.
    await client.query(`INSERT INTO events(id,type,aggregate_type,aggregate_id,dedupe_key,payload)
      VALUES($1,'INVENTORY_NATIVE_CHANGED','inventory_item',$2,$3,$4)`,
    [randomUUID(),stock.variant_id,`inventory-movement:${id}`,{v:1,movementId:id,variantId:stock.variant_id}]);
  }

  async initialize(client: PoolClient, op: InventoryOperation, initializationId: string,
    entries: {variantId: string; quantity: number; cost: number | null}[]): Promise<void> {
    const stocks = await this.lock(client, entries.map(e => e.variantId));
    for (const entry of entries) {
      minorInteger(entry.quantity); if (entry.cost !== null) minorInteger(entry.cost);
      if (entry.quantity === 0 && entry.cost !== 0) throw new NativeInventoryError("EMPTY_STOCK_COST_MUST_BE_ZERO");
      const stock = stocks.get(entry.variantId)!;
      if (stock.native_initialization_id) throw new NativeInventoryError("ALREADY_INITIALIZED");
      Object.assign(stock,{native_initialization_id:initializationId,native_on_hand:entry.quantity,
        native_reserved_quantity:0,native_free_value_minor:entry.cost,native_reserved_known_value_minor:0,native_reserved_unknown_quantity:0});
      await this.write(client,stock,op,{kind:"INITIALIZATION",quantity:entry.quantity,cost:entry.cost,
        onHandDelta:entry.quantity,initializationId});
    }
  }

  async change(op: InventoryOperation, variantId: string, kind: "RECEIPT" | "CORRECTION" | "VALUATION",
    quantity: number, cost: number | null): Promise<{replayed: boolean}> {
    validateOperation(op);
    if (!Number.isInteger(quantity) || Math.abs(quantity)>2147483647 || (kind==="VALUATION" ? quantity!==0 || cost===null : quantity===0)
      || kind==="RECEIPT" && quantity<0) throw new NativeInventoryError("INVALID_QUANTITY");
    if (cost!==null) minorInteger(cost);
    if (quantity<0 && cost!==null) throw new NativeInventoryError("CORRECTION_COST_IS_SERVER_ALLOCATED");
    return inventoryTransaction(this.pool,async client => {
      // One manual operation key across SKU/kind, before catalog/stock locks.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-operation:' || $1::text,0))",[op.operationKey]);
      const stock = (await this.lock(client,[variantId])).get(variantId)!;
      if (!stock.native_initialization_id) throw new NativeInventoryError("NOT_INITIALIZED");
      const previous = await client.query(`SELECT * FROM inventory_movements WHERE operation_key=$1
        AND kind IN ('RECEIPT','CORRECTION','VALUATION')`, [op.operationKey]);
      if ((previous.rowCount ?? 0)>1) throw new NativeInventoryError("IDEMPOTENCY_CONFLICT");
      const old = previous.rows[0];
      if (old) {
        // Negative corrections allocate server-side: supplied cost must be null.
        if (old.variant_id!==variantId || old.kind!==kind || old.quantity!==quantity || (quantity>=0 && old.procurement_cost_minor!==cost) || old.actor_user_id!==op.actorUserId
          || old.reason!==op.reason || old.occurred_at.getTime()!==op.occurredAt.getTime()) throw new NativeInventoryError("IDEMPOTENCY_CONFLICT");
        return {replayed:true};
      }
      const free = stock.native_on_hand-stock.native_reserved_quantity;
      let allocated = cost;
      if (kind==="VALUATION") {
        if (free===0 && cost!==0) throw new NativeInventoryError("EMPTY_STOCK_COST_MUST_BE_ZERO");
        stock.native_free_value_minor=cost;
      } else if (quantity>0) {
        stock.native_free_value_minor=free===0 ? cost : stock.native_free_value_minor===null || cost===null ? null : stock.native_free_value_minor+cost;
        stock.native_on_hand+=quantity;
      } else {
        allocated=allocateCost(stock.native_free_value_minor,free,-quantity);
        stock.native_on_hand+=quantity;
        stock.native_free_value_minor=free===-quantity ? 0 : allocated===null ? null : stock.native_free_value_minor!-allocated;
      }
      minorInteger(stock.native_on_hand);
      if (stock.native_free_value_minor!==null) minorInteger(stock.native_free_value_minor+stock.native_reserved_known_value_minor);
      await this.write(client,stock,op,{kind,quantity,cost:allocated,onHandDelta:quantity});
      return {replayed:false};
    });
  }

  /** Within the Order transaction, after catalog/stock locks. Caller first
   * uses allocateCost under that lock to insert the matching immutable OrderItem;
   * T46 checks that its cost and this reservation allocation agree. */
  async reserve(client: PoolClient, op: InventoryOperation, stock: NativeStock,
    orderId: string, quantity: number): Promise<{id: string; cost: number | null}> {
    validateOperation(op); minorInteger(quantity,99);
    if (!stock.native_initialization_id) throw new NativeInventoryError("NOT_INITIALIZED");
    const free=stock.native_on_hand-stock.native_reserved_quantity;
    if (quantity>free-stock.safety_buffer) throw new NativeInventoryError("INSUFFICIENT_STOCK");
    const cost=allocateCost(stock.native_free_value_minor,free,quantity);
    const id=randomUUID();
    await client.query(`INSERT INTO inventory_reservations(id,order_id,variant_id,quantity,economic_regime,allocated_procurement_cost_minor)
      VALUES($1,$2,$3,$4,'DROPSHIP_MARKUP',$5)`,[id,orderId,stock.variant_id,quantity,cost]);
    stock.native_reserved_quantity+=quantity;
    stock.native_free_value_minor=quantity===free ? 0 : cost===null ? null : stock.native_free_value_minor!-cost;
    stock.native_reserved_known_value_minor+=cost ?? 0;
    stock.native_reserved_unknown_quantity+=cost===null ? quantity : 0;
    await this.write(client,stock,op,{kind:"RESERVE",quantity,cost,onHandDelta:0,reservedDelta:quantity,reservationId:id});
    return {id,cost};
  }

  async selectAuthority(client: PoolClient, op: InventoryOperation): Promise<void> {
    validateOperation(op);
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",[...INVENTORY_SYNC_LOCK]);
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",[...INVENTORY_CUTOVER_LOCK]);
    await client.query(`INSERT INTO inventory_authority(singleton_id,mode,actor_user_id,reason)
      VALUES(1,'native',$1,$2) ON CONFLICT DO NOTHING`,[op.actorUserId,op.reason]);
  }

  /** Stock part of pre-shipment cancellation. Caller has already locked the
   * Order and reservation before InventoryItem, and commits Order effects too. */
  async release(client: PoolClient, op: InventoryOperation, stock: NativeStock, row:NativeReservation):Promise<void> {
    validateOperation(op);
    if(!row || row.variant_id!==stock.variant_id || row.economic_regime!=="DROPSHIP_MARKUP")throw new NativeInventoryError("UNKNOWN_RESERVATION");
    if(row.status==="RELEASED")return;
    if(row.status!=="ACTIVE")throw new NativeInventoryError("RESERVATION_NOT_ACTIVE");
    const free=stock.native_on_hand-stock.native_reserved_quantity;
    const cost=row.allocated_procurement_cost_minor;
    stock.native_free_value_minor=free===0 ? cost : cost===null || stock.native_free_value_minor===null ? null : stock.native_free_value_minor+cost;
    stock.native_reserved_quantity-=row.quantity;
    stock.native_reserved_known_value_minor-=cost ?? 0;
    stock.native_reserved_unknown_quantity-=cost===null ? row.quantity : 0;
    await client.query("UPDATE inventory_reservations SET status='RELEASED',released_at=$2 WHERE id=$1",[row.id,op.occurredAt]);
    await this.write(client,stock,op,{kind:"RELEASE",quantity:row.quantity,cost,onHandDelta:0,
      reservedDelta:-row.quantity,reservationId:row.id});
  }

  /** Caller holds catalog → Order → OrderItems → Reservations → Stock locks. */
  async ship(client: PoolClient, op: InventoryOperation, stock: NativeStock, row: NativeReservation): Promise<void> {
    if (row.variant_id !== stock.variant_id || row.economic_regime !== "DROPSHIP_MARKUP" || row.status !== "ACTIVE")
      throw new NativeInventoryError("RESERVATION_NOT_ACTIVE");
    const cost = row.allocated_procurement_cost_minor;
    stock.native_on_hand -= row.quantity;
    stock.native_reserved_quantity -= row.quantity;
    stock.native_reserved_known_value_minor -= cost ?? 0;
    stock.native_reserved_unknown_quantity -= cost === null ? row.quantity : 0;
    await client.query("UPDATE inventory_reservations SET status='CONSUMED',consumed_at=$2 WHERE id=$1", [row.id, op.occurredAt]);
    await this.write(client, stock, op, { kind: "SHIPMENT", quantity: row.quantity, cost,
      onHandDelta: -row.quantity, reservedDelta: -row.quantity, reservationId: row.id });
  }

  /** One inspected batch, including damaged units. The non-saleable cost remains
   * in this immutable fact as a loss (cost minus saleableCost), never an expense. */
  async inspectReturn(client: PoolClient, op: InventoryOperation, stock: NativeStock, item: {
    returnItemId: string; quantity: number; saleableQuantity: number; returnedQuantityBefore: number;
    originalQuantity: number; originalCost: number | null;
  }): Promise<void> {
    const slice = (quantity: number) => item.originalCost === null ? null : Number(
      BigInt(item.originalCost) * BigInt(item.returnedQuantityBefore + quantity) / BigInt(item.originalQuantity)
      - BigInt(item.originalCost) * BigInt(item.returnedQuantityBefore) / BigInt(item.originalQuantity));
    const cost = slice(item.quantity), saleableCost = slice(item.saleableQuantity);
    if (item.saleableQuantity > 0) {
      const free = stock.native_on_hand - stock.native_reserved_quantity;
      stock.native_free_value_minor = free === 0 ? saleableCost
        : stock.native_free_value_minor === null || saleableCost === null ? null : stock.native_free_value_minor + saleableCost;
      stock.native_on_hand += item.saleableQuantity;
    }
    minorInteger(stock.native_on_hand);
    if (stock.native_free_value_minor !== null) minorInteger(stock.native_free_value_minor + stock.native_reserved_known_value_minor);
    await this.write(client, stock, op, { kind: "RETURN_INSPECTION", quantity: item.quantity, cost,
      onHandDelta: item.saleableQuantity, returnItemId: item.returnItemId,
      returnedQuantityBefore: item.returnedQuantityBefore, saleableQuantity: item.saleableQuantity, saleableCost });
  }
}
