import type { Pool } from "pg";
import type { OutboxEvent } from "./outbox.js";

export class BlockedError extends Error {
  constructor() { super("Recipient blocked the bot"); }
}

interface DispatchConfig {
  appBaseUrl: string;
  supportContact: string;
  botUsername: string;
}

interface Recipient {
  userId: string;
  telegramUserId: string;
}

interface OrderSummary {
  publicNumber: string;
  totalMinor: number;
  currency: string;
  items: { title: string; quantity: number; partnerCommissionUnitMinor: number }[];
}

function formatMoney(amountMinor: number, currency: string): string {
  const major = (amountMinor / 100).toFixed(2);
  return `${major} ${currency}`;
}

function orderUrl(appBaseUrl: string, publicNumber: string, role: "buyer" | "partner" | "admin"): string {
  const path = role === "admin" ? `/admin/orders/${publicNumber}`
    : role === "partner" ? `/partner/orders/${publicNumber}`
    : `/orders/${publicNumber}`;
  return `${appBaseUrl}${path}`;
}

async function loadOrderSummary(pool: Pool, orderId: string): Promise<OrderSummary | null> {
  const order = (await pool.query<{ public_number: string; total_minor: number; currency: string }>(
    "SELECT public_number, total_minor, currency FROM orders WHERE id = $1", [orderId]
  )).rows[0];
  if (!order) return null;
  const items = (await pool.query<{ title_snapshot: string; quantity: number; partner_commission_unit_snapshot_minor: number }>(
    `SELECT title_snapshot, quantity, partner_commission_unit_snapshot_minor FROM order_items
     WHERE order_id = $1 ORDER BY id`, [orderId]
  )).rows;
  return {
    publicNumber: order.public_number,
    totalMinor: order.total_minor,
    currency: order.currency,
    items: items.map((item) => ({
      title: item.title_snapshot,
      quantity: item.quantity,
      partnerCommissionUnitMinor: item.partner_commission_unit_snapshot_minor
    }))
  };
}

async function loadPartnerRecipient(pool: Pool, partnerId: string): Promise<Recipient | null> {
  const row = (await pool.query<{ user_id: string; telegram_user_id: string }>(
    `SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id
     FROM partners p JOIN users u ON u.id = p.user_id
     WHERE p.id = $1 AND u.bot_can_message = true`, [partnerId]
  )).rows[0];
  return row ? { userId: row.user_id, telegramUserId: row.telegram_user_id } : null;
}

async function loadBuyerRecipient(pool: Pool, orderId: string): Promise<Recipient | null> {
  const row = (await pool.query<{ user_id: string; telegram_user_id: string }>(
    `SELECT u.id AS user_id, u.telegram_user_id::text AS telegram_user_id
     FROM orders o JOIN users u ON u.id = o.buyer_user_id
     WHERE o.id = $1 AND u.bot_can_message = true`, [orderId]
  )).rows[0];
  return row ? { userId: row.user_id, telegramUserId: row.telegram_user_id } : null;
}

async function loadAdminRecipients(pool: Pool): Promise<Recipient[]> {
  return (await pool.query<{ id: string; telegram_user_id: string }>(
    "SELECT id, telegram_user_id::text AS telegram_user_id FROM users WHERE is_admin = true AND bot_can_message = true"
  )).rows.map((row) => ({ userId: row.id, telegramUserId: row.telegram_user_id }));
}

async function trySend(
  pool: Pool,
  recipient: Recipient,
  text: string,
  send: (chatId: string, text: string) => Promise<void>
): Promise<{ blocked?: boolean; error?: Error }> {
  try {
    await send(recipient.telegramUserId, text);
    return {};
  } catch (error) {
    if (error instanceof BlockedError) {
      await pool.query("UPDATE users SET bot_can_message = false WHERE id = $1", [recipient.userId]);
      return { blocked: true };
    }
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function sendAll(
  pool: Pool,
  recipients: Recipient[],
  text: string,
  send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const retryable: Error[] = [];
  for (const recipient of recipients) {
    const result = await trySend(pool, recipient, text, send);
    if (result.error) retryable.push(result.error);
  }
  return retryable;
}

function statusLabel(status: string): string {
  switch (status) {
    case "CONFIRMED": return "подтверждён";
    case "FULFILLING": return "собирается";
    case "SHIPPED": return "отправлен";
    case "DELIVERED": return "доставлен";
    case "CANCELLED": return "отменён";
    case "DELIVERY_FAILED": return "не доставлен";
    case "COMPLETED": return "завершён";
    default: return status;
  }
}

function pendingCommissionText(summary: OrderSummary): string {
  const total = summary.items.reduce((sum, item) =>
    sum + BigInt(item.partnerCommissionUnitMinor) * BigInt(item.quantity), 0n);
  if (total === 0n) return "Комиссия: 0 (заказ без партнёрского вознаграждения)";
  return `Ожидаемая комиссия: ${formatMoney(Number(total), summary.currency)}`;
}

function productSummaryText(summary: OrderSummary): string {
  const first = summary.items[0]!;
  if (summary.items.length === 1) return first.title;
  return `${first.title} и ещё ${summary.items.length - 1} поз.`;
}

async function dispatchPartnerActivated(
  pool: Pool, payload: { partnerId?: unknown }, config: DispatchConfig, send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const partnerId = typeof payload.partnerId === "string" ? payload.partnerId : null;
  if (!partnerId) return [];
  const recipient = await loadPartnerRecipient(pool, partnerId);
  if (!recipient) return [];
  const text = `Поздравляем! Вы стали партнёром. Откройте дашборд: ${config.appBaseUrl}/partner`;
  return sendAll(pool, [recipient], text, send);
}

async function dispatchOrderCreated(
  pool: Pool, payload: { orderId?: unknown; publicNumber?: unknown; partnerIdSnapshot?: unknown },
  config: DispatchConfig, send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
  if (!orderId) return [];
  const summary = await loadOrderSummary(pool, orderId);
  if (!summary) return [];
  const errors: Error[] = [];
  const publicNumber = typeof payload.publicNumber === "string" ? payload.publicNumber : summary.publicNumber;
  const product = productSummaryText(summary);
  if (typeof payload.partnerIdSnapshot === "string") {
    const recipient = await loadPartnerRecipient(pool, payload.partnerIdSnapshot);
    if (recipient) {
      const text = [
        `Новый заказ ${publicNumber} по вашей ссылке.`,
        `Товар: ${product}.`,
        `Сумма: ${formatMoney(summary.totalMinor, summary.currency)}.`,
        pendingCommissionText(summary),
        `Подробнее: ${orderUrl(config.appBaseUrl, publicNumber, "partner")}`
      ].join("\n");
      errors.push(...await sendAll(pool, [recipient], text, send));
    }
  }
  const admins = await loadAdminRecipients(pool);
  if (admins.length) {
    const text = `Новый заказ ${publicNumber} (${formatMoney(summary.totalMinor, summary.currency)}). ${product}. ${orderUrl(config.appBaseUrl, publicNumber, "admin")}`;
    errors.push(...await sendAll(pool, admins, text, send));
  }
  return errors;
}

const BUYER_NOTIFICATION_STATUSES = new Set(["CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED", "DELIVERY_FAILED"]);

async function dispatchOrderStatusChanged(
  pool: Pool, payload: { orderId?: unknown; toStatus?: unknown; publicNumber?: unknown },
  config: DispatchConfig, send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
  const toStatus = typeof payload.toStatus === "string" ? payload.toStatus : null;
  if (!orderId || !toStatus || !BUYER_NOTIFICATION_STATUSES.has(toStatus)) return [];
  const recipient = await loadBuyerRecipient(pool, orderId);
  if (!recipient) return [];
  const publicNumber = typeof payload.publicNumber === "string" ? payload.publicNumber : (await loadOrderSummary(pool, orderId))?.publicNumber ?? orderId;
  const text = `Заказ ${publicNumber}: ${statusLabel(toStatus)}. Подробнее: ${orderUrl(config.appBaseUrl, publicNumber, "buyer")}`;
  return sendAll(pool, [recipient], text, send);
}

async function dispatchOrderTerminal(
  pool: Pool,
  payload: { orderId?: unknown; publicNumber?: unknown; partnerIdSnapshot?: unknown },
  kind: "CANCELLED" | "DELIVERY_FAILED",
  config: DispatchConfig,
  send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
  const partnerId = typeof payload.partnerIdSnapshot === "string" ? payload.partnerIdSnapshot : null;
  if (!orderId || !partnerId) return [];
  const summary = await loadOrderSummary(pool, orderId);
  if (!summary) return [];
  const recipient = await loadPartnerRecipient(pool, partnerId);
  if (!recipient) return [];
  const publicNumber = typeof payload.publicNumber === "string" ? payload.publicNumber : summary.publicNumber;
  const label = kind === "CANCELLED" ? "отменён" : "не доставлен";
  const totalCommission = summary.items.reduce((sum, item) =>
    sum + BigInt(item.partnerCommissionUnitMinor) * BigInt(item.quantity), 0n);
  const impact = totalCommission === 0n
    ? "Комиссия по заказу не начислялась."
    : `Влияние на комиссию: ${formatMoney(Number(totalCommission), summary.currency)} не будет начислено.`;
  const text = `Заказ ${publicNumber} ${label}. ${impact} ${orderUrl(config.appBaseUrl, publicNumber, "partner")}`;
  return sendAll(pool, [recipient], text, send);
}

async function dispatchInventorySyncFailed(
  pool: Pool, payload: { runId?: unknown; providerKey?: unknown },
  config: DispatchConfig, send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (!runId) return [];
  const admins = await loadAdminRecipients(pool);
  if (!admins.length) return [];
  const text = `Ошибка синхронизации запасов ${runId}. Проверьте инвентарь: ${config.appBaseUrl}/admin/inventory`;
  return sendAll(pool, admins, text, send);
}

async function dispatchCommissionEarned(
  pool: Pool, payload: { partnerId?: unknown; orderId?: unknown; amountMinor?: unknown },
  config: DispatchConfig, send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const partnerId = typeof payload.partnerId === "string" ? payload.partnerId : null;
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
  const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : 0;
  if (!partnerId || !orderId) return [];
  const recipient = await loadPartnerRecipient(pool, partnerId);
  if (!recipient) return [];
  const summary = await loadOrderSummary(pool, orderId);
  const currency = summary?.currency ?? "";
  const publicNumber = summary?.publicNumber ?? orderId;
  const text = `Комиссия ${formatMoney(amountMinor, currency)} по заказу ${publicNumber} доступна к выплате. ${orderUrl(config.appBaseUrl, publicNumber, "partner")}`;
  return sendAll(pool, [recipient], text, send);
}

async function dispatchReturnCompleted(
  pool: Pool, payload: { orderId?: unknown; partnerIdSnapshot?: unknown; commissionReversalMinor?: unknown },
  config: DispatchConfig, send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
  const partnerId = typeof payload.partnerIdSnapshot === "string" ? payload.partnerIdSnapshot : null;
  const reversal = typeof payload.commissionReversalMinor === "number" ? payload.commissionReversalMinor : 0;
  if (!orderId || !partnerId || reversal <= 0) return [];
  const recipient = await loadPartnerRecipient(pool, partnerId);
  if (!recipient) return [];
  const summary = await loadOrderSummary(pool, orderId);
  const currency = summary?.currency ?? "";
  const publicNumber = summary?.publicNumber ?? orderId;
  const text = `По заказу ${publicNumber} оформлен возврат. Удержано из комиссии: ${formatMoney(reversal, currency)}. ${orderUrl(config.appBaseUrl, publicNumber, "partner")}`;
  return sendAll(pool, [recipient], text, send);
}

async function dispatchPayout(
  pool: Pool, payload: { partnerId?: unknown; amountMinor?: unknown; status?: unknown; payoutId?: unknown },
  config: DispatchConfig, send: (chatId: string, text: string) => Promise<void>
): Promise<Error[]> {
  const partnerId = typeof payload.partnerId === "string" ? payload.partnerId : null;
  const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : 0;
  const status = typeof payload.status === "string" ? payload.status : null;
  if (!partnerId || !status) return [];
  const recipient = await loadPartnerRecipient(pool, partnerId);
  const errors: Error[] = [];
  const currency = (await loadOrderSummary(pool, typeof payload.payoutId === "string" ? payload.payoutId : ""))?.currency ?? "";
  if (recipient) {
    let label = "";
    if (status === "REQUESTED") label = "запрошена";
    else if (status === "PAID") label = "выплачена";
    else if (status === "REJECTED") label = "отклонена";
    const text = `Выплата ${formatMoney(amountMinor, currency)} ${label}. ${config.appBaseUrl}/partner/payouts`;
    errors.push(...await sendAll(pool, [recipient], text, send));
  }
  if (status === "REQUESTED") {
    const admins = await loadAdminRecipients(pool);
    if (admins.length) {
      const text = `Партнёр запросил выплату ${formatMoney(amountMinor, currency)}. ${config.appBaseUrl}/admin/payouts`;
      errors.push(...await sendAll(pool, admins, text, send));
    }
  }
  return errors;
}

export async function dispatchEvent(
  pool: Pool,
  event: OutboxEvent,
  config: DispatchConfig,
  send: (chatId: string, text: string) => Promise<void>
): Promise<void> {
  const payload = event.payload as Record<string, unknown>;
  let retryable: Error[] = [];
  switch (event.type) {
    case "PARTNER_ACTIVATED":
      retryable = await dispatchPartnerActivated(pool, payload, config, send);
      break;
    case "ORDER_CREATED":
      retryable = await dispatchOrderCreated(pool, payload, config, send);
      break;
    case "ORDER_STATUS_CHANGED":
      retryable = await dispatchOrderStatusChanged(pool, payload, config, send);
      break;
    case "ORDER_CANCELLED":
      retryable = await dispatchOrderTerminal(pool, payload, "CANCELLED", config, send);
      break;
    case "ORDER_DELIVERY_FAILED":
      retryable = await dispatchOrderTerminal(pool, payload, "DELIVERY_FAILED", config, send);
      break;
    case "INVENTORY_SYNC_FAILED":
      retryable = await dispatchInventorySyncFailed(pool, payload, config, send);
      break;
    case "COMMISSION_EARNED":
      retryable = await dispatchCommissionEarned(pool, payload, config, send);
      break;
    case "RETURN_COMPLETED":
      retryable = await dispatchReturnCompleted(pool, payload, config, send);
      break;
    case "PAYOUT_REQUESTED":
    case "PAYOUT_PAID":
    case "PAYOUT_REJECTED":
      retryable = await dispatchPayout(pool, payload, config, send);
      break;
    default:
      // Unknown event types are acknowledged without notification to avoid infinite retry.
      return;
  }
  if (retryable.length) {
    const summary = retryable.map((e) => e.message).join("; ").slice(0, 200);
    throw new Error(`Notification delivery failed: ${summary}`);
  }
}
