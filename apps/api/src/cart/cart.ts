import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { MAX_CART_LINES, cartItemRequestSchema, type CartView } from "@watch/contracts";
import { computeInventoryAvailability, DEFAULT_INVENTORY_MAX_AGE_SECONDS, type InventorySourceStatus } from "../inventory/availability.js";

export class CartError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "VALIDATION_ERROR" | "PRODUCT_NOT_ACTIVE" | "VARIANT_NOT_ACTIVE"
    | "CART_LINE_LIMIT_EXCEEDED" | "OUT_OF_STOCK" | "INVENTORY_STALE" | "INVENTORY_UNKNOWN"
    | "INTERNAL_INVARIANT_VIOLATION") { super(code); }
}

interface LineRow {
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
    return computeInventoryAvailability({ sourceStatus: row.source_status, sourceQuantity: row.source_quantity,
      lastSuccessfulSyncAt: row.last_successful_sync_at, safetyBuffer: row.safety_buffer ?? 0,
      activeReservations: Number(row.active_reservations), maxAgeSeconds: this.maxAgeSeconds });
  }

  private async project(client: PoolClient, id: string): Promise<CartView> {
    const rows = (await client.query<LineRow>(`
      SELECT ci.variant_id, ci.quantity, v.product_id, v.sku, v.price_minor, v.currency,
        p.slug, p.title, p.status AS product_status, v.status AS variant_status,
        i.source_status, i.source_quantity, i.safety_buffer, i.last_successful_sync_at,
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
    return { id, currency: this.currency, items, totalMinor: Number(total), canCheckout: items.length > 0 && items.every((item) => item.issues.length === 0) };
  }

  read(userId: string): Promise<CartView> { return this.withCart(userId); }

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
      const row = (await client.query<LineRow>("SELECT * FROM inventory_items WHERE variant_id = $1 FOR SHARE", [variantId])).rows[0];
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
