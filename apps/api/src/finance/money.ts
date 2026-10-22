import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { orderMoneyRequestSchema, orderExpenseRequestSchema, orderExpenseReviewRequestSchema, type OrderFinanceResponse } from "@watch/contracts";
import { usesNativeInventory } from "../inventory/native.js";
import { orderMoneyCoverage, reconcileOverpayment } from "./coverage.js";

export class MoneyError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class OrderMoneyService {
  constructor(private readonly pool: Pool) {}

  async detail(orderId: string): Promise<OrderFinanceResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if (!(await client.query("SELECT 1 FROM orders WHERE id=$1", [orderId])).rowCount) throw new MoneyError("NOT_FOUND");
      const coverage = await orderMoneyCoverage(client, orderId);
      const money = (await client.query("SELECT * FROM order_money_entries WHERE order_id=$1 ORDER BY created_at,id", [orderId])).rows;
      const expenses = (await client.query("SELECT * FROM order_direct_expenses WHERE order_id=$1 ORDER BY created_at,id", [orderId])).rows;
      const total = expenses.reduce((sum, row) => sum + Number(row.amount_minor), 0);
      const review = (await client.query("SELECT * FROM order_expense_reviews WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [orderId])).rows[0];
      const result = { ...coverage, recordedExpensesMinor: total, expenseEntryCount: expenses.length,
        expensesMinor: review?.expense_entry_count === expenses.length && review.reviewed_total_minor === total ? total : null,
        money: money.map(row => ({ id: row.id, kind: row.kind, amountMinor: row.amount_minor, reference: row.reference,
          occurredAt: row.occurred_at.toISOString(), actorUserId: row.actor_user_id, correctsEntryId: row.corrects_entry_id })),
        expenses: expenses.map(row => ({ id: row.id, kind: row.kind, amountMinor: row.amount_minor, reference: row.reference,
          occurredAt: row.occurred_at.toISOString(), actorUserId: row.actor_user_id, correctsExpenseId: row.corrects_expense_id })) };
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async record(orderId: string, actor: string, input: unknown, mode: "money" | "expense" | "review", requestId?: string) {
    const parsed = (mode === "money" ? orderMoneyRequestSchema : mode === "expense" ? orderExpenseRequestSchema : orderExpenseReviewRequestSchema).safeParse(input);
    if (!parsed.success) throw new MoneyError("VALIDATION_ERROR");
    // Each branch is validated against its strict contract before SQL mapping.
    const data = parsed.data;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const keys = [data.operationKey, ...("reference" in data ? [data.reference] : [])].sort();
      for (const key of keys) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`money:${key}`]);
      const owner = (await client.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
      if (!owner) throw new MoneyError("NOT_FOUND");
      if (!usesNativeInventory(owner)) throw new MoneyError("LEGACY_FLOW_DISABLED");
      if (owner.currency !== "BYN") throw new MoneyError("VALIDATION_ERROR");
      if (owner.partner_id_snapshot) await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [owner.partner_id_snapshot]);
      await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [orderId]);
      await client.query("SELECT id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE", [orderId]);
      const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]!.now as Date;
      if ("occurredAt" in data && new Date(data.occurredAt) > now) throw new MoneyError("VALIDATION_ERROR");
      let table: string; let fields: Record<string, unknown>;
      const common = { order_id: orderId, actor_user_id: actor, reason: data.reason };
      if (mode === "money") {
        const d = orderMoneyRequestSchema.parse(data); table = "order_money_entries";
        if (d.kind === "CORRECTION" && d.correctsEntryId) {
          const original = (await client.query("SELECT obligation_id FROM order_money_entries WHERE id=$1 AND order_id=$2", [d.correctsEntryId, orderId])).rows[0];
          if (!original || (d.obligationId && d.obligationId !== original.obligation_id)) throw new MoneyError("INVALID_MONEY_FACT");
          d.obligationId = original.obligation_id ?? undefined;
        }
        fields = { ...common, kind: d.kind, amount_minor: d.amountMinor, reference: d.reference,
          occurred_at: new Date(d.occurredAt), corrects_entry_id: d.correctsEntryId ?? null, obligation_id: d.obligationId ?? null };
        if ((d.kind === "RECEIPT" && (d.amountMinor <= 0 || d.correctsEntryId || d.obligationId))
          || (d.kind === "REFUND" && (d.amountMinor >= 0 || !d.obligationId || d.correctsEntryId))
          || (d.kind === "CORRECTION" && !d.correctsEntryId)) throw new MoneyError("VALIDATION_ERROR");
      } else if (mode === "expense") {
        const d = orderExpenseRequestSchema.parse(data); table = "order_direct_expenses";
        fields = { ...common, kind: d.kind, amount_minor: d.amountMinor, reference: d.reference,
          occurred_at: new Date(d.occurredAt), corrects_expense_id: d.correctsExpenseId ?? null };
      } else {
        const d = orderExpenseReviewRequestSchema.parse(data); table = "order_expense_reviews";
        fields = { ...common, expense_entry_count: d.expenseEntryCount, reviewed_total_minor: d.reviewedTotalMinor };
      }
      const old = (await client.query(`SELECT * FROM ${table} WHERE operation_key=$1${"reference" in data ? " OR reference=$2" : ""}`,
        "reference" in data ? [data.operationKey, data.reference] : [data.operationKey])).rows;
      if (old.length) {
        if (old.length !== 1 || Object.entries(fields).some(([key, value]) => value instanceof Date
          ? old[0][key]?.getTime() !== value.getTime() : old[0][key] !== value)) throw new MoneyError("IDEMPOTENCY_CONFLICT");
      } else {
        const columns = ["id", "operation_key", ...Object.keys(fields), ... (mode === "review" ? ["occurred_at"] : [])];
        const values = [randomUUID(), data.operationKey, ...Object.values(fields), ...(mode === "review" ? [now] : [])];
        await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${values.map((_, i) => `$${i+1}`).join(",")})`, values);
        if (mode === "money") {
          const facts = await orderMoneyCoverage(client, orderId);
          if (Math.abs(facts.cashMinor) > 2_000_000_000) throw new MoneyError("MONEY_LIMIT_EXCEEDED");
          await reconcileOverpayment(client, orderId, actor, now);
        }
        if (mode === "expense") {
          const sum = Number((await client.query("SELECT sum(amount_minor)::text AS amount FROM order_direct_expenses WHERE order_id=$1", [orderId])).rows[0].amount);
          if (sum < 0 || sum > 2_000_000_000) throw new MoneyError("MONEY_LIMIT_EXCEEDED");
        }
        await this.audit(client, actor, orderId, mode, requestId, now);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof MoneyError) throw error;
      if (["23514", "23503", "23505"].includes((error as { code?: string }).code ?? "")) throw new MoneyError("INVALID_MONEY_FACT");
      throw error;
    } finally { client.release(); }
    return this.detail(orderId);
  }

  private async audit(client: PoolClient, actor: string, order: string, mode: string, requestId: string | undefined, now: Date) {
    await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
      VALUES($1,$2,$3,'Order',$4,$5,'{}',$6)`, [randomUUID(), actor, `admin.order.${mode}`, order, requestId ?? null, now]);
  }
}
