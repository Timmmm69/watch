import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export class CommissionError extends Error {
  readonly code = "INTERNAL_INVARIANT_VIOLATION";
  constructor() { super("INTERNAL_INVARIANT_VIOLATION"); }
}
interface Commission {
  id: string; partner_id: string; order_id: string;
  gross_amount_minor: number; reversed_amount_minor: number;
  state: "PENDING" | "HOLD" | "EARNED" | "VOID";
}
interface Entry {
  partner_id: string; commission_id: string; bucket: "PENDING" | "AVAILABLE";
  amount_minor: number; entry_type: string; transaction_group_id: string;
}

// Use the caller's transaction and locks: Partner → Order → sorted OrderItems,
// then any reservations/inventory, then sorted Commissions. No independent commit.
export async function lockOrderCommissions(client: PoolClient, orderId: string) {
  return (await client.query<Commission>(
    "SELECT * FROM commissions WHERE order_id=$1 ORDER BY id FOR UPDATE", [orderId])).rows;
}
async function existingEntry(client: PoolClient, key: string) {
  return (await client.query<Entry>("SELECT * FROM ledger_entries WHERE idempotency_key=$1", [key])).rows[0];
}
function matches(entry: Entry, commission: Commission, type: string, bucket: string, amount: number) {
  if (entry.partner_id !== commission.partner_id || entry.commission_id !== commission.id
    || entry.entry_type !== type || entry.bucket !== bucket || entry.amount_minor !== amount) throw new CommissionError();
}
async function append(client: PoolClient, commission: Commission, type: string, bucket: string,
  amount: number, key: string, group: string, now: Date) {
  await client.query(`INSERT INTO ledger_entries (id,partner_id,commission_id,bucket,amount_minor,
    entry_type,transaction_group_id,idempotency_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [randomUUID(),commission.partner_id,commission.id,bucket,amount,type,group,key,now]);
}

export async function createOrderCommissions(client: PoolClient, orderId: string, now: Date) {
  const rows = (await client.query<Commission>(`INSERT INTO commissions
    (id,partner_id,order_id,order_item_id,quantity,unit_amount_minor,gross_amount_minor,created_at,updated_at)
    SELECT gen_random_uuid(),o.partner_id_snapshot,o.id,i.id,i.quantity,i.partner_commission_unit_snapshot_minor,
      (i.quantity::bigint*i.partner_commission_unit_snapshot_minor)::integer,$2,$2
    FROM orders o JOIN order_items i ON i.order_id=o.id
    WHERE o.id=$1 AND o.commission_eligible_snapshot AND i.partner_commission_unit_snapshot_minor>0
    ORDER BY i.id RETURNING *`, [orderId,now])).rows;
  const group = randomUUID();
  for (const commission of rows) await append(client,commission,"COMMISSION_CREATE","PENDING",
    commission.gross_amount_minor,`commission:${commission.id}:create`,group,now);
}
export async function holdOrderCommissions(client: PoolClient, orderId: string, eligibleAt: Date, now: Date) {
  await lockOrderCommissions(client,orderId);
  await client.query(`UPDATE commissions SET state='HOLD',eligible_at=$2,updated_at=$3
    WHERE order_id=$1 AND state='PENDING'`, [orderId,eligibleAt,now]);
}

// T29 owns due-date/OPEN Return checks and Order completion. Exact retries return
// zero; only the first release emits COMMISSION_EARNED with the actual net amount.
export async function releaseCommission(client: PoolClient, commissionId: string, now: Date) {
  const commission = (await client.query<Commission>("SELECT * FROM commissions WHERE id=$1 FOR UPDATE", [commissionId])).rows[0];
  if (!commission) throw new CommissionError();
  const pendingKey = `commission:${commissionId}:release:pending`;
  const availableKey = `commission:${commissionId}:release:available`;
  const pending = await existingEntry(client,pendingKey);
  const available = await existingEntry(client,availableKey);
  if (pending || available) {
    if (!pending || !available || pending.transaction_group_id !== available.transaction_group_id
      || available.amount_minor <= 0 || !["EARNED","VOID"].includes(commission.state)) throw new CommissionError();
    matches(pending,commission,"COMMISSION_RELEASE","PENDING",-available.amount_minor);
    matches(available,commission,"COMMISSION_RELEASE","AVAILABLE",available.amount_minor);
    return 0;
  }
  const net = commission.gross_amount_minor - commission.reversed_amount_minor;
  if (commission.state === "VOID" && net === 0) return 0;
  if (commission.state !== "HOLD" || net <= 0) throw new CommissionError();
  const group = randomUUID();
  await append(client,commission,"COMMISSION_RELEASE","PENDING",-net,pendingKey,group,now);
  await append(client,commission,"COMMISSION_RELEASE","AVAILABLE",net,availableKey,group,now);
  await client.query("UPDATE commissions SET state='EARNED',available_at=$2,updated_at=$2 WHERE id=$1", [commissionId,now]);
  await client.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,created_at)
    VALUES ($1,'COMMISSION_EARNED','Commission',$2,$3,$4,$5)`, [randomUUID(),commissionId,
    `commission:${commissionId}:earned`,JSON.stringify({ v: 1,commissionId,partnerId: commission.partner_id,
      orderId: commission.order_id,amountMinor: net }),now]);
  return net;
}

// operationKey identifies a terminal Order transition or future completed Return.
// Retries carry the original delta, even after subsequent release/reversals.
export async function reverseCommission(client: PoolClient, commissionId: string, amount: number,
  operationKey: string, now: Date) {
  const commission = (await client.query<Commission>("SELECT * FROM commissions WHERE id=$1 FOR UPDATE", [commissionId])).rows[0];
  if (!commission || !Number.isSafeInteger(amount) || amount <= 0) throw new CommissionError();
  const key = `commission:${commissionId}:reversal:${operationKey}`;
  if (key.length > 200) throw new CommissionError();
  const existing = await existingEntry(client,key);
  if (existing) {
    matches(existing,commission,"COMMISSION_REVERSAL",existing.bucket,-amount);
    return 0;
  }
  const reversed = commission.reversed_amount_minor + amount;
  if (commission.state === "VOID" || reversed > commission.gross_amount_minor) throw new CommissionError();
  await append(client,commission,"COMMISSION_REVERSAL",commission.state === "EARNED" ? "AVAILABLE" : "PENDING",
    -amount,key,randomUUID(),now);
  await client.query(`UPDATE commissions SET reversed_amount_minor=$2,
    state=CASE WHEN gross_amount_minor=$2 THEN 'VOID'::"CommissionState" ELSE state END,updated_at=$3 WHERE id=$1`,
  [commissionId,reversed,now]);
  return amount;
}
export async function reverseOrderCommissions(client: PoolClient, orderId: string, operationKey: string, now: Date) {
  for (const commission of await lockOrderCommissions(client,orderId)) {
    if (commission.state === "VOID") continue;
    if (commission.state === "EARNED") throw new CommissionError();
    const remaining = commission.gross_amount_minor - commission.reversed_amount_minor;
    if (remaining <= 0) throw new CommissionError();
    await reverseCommission(client,commission.id,remaining,operationKey,now);
  }
}
