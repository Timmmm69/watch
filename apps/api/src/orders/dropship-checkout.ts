import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LegalDocumentRef, LegalDocumentType } from "@watch/config";
import { dropshipCheckoutRequestSchema, MAX_ORDER_TOTAL_MINOR, type DropshipCheckoutOrder } from "@watch/contracts";
import { NativeInventoryError, NativeInventoryService, allocateCost, inventoryTransaction } from "../inventory/native.js";
import { createOrderCommissions } from "../finance/commissions.js";
import { CheckoutError } from "./checkout.js";
import { insertWithPublicNumberRetry } from "./order-number.js";

interface CommercialRow {
  id: string; product_id: string; sku: string; attributes: unknown; dropship_price_minor: number | null;
  currency: string; status: string; product_status: string; supplier_status: string; title: string; supplier_id: string;
}
interface OrderRow {
  id: string; public_number: string; status: string; currency: string; subtotal_minor: number; total_minor: number;
  partner_terms_document_id: string; privacy_document_id: string; privacy_acknowledged_at: Date;
  created_at: Date; request_fingerprint: string;
}

/** The native implementation of the existing checkout endpoint. No Buyer/cart/referral is created. */
export class DropshipCheckoutService {
  private readonly inventory: NativeInventoryService;
  constructor(private readonly pool: Pool, private readonly currency: string,
    private readonly legal: Partial<Record<LegalDocumentType, LegalDocumentRef>>) {
    this.inventory = new NativeInventoryService(pool);
  }

  private async document(client: PoolClient, type: LegalDocumentType, expectedId: string, now: Date) {
    const ref = this.legal[type];
    if (!ref || expectedId !== ref.id.toLowerCase()) throw new CheckoutError("TERMS_VERSION_CHANGED");
    const row = (await client.query<{ id: string }>(`SELECT id FROM legal_documents
      WHERE id=$1 AND type=$2::"LegalDocumentType" AND version=$3 AND effective_at <= $4`,
    [ref.id, type, ref.version, now])).rows[0];
    if (!row) throw new CheckoutError("TERMS_VERSION_CHANGED");
    return row.id;
  }

  private async project(client: PoolClient, row: OrderRow): Promise<DropshipCheckoutOrder> {
    const remuneration = (await client.query<{ total: number }>(`SELECT COALESCE(SUM(remuneration_total_minor),0)::int AS total
      FROM order_items WHERE order_id=$1`, [row.id])).rows[0]!.total;
    return { id: row.id, publicNumber: row.public_number, status: row.status, currency: row.currency,
      subtotalMinor: row.subtotal_minor, totalMinor: row.total_minor, remunerationTotalMinor: remuneration,
      partnerTermsDocumentId: row.partner_terms_document_id, privacyDocumentId: row.privacy_document_id,
      privacyAcknowledgedAt: row.privacy_acknowledged_at.toISOString(), createdAt: row.created_at.toISOString() };
  }

  async checkout(userId: string, key: unknown, input: unknown): Promise<{ order: DropshipCheckoutOrder; created: boolean }> {
    const parsed = dropshipCheckoutRequestSchema.safeParse(input);
    if (!parsed.success || typeof key !== "string" || !key.trim() || key.length > 100) throw new CheckoutError("VALIDATION_ERROR");
    const request = parsed.data;
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    return inventoryTransaction(this.pool, async (client) => {
      // Partner first, shared with block/status/payout operations. FOR SHARE on User
      // prevents a concurrent user block from passing the eligibility check.
      const partner = (await client.query<{ id: string; status: string }>(
        "SELECT id,status FROM partners WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
      if (!partner) throw new CheckoutError("PARTNER_REQUIRED");
      const user = (await client.query<{ is_blocked: boolean }>("SELECT is_blocked FROM users WHERE id=$1 FOR SHARE", [userId])).rows[0];
      if (!user) throw new CheckoutError("AUTH_REQUIRED");
      if (user.is_blocked) throw new CheckoutError("USER_BLOCKED");
      if (partner.status !== "ACTIVE") throw new CheckoutError("PARTNER_BLOCKED");
      const existing = (await client.query<OrderRow>("SELECT * FROM orders WHERE creator_user_id=$1 AND idempotency_key=$2", [userId, key])).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new CheckoutError("IDEMPOTENCY_CONFLICT");
        return { order: await this.project(client, existing), created: false };
      }
      if (!(await client.query("SELECT 1 FROM inventory_authority WHERE mode='native'")).rowCount) throw new CheckoutError("INVENTORY_UNKNOWN");
      const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      const terms = await this.document(client, "PARTNER_TERMS", request.partnerTermsDocumentId, now);
      const privacy = await this.document(client, "PRIVACY", request.privacyDocumentId, now);
      // The real creator must have accepted the document referenced by this Order.
      if (!(await client.query("SELECT 1 FROM partner_terms_acceptances WHERE partner_id=$1 AND legal_document_id=$2", [partner.id, terms])).rowCount)
        throw new CheckoutError("TERMS_REACCEPT_REQUIRED");
      const ids = request.items.map((line) => line.variantId);
      await this.inventory.lockCatalog(client, ids);
      const commercial = (await client.query<CommercialRow>(`SELECT v.id,v.product_id,v.sku,v.attributes,v.dropship_price_minor,
        v.currency,v.status,p.status AS product_status,p.title,p.supplier_id,s.status AS supplier_status
        FROM product_variants v JOIN products p ON p.id=v.product_id JOIN suppliers s ON s.id=p.supplier_id
        WHERE v.id=ANY($1::uuid[]) ORDER BY v.id`, [ids])).rows;
      if (commercial.length !== ids.length || commercial.some((row) => row.status !== "ACTIVE" || row.product_status !== "ACTIVE"
        || row.supplier_status !== "ACTIVE" || row.dropship_price_minor === null)) throw new CheckoutError("CART_CHANGED", { reason: "ITEM_UNAVAILABLE" });
      if (commercial.some((row) => row.currency !== this.currency) || new Set(commercial.map((row) => row.supplier_id)).size !== 1)
        throw new CheckoutError("INTERNAL_INVARIANT_VIOLATION");
      if (commercial.some((row, i) => row.dropship_price_minor !== request.items[i]!.expectedDropshipPriceMinor)) {
        throw new CheckoutError("PRICE_CHANGED", { items: commercial.map((row) => ({ variantId: row.id, dropshipPriceMinor: row.dropship_price_minor })) });
      }
      let total = 0n;
      for (const [i, row] of commercial.entries()) {
        const line = request.items[i]!;
        if (line.customerUnitPriceMinor < row.dropship_price_minor!) throw new CheckoutError("PRICE_BELOW_D", { variantId: row.id });
        total += BigInt(line.customerUnitPriceMinor) * BigInt(line.quantity);
      }
      if (total > BigInt(MAX_ORDER_TOTAL_MINOR)) throw new CheckoutError("ORDER_TOTAL_LIMIT_EXCEEDED");
      const stocks = await this.inventory.lockStock(client, ids).catch((error: unknown) => {
        if (error instanceof NativeInventoryError && error.message === "UNKNOWN_VARIANT") throw new CheckoutError("INVENTORY_UNKNOWN");
        throw error;
      });
      for (const line of request.items) {
        const stock = stocks.get(line.variantId)!;
        if (!stock.native_initialization_id) throw new CheckoutError("INVENTORY_UNKNOWN");
        if (stock.native_on_hand - stock.native_reserved_quantity - stock.safety_buffer < line.quantity) throw new CheckoutError("OUT_OF_STOCK", { affectedVariantIds: [line.variantId] });
      }
      const id = randomUUID();
      const order = await insertWithPublicNumberRetry(async (publicNumber) => {
        await client.query("SAVEPOINT order_number_insert");
        try {
          const row = (await client.query<OrderRow>(`INSERT INTO orders(id,public_number,supplier_id,origin,economic_regime,
            creator_user_id,partner_id_snapshot,partner_terms_document_id,privacy_document_id,privacy_acknowledged_at,
            commission_eligible_snapshot,currency,subtotal_minor,total_minor,idempotency_key,request_fingerprint,created_at,updated_at)
            VALUES($1,$2,$3,'DROPSHIPPER','DROPSHIP_MARKUP',$4,$5,$6,$7,$8,true,$9,$10,$10,$11,$12,$8,$8) RETURNING *`,
          [id, publicNumber, commercial[0]!.supplier_id, userId, partner.id, terms, privacy, now, this.currency, Number(total), key, fingerprint])).rows[0]!;
          await client.query("RELEASE SAVEPOINT order_number_insert");
          return row;
        } catch (error) { await client.query("ROLLBACK TO SAVEPOINT order_number_insert"); throw error; }
      });
      await client.query(`INSERT INTO order_fulfillment_details(order_id,recipient_name,phone,address,comment,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$6)`, [id, request.recipientName, request.phone, request.address, request.comment, now]);
      for (const [i, row] of commercial.entries()) {
        const line = request.items[i]!, stock = stocks.get(row.id)!;
        const cost = allocateCost(stock.native_free_value_minor, stock.native_on_hand - stock.native_reserved_quantity, line.quantity);
        const markup = line.customerUnitPriceMinor - row.dropship_price_minor!;
        await client.query(`INSERT INTO order_items(id,order_id,variant_id,sku_snapshot,title_snapshot,attributes_snapshot,quantity,
          unit_price_minor,partner_commission_unit_snapshot_minor,line_total_minor,economic_regime,dropship_unit_price_minor,
          customer_unit_price_minor,allocated_procurement_cost_minor,remuneration_total_minor)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DROPSHIP_MARKUP',$11,$8,$12,$13)`,
        [randomUUID(), id, row.id, row.sku, row.title, JSON.stringify(row.attributes), line.quantity, line.customerUnitPriceMinor,
          markup, line.customerUnitPriceMinor * line.quantity, row.dropship_price_minor, cost, markup * line.quantity]);
        await this.inventory.reserve(client, { actorUserId: userId, operationKey: `order:${id}:reserve:${row.id}`,
          reason: "Dropshipper checkout", occurredAt: now }, stock, id, line.quantity);
      }
      await createOrderCommissions(client, id, now);
      await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'order.dropship.created','Order',$3,$4)`, [randomUUID(), userId, id, { partnerId: partner.id }]);
      await client.query(`INSERT INTO events(id,type,aggregate_type,aggregate_id,dedupe_key,payload,created_at)
        VALUES($1,'ORDER_CREATED','Order',$2,$3,$4,$5)`, [randomUUID(), id, `order:${id}:created`,
        { v: 1, orderId: id, publicNumber: order.public_number, partnerIdSnapshot: partner.id, commissionEligibleSnapshot: true }, now]);
      return { order: await this.project(client, order), created: true };
    });
  }
}
