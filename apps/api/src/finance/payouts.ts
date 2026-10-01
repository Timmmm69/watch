import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LegalDocumentRef } from "@watch/config";
import { payoutRequestSchema, payoutResponseSchema } from "@watch/contracts";
import { partnerProgramMutationAllowed, partnerTermsCurrent, type PartnerStatus } from "../partner/partner.js";

export class PayoutError extends Error {
  constructor(readonly code: string) { super(code); }
}
interface StoredPayout {
  id: string; partner_id: string; amount_minor: number; currency: string;
  status: "REQUESTED" | "PAID" | "REJECTED"; request_fingerprint: string;
  requested_by_user_id: string; requested_at: Date;
}

export class PayoutService {
  constructor(private readonly pool: Pool, private readonly currency: string,
    private readonly terms: LegalDocumentRef, private readonly minimumMinor = 5000) {}

  async request(userId: string, key: unknown, input: unknown = {}) {
    return this.create(userId, null, key, input);
  }

  // Admin authorization belongs to the route; settlements bypass BR-007, not the financial rules.
  async requestSettlement(adminId: string, partnerId: string, key: unknown, input: unknown = {}, requestId?: string) {
    return this.create(adminId, partnerId, key, input, requestId);
  }

  private async project(client: PoolClient, row: StoredPayout) {
    const allocations = (await client.query<{ id: string; commission_id: string; amount_minor: number }>(
      "SELECT id,commission_id,amount_minor FROM payout_allocations WHERE payout_id=$1 ORDER BY created_at,id", [row.id])).rows;
    return payoutResponseSchema.parse({ id: row.id, partnerId: row.partner_id, amountMinor: row.amount_minor,
      currency: row.currency, status: row.status, requestedByUserId: row.requested_by_user_id,
      requestedAt: row.requested_at.toISOString(), allocations: allocations.map((a) => ({
        id: a.id, commissionId: a.commission_id, amountMinor: a.amount_minor })) });
  }

  private async create(actorId: string, settlementPartnerId: string | null, key: unknown, input: unknown, requestId?: string) {
    if (typeof key !== "string" || !key.trim() || key.length > 100 || !payoutRequestSchema.safeParse(input).success)
      throw new PayoutError("VALIDATION_ERROR");
    // The requested amount/minimum are server state, never fingerprint inputs. Config changes cannot break retries.
    const fingerprint = createHash("sha256").update(JSON.stringify({ v: 1, method: "MANUAL_OFF_PLATFORM",
      actorId, mode: settlementPartnerId ? "SETTLEMENT" : "SELF" })).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const partner = (await client.query<{ id: string; user_id: string; status: PartnerStatus }>(settlementPartnerId
        ? "SELECT id,user_id,status FROM partners WHERE id=$1 FOR UPDATE"
        : "SELECT id,user_id,status FROM partners WHERE user_id=$1 FOR UPDATE", [settlementPartnerId ?? actorId])).rows[0];
      if (!partner) throw new PayoutError(settlementPartnerId ? "NOT_FOUND" : "PARTNER_REQUIRED");
      const existing = (await client.query<StoredPayout>(
        "SELECT * FROM payouts WHERE partner_id=$1 AND idempotency_key=$2", [partner.id,key])).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new PayoutError("IDEMPOTENCY_CONFLICT");
        const payout = await this.project(client,existing);
        await client.query("COMMIT");
        return { payout, created: false };
      }
      const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      if (!settlementPartnerId) {
        const user = (await client.query<{ is_blocked: boolean }>("SELECT is_blocked FROM users WHERE id=$1", [actorId])).rows[0];
        if (!user || user.is_blocked) throw new PayoutError("USER_BLOCKED");
        const terms = (await client.query<{ requires_reacceptance: boolean; accepted: boolean }>(`SELECT requires_reacceptance,
          EXISTS (SELECT 1 FROM partner_terms_acceptances WHERE partner_id=$1 AND legal_document_id=d.id) AS accepted
          FROM legal_documents d WHERE id=$2 AND type='PARTNER_TERMS' AND version=$3 AND effective_at<=$4`,
        [partner.id,this.terms.id,this.terms.version,now])).rows[0];
        if (!terms) throw new PayoutError("PAYOUT_CONFIGURATION_MISSING");
        const current = partnerTermsCurrent(terms.requires_reacceptance,terms.accepted);
        if (!partnerProgramMutationAllowed({ userBlocked: user.is_blocked, partnerStatus: partner.status, partnerTermsCurrent: current }))
          throw new PayoutError(partner.status === "BLOCKED" ? "PARTNER_BLOCKED" : "TERMS_REACCEPT_REQUIRED");
      }
      const platform = (await client.query<{ platform_currency: string }>(
        "SELECT platform_currency FROM platform_settings WHERE singleton_id=1")).rows[0];
      if (this.currency !== "BYN" || platform?.platform_currency !== this.currency
        || !Number.isInteger(this.minimumMinor) || this.minimumMinor < 1 || this.minimumMinor > 2147483647)
        throw new PayoutError("PAYOUT_CONFIGURATION_MISSING");
      if ((await client.query("SELECT 1 FROM payouts WHERE partner_id=$1 AND status='REQUESTED'", [partner.id])).rowCount)
        throw new PayoutError("PAYOUT_ALREADY_PENDING");
      const amount = BigInt((await client.query<{ amount: string }>(`SELECT COALESCE(SUM(amount_minor),0)::text AS amount
        FROM ledger_entries WHERE partner_id=$1 AND bucket='AVAILABLE'`, [partner.id])).rows[0]!.amount);
      if (amount <= 0n) throw new PayoutError("PAYOUT_NOT_AVAILABLE");
      if (amount < BigInt(this.minimumMinor)) throw new PayoutError("PAYOUT_BELOW_MINIMUM");
      if (amount > 2147483647n) throw new PayoutError("INTERNAL_INVARIANT_VIOLATION");
      // Count committed new requests under the same Partner lock; retries never consume quota.
      const recent = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM payouts
        WHERE partner_id=$1 AND requested_at>$2::timestamptz-interval '1 hour'`, [partner.id,now])).rows[0]!.count;
      if (!settlementPartnerId && recent >= 5) throw new PayoutError("RATE_LIMITED");
      const commissions = (await client.query<{ id: string; available_at: Date | null; allocatable: string }>(`SELECT c.id,c.available_at,
        (GREATEST(c.gross_amount_minor-c.reversed_amount_minor,0)::bigint-
          COALESCE((SELECT SUM(a.amount_minor) FROM payout_allocations a JOIN payouts p ON p.id=a.payout_id
            WHERE a.commission_id=c.id AND p.status IN ('REQUESTED','PAID')),0))::text AS allocatable
        FROM commissions c WHERE c.partner_id=$1 AND c.state='EARNED'
        ORDER BY c.available_at,c.id FOR UPDATE OF c`, [partner.id])).rows;
      let remaining = amount;
      const allocations: { commissionId: string; amount: number }[] = [];
      for (const commission of commissions) {
        if (!commission.available_at) throw new PayoutError("INTERNAL_INVARIANT_VIOLATION");
        const eligible = BigInt(commission.allocatable);
        if (eligible <= 0n) continue;
        const allocated = eligible < remaining ? eligible : remaining;
        allocations.push({ commissionId: commission.id, amount: Number(allocated) });
        remaining -= allocated;
        if (!remaining) break;
      }
      if (remaining !== 0n) throw new PayoutError("INTERNAL_INVARIANT_VIOLATION");
      const payoutId = randomUUID(), group = randomUUID();
      const row = (await client.query<StoredPayout>(`INSERT INTO payouts
        (id,partner_id,amount_minor,currency,idempotency_key,request_fingerprint,destination_snapshot,requested_by_user_id,requested_at)
        VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8) RETURNING *`,
      [payoutId,partner.id,Number(amount),this.currency,key,fingerprint,actorId,now])).rows[0]!;
      for (const allocation of allocations) await client.query(`INSERT INTO payout_allocations
        (id,partner_id,payout_id,commission_id,amount_minor,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(),partner.id,payoutId,allocation.commissionId,allocation.amount,now]);
      for (const [bucket,delta] of [["AVAILABLE",-Number(amount)],["PAYOUT_LOCKED",Number(amount)]] as const)
        await client.query(`INSERT INTO ledger_entries
          (id,partner_id,payout_id,bucket,amount_minor,entry_type,transaction_group_id,idempotency_key,created_at)
          VALUES ($1,$2,$3,$4,$5,'PAYOUT_LOCK',$6,$7,$8)`,
        [randomUUID(),partner.id,payoutId,bucket,delta,group,`payout:${payoutId}:lock:${bucket.toLowerCase()}`,now]);
      await client.query(`INSERT INTO events (id,type,aggregate_type,aggregate_id,dedupe_key,payload,created_at)
        VALUES ($1,'PAYOUT_REQUESTED','Payout',$2,$3,$4,$5)`, [randomUUID(),payoutId,`payout:${payoutId}:requested`,
      JSON.stringify({ v: 1,payoutId,partnerId: partner.id,amountMinor: Number(amount),status: "REQUESTED" }),now]);
      if (settlementPartnerId) await client.query(`INSERT INTO audit_logs
        (id,actor_user_id,action,entity_type,entity_id,request_id,metadata,created_at)
        VALUES ($1,$2,'admin.payout.create','Payout',$3,$4,$5,$6)`,
      [randomUUID(),actorId,payoutId,requestId ?? null,JSON.stringify({ partnerId: partner.id,amountMinor: Number(amount) }),now]);
      const payout = await this.project(client,row);
      await client.query("COMMIT");
      return { payout, created: true };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
