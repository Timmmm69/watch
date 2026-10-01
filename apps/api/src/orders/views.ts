import type { Pool } from "pg";
import {
  type BuyerOrderListQuery,
  type PartnerOrderListQuery,
  type OrderStatus
} from "@watch/contracts";

export class OrderViewError extends Error {
  constructor(public readonly code: "NOT_FOUND") { super(code); }
}

interface OrderRow {
  id: string;
  public_number: string;
  status: OrderStatus;
  currency: string;
  subtotal_minor: number;
  total_minor: number;
  commission_eligible_snapshot: boolean;
  created_at: Date;
  confirmed_at: Date | null;
  fulfilling_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  delivery_failed_at: Date | null;
}

interface ItemRow {
  id: string;
  variant_id: string;
  sku_snapshot: string;
  title_snapshot: string;
  attributes_snapshot: unknown;
  quantity: number;
  unit_price_minor: number;
  line_total_minor: number;
  partner_commission_unit_snapshot_minor: number;
}

interface FulfillmentRow {
  recipient_name: string | null;
  phone: string | null;
  address: string | null;
  comment: string | null;
  redacted_at: Date | null;
}

function timeline(row: OrderRow) {
  return [
    { status: "PLACED" as const, at: row.created_at.toISOString() },
    ...Object.entries({
      CONFIRMED: row.confirmed_at,
      FULFILLING: row.fulfilling_at,
      SHIPPED: row.shipped_at,
      DELIVERED: row.delivered_at,
      COMPLETED: row.completed_at,
      CANCELLED: row.cancelled_at,
      DELIVERY_FAILED: row.delivery_failed_at
    }).flatMap(([status, at]) => (at ? [{ status: status as OrderStatus, at: at.toISOString() }] : []))
  ];
}

function baseDetail(row: OrderRow, supportContact: string) {
  return {
    id: row.id,
    publicNumber: row.public_number,
    status: row.status,
    currency: row.currency,
    subtotalMinor: row.subtotal_minor,
    totalMinor: row.total_minor,
    commissionEligibleSnapshot: row.commission_eligible_snapshot,
    timeline: timeline(row),
    supportContact,
    createdAt: row.created_at.toISOString()
  };
}

export class OrderViewService {
  constructor(private readonly pool: Pool, private readonly supportContact: string) {}

  async listBuyerOrders(buyerId: string, query: BuyerOrderListQuery) {
    const values: unknown[] = [buyerId];
    const predicates = ["buyer_user_id = $1"];
    if (query.status) {
      values.push(query.status);
      predicates.push(`status = $${values.length}`);
    }
    const where = predicates.join(" AND ");
    const total = Number((await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM orders WHERE ${where}`, values
    )).rows[0]!.total);
    const rows = (await this.pool.query<OrderRow & { item_count: string }>(
      `SELECT o.*, (SELECT count(*)::text FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o WHERE ${where} ORDER BY o.created_at DESC, o.id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit, (query.page - 1) * query.limit]
    )).rows;
    return {
      items: rows.map((row) => ({
        id: row.id,
        publicNumber: row.public_number,
        status: row.status,
        totalMinor: row.total_minor,
        currency: row.currency,
        itemCount: Number(row.item_count),
        createdAt: row.created_at.toISOString()
      })),
      total,
      page: query.page,
      limit: query.limit
    };
  }

  async getBuyerOrder(buyerId: string, publicNumber: string) {
    const row = (await this.pool.query<OrderRow>(
      "SELECT * FROM orders WHERE buyer_user_id = $1 AND public_number = $2",
      [buyerId, publicNumber]
    )).rows[0];
    if (!row) throw new OrderViewError("NOT_FOUND");
    const items = await this.loadItems(row.id);
    const fulfillment = await this.loadFulfillment(row.id);
    return {
      ...baseDetail(row, this.supportContact),
      items: items.map((item) => ({
        id: item.id,
        variantId: item.variant_id,
        sku: item.sku_snapshot,
        title: item.title_snapshot,
        attributes: item.attributes_snapshot as Record<string, unknown>,
        quantity: item.quantity,
        unitPriceMinor: item.unit_price_minor,
        lineTotalMinor: item.line_total_minor
      })),
      fulfillment: fulfillment?.redacted_at ? null : {
        recipientName: fulfillment?.recipient_name ?? null,
        phone: fulfillment?.phone ?? null,
        address: fulfillment?.address ?? null,
        comment: fulfillment?.comment ?? null,
        redactedAt: fulfillment?.redacted_at?.toISOString() ?? null
      }
    };
  }

  async listPartnerOrders(partnerId: string, query: PartnerOrderListQuery) {
    const values: unknown[] = [partnerId];
    const predicates = ["partner_id_snapshot = $1"];
    if (query.status) {
      values.push(query.status);
      predicates.push(`status = $${values.length}`);
    }
    const where = predicates.join(" AND ");
    const total = Number((await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM orders WHERE ${where}`, values
    )).rows[0]!.total);
    const rows = (await this.pool.query<OrderRow & { item_count: string }>(
      `SELECT o.*, (SELECT count(*)::text FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o WHERE ${where} ORDER BY o.created_at DESC, o.id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit, (query.page - 1) * query.limit]
    )).rows;
    return {
      items: rows.map((row) => ({
        id: row.id,
        publicNumber: row.public_number,
        status: row.status,
        totalMinor: row.total_minor,
        currency: row.currency,
        commissionEligibleSnapshot: row.commission_eligible_snapshot,
        itemCount: Number(row.item_count),
        createdAt: row.created_at.toISOString()
      })),
      total,
      page: query.page,
      limit: query.limit
    };
  }

  async getPartnerOrder(partnerId: string, publicNumber: string) {
    const row = (await this.pool.query<OrderRow>(
      "SELECT * FROM orders WHERE partner_id_snapshot = $1 AND public_number = $2",
      [partnerId, publicNumber]
    )).rows[0];
    if (!row) throw new OrderViewError("NOT_FOUND");
    const items = await this.loadItems(row.id);
    return {
      ...baseDetail(row, this.supportContact),
      items: items.map((item) => ({
        id: item.id,
        variantId: item.variant_id,
        sku: item.sku_snapshot,
        title: item.title_snapshot,
        attributes: item.attributes_snapshot as Record<string, unknown>,
        quantity: item.quantity,
        unitPriceMinor: item.unit_price_minor,
        lineTotalMinor: item.line_total_minor,
        partnerCommissionUnitSnapshotMinor: item.partner_commission_unit_snapshot_minor
      }))
    };
  }

  private async loadItems(orderId: string): Promise<ItemRow[]> {
    return (await this.pool.query<ItemRow>(
      `SELECT id, variant_id, sku_snapshot, title_snapshot, attributes_snapshot, quantity,
              unit_price_minor, line_total_minor, partner_commission_unit_snapshot_minor
       FROM order_items WHERE order_id = $1 ORDER BY id`,
      [orderId]
    )).rows;
  }

  private async loadFulfillment(orderId: string): Promise<FulfillmentRow | undefined> {
    return (await this.pool.query<FulfillmentRow>(
      `SELECT recipient_name, phone, address, comment, redacted_at
       FROM order_fulfillment_details WHERE order_id = $1`,
      [orderId]
    )).rows[0];
  }
}
