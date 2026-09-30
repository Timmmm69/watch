import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LegalDocumentRef, LegalDocumentType } from "@watch/config";
import { checkoutRequestSchema, MAX_CART_LINES, MAX_ORDER_TOTAL_MINOR, type CheckoutRequest, type CheckoutOrder } from "@watch/contracts";
import { computeInventoryAvailability, DEFAULT_INVENTORY_MAX_AGE_SECONDS, type InventorySourceStatus } from "../inventory/availability.js";
import { partnerProgramMutationAllowed, partnerTermsCurrent, type PartnerStatus } from "../partner/partner.js";
import { insertWithPublicNumberRetry } from "./order-number.js";

export class CheckoutError extends Error {
  constructor(public readonly code: "VALIDATION_ERROR" | "USER_BLOCKED" | "AUTH_REQUIRED" | "CART_EMPTY" | "CART_CHANGED"
    | "CART_LINE_LIMIT_EXCEEDED" | "ORDER_TOTAL_LIMIT_EXCEEDED" | "PRICE_CHANGED" | "OUT_OF_STOCK"
    | "INVENTORY_STALE" | "INVENTORY_UNKNOWN" | "TERMS_VERSION_CHANGED" | "IDEMPOTENCY_CONFLICT"
    | "INTERNAL_INVARIANT_VIOLATION", public readonly details: Record<string, unknown> = {}) { super(code); }
}

export function normalizeCheckout(input: unknown): CheckoutRequest {
  const parsed = checkoutRequestSchema.safeParse(input);
  if (!parsed.success) throw new CheckoutError("VALIDATION_ERROR");
  return parsed.data;
}

export function checkoutFingerprint(request: CheckoutRequest): string {
  // Re-parse so object insertion order, UUID case, optional comment and line order are canonical.
  return createHash("sha256").update(JSON.stringify(normalizeCheckout(request))).digest("hex");
}

interface StoredOrder {
  id: string; public_number: string; status: string; currency: string; subtotal_minor: number; total_minor: number;
  sales_terms_document_id: string; privacy_document_id: string; sales_terms_accepted_at: Date;
  privacy_acknowledged_at: Date; created_at: Date; request_fingerprint: string;
}
function project(row: StoredOrder): CheckoutOrder {
  return { id: row.id, publicNumber: row.public_number, status: row.status, currency: row.currency,
    subtotalMinor: row.subtotal_minor, totalMinor: row.total_minor, salesTermsDocumentId: row.sales_terms_document_id,
    privacyDocumentId: row.privacy_document_id, salesTermsAcceptedAt: row.sales_terms_accepted_at.toISOString(),
    privacyAcknowledgedAt: row.privacy_acknowledged_at.toISOString(), createdAt: row.created_at.toISOString() };
}
interface Line { variant_id: string; quantity: number }
interface CommercialRow {
  id: string; product_id: string; sku: string; attributes: unknown; price_minor: number; currency: string;
  partner_commission_unit_minor: number; supplier_settlement_unit_minor: number | null; status: string;
  product_status: string; title: string; supplier_id: string;
}
interface InventoryRow {
  source_status: InventorySourceStatus; source_quantity: number | null; safety_buffer: number;
  last_successful_sync_at: Date | null;
}
function checkedMoney(value: bigint): number {
  if (value < 0n || value > 2_147_483_647n) throw new CheckoutError("ORDER_TOTAL_LIMIT_EXCEEDED");
  return Number(value);
}

export class CheckoutService {
  constructor(private readonly pool: Pool, private readonly currency: string,
    private readonly legal: Partial<Record<LegalDocumentType, LegalDocumentRef>>,
    private readonly maxAgeSeconds = DEFAULT_INVENTORY_MAX_AGE_SECONDS) {}

  private async currentDocument(client: PoolClient, type: LegalDocumentType, now: Date) {
    const ref = this.legal[type];
    if (!ref) throw new CheckoutError("TERMS_VERSION_CHANGED");
    const row = (await client.query<{ id: string; requires_reacceptance: boolean }>(`
      SELECT id, requires_reacceptance FROM legal_documents
      WHERE id = $1 AND type = $2::"LegalDocumentType" AND version = $3 AND effective_at <= $4`,
    [ref.id, type, ref.version, now])).rows[0];
    if (!row) throw new CheckoutError("TERMS_VERSION_CHANGED");
    return row;
  }

  async checkout(buyerId: string, key: unknown, input: unknown): Promise<{ order: CheckoutOrder; created: boolean }> {
    if (typeof key !== "string" || key.length < 1 || key.length > 100 || key.trim().length === 0) {
      throw new CheckoutError("VALIDATION_ERROR");
    }
    const request = normalizeCheckout(input);
    const fingerprint = checkoutFingerprint(request);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const buyer = (await client.query<{ is_blocked: boolean }>("SELECT is_blocked FROM users WHERE id = $1 FOR UPDATE", [buyerId])).rows[0];
      if (!buyer) throw new CheckoutError("AUTH_REQUIRED");
      if (buyer.is_blocked) throw new CheckoutError("USER_BLOCKED");
      const existing = (await client.query<StoredOrder>("SELECT * FROM orders WHERE buyer_user_id = $1 AND idempotency_key = $2", [buyerId, key])).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new CheckoutError("IDEMPOTENCY_CONFLICT");
        await client.query("COMMIT");
        return { order: project(existing), created: false };
      }
      // Use the serialization time after waiting for Buyer, rather than a stale BEGIN timestamp.
      const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      const touch = (await client.query<{ id: string; partner_id: string }>(`
        SELECT id, partner_id FROM attribution_touches WHERE buyer_user_id = $1
          AND occurred_at <= $2 AND expires_at > $2 ORDER BY occurred_at DESC, id DESC LIMIT 1`, [buyerId, now])).rows[0];
      let eligible = false;
      if (touch) {
        const partner = (await client.query<{ id: string; user_id: string; status: PartnerStatus }>(
          "SELECT id, user_id, status FROM partners WHERE id = $1 FOR UPDATE", [touch.partner_id])).rows[0]!;
        const terms = await this.currentDocument(client, "PARTNER_TERMS", now);
        const accepted = (await client.query("SELECT 1 FROM partner_terms_acceptances WHERE partner_id = $1 AND legal_document_id = $2", [partner.id, terms.id])).rowCount !== 0;
        const user = (await client.query<{ is_blocked: boolean }>("SELECT is_blocked FROM users WHERE id = $1", [partner.user_id])).rows[0];
        eligible = partner.user_id !== buyerId && partnerProgramMutationAllowed({ userBlocked: user?.is_blocked ?? true,
          partnerStatus: partner.status, partnerTermsCurrent: partnerTermsCurrent(terms.requires_reacceptance, accepted) });
      }
      const cart = (await client.query<{ id: string }>("SELECT id FROM carts WHERE buyer_user_id = $1 FOR UPDATE", [buyerId])).rows[0];
      if (!cart) throw new CheckoutError("CART_EMPTY");
      const lines = (await client.query<Line>("SELECT variant_id, quantity FROM cart_items WHERE cart_id = $1 ORDER BY variant_id", [cart.id])).rows;
      if (!lines.length) throw new CheckoutError("CART_EMPTY");
      if (lines.length > MAX_CART_LINES) throw new CheckoutError("CART_LINE_LIMIT_EXCEEDED");
      const ids = lines.map((line) => line.variant_id);
      const ownership = (await client.query<{ product_id: string }>("SELECT product_id FROM product_variants WHERE id = ANY($1::uuid[])", [ids])).rows;
      const products = [...new Set(ownership.map((row) => row.product_id))].sort();
      await client.query("SELECT id FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [products]);
      await client.query("SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
      const commercial = (await client.query<CommercialRow>(`SELECT v.*, p.status AS product_status, p.title, p.supplier_id
        FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[]) ORDER BY v.id`, [ids])).rows;
      await client.query("SELECT variant_id FROM inventory_items WHERE variant_id = ANY($1::uuid[]) ORDER BY variant_id FOR UPDATE", [ids]);
      const unavailable = commercial.filter((row) => row.status !== "ACTIVE" || row.product_status !== "ACTIVE").map((row) => row.id);
      if (unavailable.length) throw new CheckoutError("CART_CHANGED", { reason: "ITEM_UNAVAILABLE", affectedVariantIds: unavailable });
      if (commercial.length !== lines.length || commercial.some((row) => !products.includes(row.product_id) || row.currency !== this.currency)
        || new Set(commercial.map((row) => row.supplier_id)).size !== 1) throw new CheckoutError("INTERNAL_INVARIANT_VIOLATION");
      for (const line of lines) {
        const inventory = (await client.query<InventoryRow>("SELECT * FROM inventory_items WHERE variant_id = $1", [line.variant_id])).rows[0];
        // No Reservation locks after InventoryItem; re-read committed sums after the shared stock lock.
        const reserved = (await client.query<{ quantity: string }>("SELECT COALESCE(SUM(quantity), 0)::text AS quantity FROM inventory_reservations WHERE variant_id = $1 AND status = 'ACTIVE'", [line.variant_id])).rows[0]!.quantity;
        const availability = computeInventoryAvailability({ sourceStatus: inventory?.source_status ?? null,
          sourceQuantity: inventory?.source_quantity ?? null, lastSuccessfulSyncAt: inventory?.last_successful_sync_at ?? null,
          safetyBuffer: inventory?.safety_buffer ?? 0, activeReservations: Number(reserved), maxAgeSeconds: this.maxAgeSeconds, now: new Date() });
        const details = { affectedVariantIds: [line.variant_id] };
        if (availability.availability === "UNKNOWN") throw new CheckoutError("INVENTORY_UNKNOWN", details);
        if (availability.availability === "STALE") throw new CheckoutError("INVENTORY_STALE", details);
        if (availability.sellable < line.quantity) throw new CheckoutError("OUT_OF_STOCK", details);
      }
      if (lines.length !== request.items.length || lines.some((line, index) => line.variant_id !== request.items[index]!.variantId
        || line.quantity !== request.items[index]!.quantity)) throw new CheckoutError("CART_CHANGED");
      const changedPrices = commercial.filter((row, index) => row.price_minor !== request.items[index]!.expectedUnitPriceMinor).map((row) => row.id);
      if (changedPrices.length) throw new CheckoutError("PRICE_CHANGED", { affectedVariantIds: changedPrices });
      let total = 0n;
      let commissionGross = 0n;
      let settlementGross = 0n;
      const totals = commercial.map((row, index) => {
        const quantity = BigInt(lines[index]!.quantity);
        const lineTotal = checkedMoney(BigInt(row.price_minor) * quantity);
        commissionGross += BigInt(row.partner_commission_unit_minor) * quantity;
        checkedMoney(commissionGross);
        if (row.supplier_settlement_unit_minor !== null) {
          settlementGross += BigInt(row.supplier_settlement_unit_minor) * quantity;
          checkedMoney(settlementGross);
        }
        total += BigInt(lineTotal);
        return lineTotal;
      });
      if (total > BigInt(MAX_ORDER_TOTAL_MINOR)) throw new CheckoutError("ORDER_TOTAL_LIMIT_EXCEEDED");
      const sales = await this.currentDocument(client, "SALES_TERMS", now);
      const privacy = await this.currentDocument(client, "PRIVACY", now);
      if (sales.id !== request.salesTermsDocumentId || privacy.id !== request.privacyDocumentId) throw new CheckoutError("TERMS_VERSION_CHANGED");
      const id = randomUUID();
      const order = await insertWithPublicNumberRetry(async (publicNumber) => {
        await client.query("SAVEPOINT order_number_insert");
        try {
          const row = (await client.query<StoredOrder>(`INSERT INTO orders
            (id, public_number, buyer_user_id, supplier_id, attribution_touch_id, partner_id_snapshot, commission_eligible_snapshot,
             currency, subtotal_minor, total_minor, sales_terms_document_id, privacy_document_id, sales_terms_accepted_at,
             privacy_acknowledged_at, idempotency_key, request_fingerprint, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$12,$13,$14,$12,$12) RETURNING *`,
          [id, publicNumber, buyerId, commercial[0]!.supplier_id, touch?.id ?? null, touch?.partner_id ?? null, eligible,
            this.currency, checkedMoney(total), sales.id, privacy.id, now, key, fingerprint])).rows[0]!;
          await client.query("RELEASE SAVEPOINT order_number_insert");
          return row;
        } catch (error) { await client.query("ROLLBACK TO SAVEPOINT order_number_insert"); throw error; }
      });
      await client.query(`INSERT INTO order_fulfillment_details (order_id, recipient_name, phone, address, comment, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6)`, [id, request.recipientName, request.phone, request.address, request.comment, now]);
      for (const [index, row] of commercial.entries()) {
        await client.query(`INSERT INTO order_items (id, order_id, variant_id, sku_snapshot, title_snapshot, attributes_snapshot,
          quantity, unit_price_minor, partner_commission_unit_snapshot_minor, supplier_settlement_unit_snapshot_minor, line_total_minor)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), id, row.id, row.sku, row.title, JSON.stringify(row.attributes),
          lines[index]!.quantity, row.price_minor, row.partner_commission_unit_minor, row.supplier_settlement_unit_minor, totals[index]]);
        await client.query("INSERT INTO inventory_reservations (id, order_id, variant_id, quantity, created_at) VALUES ($1,$2,$3,$4,$5)",
          [randomUUID(), id, row.id, lines[index]!.quantity, now]);
      }
      const payload = { v: 1, orderId: id, publicNumber: order.public_number,
        ...(touch ? { partnerIdSnapshot: touch.partner_id } : {}), commissionEligibleSnapshot: eligible };
      await client.query(`INSERT INTO events (id, type, aggregate_type, aggregate_id, dedupe_key, payload, created_at)
        VALUES ($1,'ORDER_CREATED','Order',$2,$3,$4,$5)`, [randomUUID(), id, `order:${id}:created`, JSON.stringify(payload), now]);
      await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cart.id]);
      await client.query("UPDATE carts SET updated_at = $2 WHERE id = $1", [cart.id, now]);
      await client.query("COMMIT");
      return { order: project(order), created: true };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
