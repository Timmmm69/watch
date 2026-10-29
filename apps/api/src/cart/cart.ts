import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { MAX_CART_LINES, cartItemRequestSchema, type CartView } from "@watch/contracts";
import { computeInventoryAvailability, DEFAULT_INVENTORY_MAX_AGE_SECONDS, type InventorySourceStatus } from "../inventory/availability.js";

export class CartError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "VALIDATION_ERROR" | "PRODUCT_NOT_ACTIVE" | "VARIANT_NOT_ACTIVE"
    | "CART_LINE_LIMIT_EXCEEDED" | "OUT_OF_STOCK" | "INVENTORY_STALE" | "INVENTORY_UNKNOWN"
    | "INTERNAL_INVARIANT_VIOLATION" | "CONTEXT_CONFIRMATION_REQUIRED" | "REFERRAL_UNAVAILABLE") { super(code); }
}

export type CartPurchaseContext = { channel: "DIRECT" | "REFERRAL"; expiresAt: string | null; referralProductId: string | null };

interface LineRow {
  native_authority?: boolean; native_on_hand?: number | null; native_reserved_quantity?: number | null;
  variant_id: string; product_id: string; slug: string; title: string; sku: string; quantity: number;
  price_minor: number; currency: string; product_status: string; variant_status: string;
  source_status: InventorySourceStatus | null; source_quantity: number | null;
  last_successful_sync_at: Date | null; safety_buffer: number | null;
  active_reservations: string;
}

export class CartService {
  constructor(private readonly pool: Pool, private readonly currency: string,
    private readonly maxAgeSeconds = DEFAULT_INVENTORY_MAX_AGE_SECONDS) {}

  // All reads/mutations serialize on the persistent Cart, including concurrent lazy creation.
  private async withCart(userId: string, change?: (client: PoolClient, cartId: string) => Promise<void>): Promise<CartView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO carts (id, buyer_user_id) VALUES ($1, $2) ON CONFLICT (buyer_user_id) DO NOTHING", [randomUUID(), userId]);
      const cart = (await client.query<{ id: string }>("SELECT id FROM carts WHERE buyer_user_id = $1 FOR UPDATE", [userId])).rows[0]!;
      if (change) {
        await change(client, cart.id);
        await client.query("UPDATE carts SET updated_at = now() WHERE id = $1", [cart.id]);
      }
      const view = await this.project(client, cart.id);
      await client.query("COMMIT");
      return view;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private availability(row: LineRow) {
    return computeInventoryAvailability({ native: row.native_authority, nativeOnHand: row.native_on_hand,
      nativeReservedQuantity: row.native_reserved_quantity, sourceStatus: row.source_status, sourceQuantity: row.source_quantity,
      lastSuccessfulSyncAt: row.last_successful_sync_at, safetyBuffer: row.safety_buffer ?? 0,
      activeReservations: Number(row.active_reservations), maxAgeSeconds: this.maxAgeSeconds });
  }

  private async project(client: PoolClient, id: string): Promise<CartView> {
    const supportsContext = (await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='carts'::regclass AND attname='purchase_channel' AND NOT attisdropped) AS exists")).rows[0]!.exists;
    let context: { purchase_channel: "DIRECT" | "REFERRAL"; attribution_touch_id: string | null; attribution_expires_at: Date | null; product_id: string | null; partner_name: string | null; source_active: boolean; pending_id: string | null; pending_expires_at: Date | null; pending_product_id: string | null; pending_partner_name: string | null; pending_source_active: boolean } | undefined;
    if (supportsContext) context = (await client.query<{ purchase_channel: "DIRECT" | "REFERRAL"; attribution_touch_id: string | null; attribution_expires_at: Date | null; product_id: string | null; partner_name: string | null; source_active: boolean; pending_id: string | null; pending_expires_at: Date | null; pending_product_id: string | null; pending_partner_name: string | null; pending_source_active: boolean }>(`
      SELECT c.purchase_channel,c.attribution_touch_id,c.attribution_expires_at,l.product_id,pu.first_name AS partner_name,COALESCE(l.status='ACTIVE' AND p.status='ACTIVE' AND NOT pu.is_blocked,false) AS source_active,pt.id AS pending_id,pt.expires_at AS pending_expires_at,pl.product_id AS pending_product_id,ppu.first_name AS pending_partner_name,COALESCE(pl.status='ACTIVE' AND pp.status='ACTIVE' AND NOT ppu.is_blocked,false) AS pending_source_active
      FROM carts c LEFT JOIN attribution_touches t ON t.id=c.attribution_touch_id LEFT JOIN referral_links l ON l.id=t.referral_link_id LEFT JOIN partners p ON p.id=t.partner_id LEFT JOIN users pu ON pu.id=p.user_id
      LEFT JOIN attribution_touches pt ON pt.id=c.pending_attribution_touch_id LEFT JOIN referral_links pl ON pl.id=pt.referral_link_id LEFT JOIN partners pp ON pp.id=pt.partner_id LEFT JOIN users ppu ON ppu.id=pp.user_id
      WHERE c.id=$1`, [id])).rows[0];
    const rows = (await client.query<LineRow>(`
      SELECT ci.variant_id, ci.quantity, v.product_id, v.sku, v.price_minor, v.currency,
        p.slug, p.title, p.status AS product_status, v.status AS variant_status,
        i.source_status, i.source_quantity, i.safety_buffer, i.last_successful_sync_at,
        EXISTS(SELECT 1 FROM inventory_authority) AS native_authority,i.native_on_hand,i.native_reserved_quantity,
        (SELECT COALESCE(SUM(r.quantity), 0)::text FROM inventory_reservations r
          WHERE r.variant_id = v.id AND r.status = 'ACTIVE') AS active_reservations
      FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id
      JOIN products p ON p.id = v.product_id LEFT JOIN inventory_items i ON i.variant_id = v.id
      WHERE ci.cart_id = $1 ORDER BY ci.created_at, ci.variant_id`, [id])).rows;
    let total = 0n;
    const items: CartView["items"] = rows.map((row) => {
      if (row.currency !== this.currency) throw new CartError("INTERNAL_INVARIANT_VIOLATION");
      const inventory = this.availability(row);
      const issues: CartView["items"][number]["issues"] = [];
      if (row.product_status !== "ACTIVE" || row.variant_status !== "ACTIVE") issues.push("ITEM_UNAVAILABLE");
      if (inventory.availability === "UNKNOWN") issues.push("INVENTORY_UNKNOWN");
      else if (inventory.availability === "STALE") issues.push("INVENTORY_STALE");
      else if (inventory.sellable < row.quantity) issues.push("OUT_OF_STOCK");
      const lineTotal = BigInt(row.price_minor) * BigInt(row.quantity);
      total += lineTotal;
      return { variantId: row.variant_id, productId: row.product_id, slug: row.slug, title: row.title, sku: row.sku,
        quantity: row.quantity, priceMinor: row.price_minor, lineTotalMinor: Number(lineTotal),
        availability: inventory.availability, issues };
    });
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new CartError("INTERNAL_INVARIANT_VIOLATION");
    const activeReferral = context?.purchase_channel === "REFERRAL" && context.attribution_expires_at && context.attribution_expires_at > new Date() && context.source_active;
    const active = activeReferral ? context! : undefined;
    return { id, currency: this.currency, items, totalMinor: Number(total), canCheckout: items.length > 0 && items.every((item) => item.issues.length === 0),
      purchaseContext: { channel: context?.purchase_channel === "REFERRAL" ? "REFERRAL" : "DIRECT", available: context?.purchase_channel !== "REFERRAL" || !!active, touchId: context?.attribution_touch_id ?? null, expiresAt: context?.attribution_expires_at?.toISOString() ?? null,
        referralProductId: context?.product_id ?? null, partnerDisplayName: context?.partner_name ?? null },
      pendingReferral: context?.pending_id && context.pending_expires_at && context.pending_expires_at > new Date() && context.pending_source_active ? { touchId: context.pending_id, expiresAt: context.pending_expires_at.toISOString(), referralProductId: context.pending_product_id, partnerDisplayName: context.pending_partner_name ?? "Партнёр" } : null };
  }

  read(userId: string): Promise<CartView> { return this.withCart(userId); }

  async chooseContext(userId: string, context: { channel: "DIRECT" } | { channel: "REFERRAL"; touchId: string }, confirmReplace: boolean): Promise<CartView> {
    return this.withCart(userId, async (client, cartId) => {
      const count = Number((await client.query<{ count: string }>("SELECT count(*)::text AS count FROM cart_items WHERE cart_id=$1", [cartId])).rows[0]!.count);
      const current = (await client.query<{ purchase_channel: string; attribution_touch_id: string | null }>("SELECT purchase_channel,attribution_touch_id FROM carts WHERE id=$1 FOR UPDATE", [cartId])).rows[0]!;
      const changing = context.channel !== current.purchase_channel || (context.channel === "REFERRAL" && context.touchId !== current.attribution_touch_id);
      if (count && changing && !confirmReplace) throw new CartError("CONTEXT_CONFIRMATION_REQUIRED" as never);
      if (count && changing) await client.query("DELETE FROM cart_items WHERE cart_id=$1", [cartId]);
      if (context.channel === "DIRECT") await client.query("UPDATE carts SET purchase_channel='DIRECT',attribution_touch_id=NULL,attribution_expires_at=NULL,pending_attribution_touch_id=NULL WHERE id=$1", [cartId]);
      else {
        const touch = (await client.query<{ id: string; expires_at: Date }>(`SELECT t.id,t.expires_at FROM attribution_touches t
          JOIN referral_links l ON l.id=t.referral_link_id JOIN partners p ON p.id=t.partner_id JOIN users u ON u.id=p.user_id
          WHERE t.id=$1 AND t.buyer_user_id=$2 AND p.user_id <> $2 AND t.expires_at>now() AND l.status='ACTIVE' AND p.status='ACTIVE' AND NOT u.is_blocked`, [context.touchId,userId])).rows[0];
        if (!touch) throw new CartError("REFERRAL_UNAVAILABLE" as never);
        const pending = (await client.query<{ pending_attribution_touch_id: string | null }>("SELECT pending_attribution_touch_id FROM carts WHERE id=$1",[cartId])).rows[0];
        if (!pending || pending.pending_attribution_touch_id !== context.touchId) throw new CartError("REFERRAL_UNAVAILABLE" as never);
        await client.query("UPDATE carts SET purchase_channel='REFERRAL',attribution_touch_id=$2,attribution_expires_at=$3,pending_attribution_touch_id=NULL WHERE id=$1", [cartId,touch.id,touch.expires_at]);
      }
    });
  }

  put(userId: string, variantId: string, quantity: number): Promise<CartView> {
    if (!cartItemRequestSchema.safeParse({ quantity }).success) return Promise.reject(new CartError("VALIDATION_ERROR"));
    return this.withCart(userId, async (client, cartId) => {
      const lines = (await client.query<{ variant_id: string }>("SELECT variant_id FROM cart_items WHERE cart_id = $1", [cartId])).rows;
      if (!lines.some((line) => line.variant_id === variantId) && lines.length >= MAX_CART_LINES) throw new CartError("CART_LINE_LIMIT_EXCEEDED");
      const reference = (await client.query<{ product_id: string }>("SELECT product_id FROM product_variants WHERE id = $1", [variantId])).rows[0];
      if (!reference) throw new CartError("NOT_FOUND");
      // Match the global Cart -> Product -> Variant -> Inventory lock order.
      const product = (await client.query<{ status: string }>("SELECT status FROM products WHERE id = $1 FOR SHARE", [reference.product_id])).rows[0];
      if (!product || product.status !== "ACTIVE") throw new CartError("PRODUCT_NOT_ACTIVE");
      const variant = (await client.query<{ status: string; currency: string }>("SELECT status, currency FROM product_variants WHERE id = $1 FOR SHARE", [variantId])).rows[0]!;
      if (variant.status !== "ACTIVE") throw new CartError("VARIANT_NOT_ACTIVE");
      if (variant.currency !== this.currency) throw new CartError("INTERNAL_INVARIANT_VIOLATION");
      const row = (await client.query<LineRow>("SELECT *, EXISTS(SELECT 1 FROM inventory_authority) AS native_authority FROM inventory_items WHERE variant_id = $1 FOR SHARE", [variantId])).rows[0];
      if (!row) throw new CartError("INVENTORY_UNKNOWN");
      row.active_reservations = (await client.query<{ quantity: string }>(
        "SELECT COALESCE(SUM(quantity), 0)::text AS quantity FROM inventory_reservations WHERE variant_id = $1 AND status = 'ACTIVE'", [variantId])).rows[0]!.quantity;
      const inventory = this.availability(row);
      if (inventory.availability === "UNKNOWN") throw new CartError("INVENTORY_UNKNOWN");
      if (inventory.availability === "STALE") throw new CartError("INVENTORY_STALE");
      if (inventory.sellable < quantity) throw new CartError("OUT_OF_STOCK");
      await client.query(`INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, $3)
        ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`, [cartId, variantId, quantity]);
    });
  }

  remove(userId: string, variantId: string): Promise<CartView> {
    return this.withCart(userId, async (client, cartId) => {
      await client.query("DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2", [cartId, variantId]);
    });
  }

  clear(userId: string): Promise<CartView> {
    return this.withCart(userId, async (client, cartId) => {
      await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
    });
  }
}
