import { dispatchEvent } from "../../apps/api/dist/notifications/dispatch.js";

// Exercise the actual dispatcher with transport/DB fixtures, never Telegram.
const orderId = "00000000-0000-4000-8000-000000000044";
const publicNumber = "W-T44";
const pool = { query: async (sql) => ({ rows: sql.includes("FROM order_items")
  ? [{ title_snapshot: "Watch", quantity: 1, partner_commission_unit_snapshot_minor: 100 }]
  : sql.includes("SELECT public_number") ? [{ public_number: publicNumber, total_minor: 1000, currency: "BYN" }]
  : sql.includes("SELECT currency") ? [{ currency: "BYN" }]
  : [{ id: "admin", user_id: "user", telegram_user_id: "42" }] }) };
const config = { appBaseUrl: "https://app.example", supportContact: "@support", botUsername: "test_bot", adminTelegramIds: new Set(["42"]) };
const paths = new Set();
for (const type of ["PARTNER_ACTIVATED", "ORDER_CREATED", "ORDER_STATUS_CHANGED", "ORDER_CANCELLED", "ORDER_DELIVERY_FAILED",
  "COMMISSION_EARNED", "RETURN_COMPLETED", "INVENTORY_SYNC_FAILED", "PAYOUT_REQUESTED", "PAYOUT_PAID", "PAYOUT_REJECTED"]) {
  await dispatchEvent(pool, { id: "test", type, payload: { orderId, publicNumber, partnerId: "partner", partnerIdSnapshot: "partner",
    toStatus: "SHIPPED", runId: "run", payoutId: "payout", amountMinor: 100, commissionReversalMinor: 100,
    status: type === "PAYOUT_PAID" ? "PAID" : type === "PAYOUT_REJECTED" ? "REJECTED" : "REQUESTED" } }, config,
  async (_, message) => { for (const url of message.match(/https:\/\/app\.example[^\s]+/g) ?? []) paths.add(new URL(url).pathname); });
}
process.stdout.write(JSON.stringify({ orderId, publicNumber, paths: [...paths].sort() }));
