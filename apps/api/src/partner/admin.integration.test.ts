import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminPartnerDetailSchema } from "@watch/contracts";
import { LegalDocuments } from "../legal/legal.js";
import { AdminPartnerService } from "./admin.js";
import { PartnerService } from "./partner.js";
import { ReferralService } from "../referral/referral.js";
import { CheckoutService } from "../orders/checkout.js";
import { AdminOrderService } from "../orders/admin.js";
import { OrderCompletionWorker } from "../orders/completion.js";
import { PayoutService } from "../finance/payouts.js";
import { OrderViewService } from "../orders/views.js";

const schema = `admin_partner_t41_${randomUUID().replaceAll("-","")}`;
const pool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 12,
  options: `-c search_path=${schema},public` }) : null;
const actor = randomUUID(), buyer = randomUUID(), seller = randomUUID(), partner = randomUUID(), other = randomUUID();
const supplier = randomUUID(), product = randomUUID(), variant = randomUUID();
const docs = { PARTNER_TERMS: { id: randomUUID(),version: "t41-partner" },
  SALES_TERMS: { id: randomUUID(),version: "t41-sales" }, PRIVACY: { id: randomUUID(),version: "t41-privacy" } };
let admin: AdminPartnerService, partners: PartnerService, referral: ReferralService, checkout: CheckoutService, payouts: PayoutService;
const page = { page: 1,limit: 20 };
const input = { items: [{ variantId: variant,quantity: 1,expectedUnitPriceMinor: 10000 }],
  recipientName: "Buyer",phone: "+375291234567",address: "Minsk",salesTermsDocumentId: docs.SALES_TERMS.id,
  privacyDocumentId: docs.PRIVACY.id,salesTermsAccepted: true,privacyAcknowledged: true };

beforeAll(async () => {
  if (!pool) return;
  await pool.query(`CREATE SCHEMA ${schema}`);
  const migrations = new URL("../../../../packages/db/prisma/migrations/",import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => /^\d/.test(n)).sort())
    await pool.query(await readFile(new URL(`${name}/migration.sql`,migrations),"utf8"));
  await pool.query("INSERT INTO platform_settings (singleton_id,platform_currency) VALUES (1,'BYN')");
  for (const [i,id] of [actor,buyer,seller,other].entries()) await pool.query(
    "INSERT INTO users (id,telegram_user_id,first_name,username,is_admin) VALUES ($1,$2,$3,$4,$5)", [id,i+1,i===2 ? "Alice" : "User",i===2 ? "alice" : null,i===0]);
  await pool.query("INSERT INTO partners (id,user_id) VALUES ($1,$2),($3,$4)",[partner,seller,randomUUID(),other]);
  for (const [type,doc] of Object.entries(docs)) {
    const content = `T41 fixture ${type}`;
    await pool.query(`INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at,requires_reacceptance)
      VALUES ($1,$2,$3,$4,$5,now(),true)`, [doc.id,type,doc.version,createHash("sha256").update(content).digest("hex"),content]);
  }
  await pool.query("INSERT INTO suppliers (id,name) VALUES ($1,'T41 supplier')",[supplier]);
  await pool.query("INSERT INTO products (id,supplier_id,title,slug,status) VALUES ($1,$2,'Watch','t41-watch','ACTIVE')",[product,supplier]);
  await pool.query(`INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key,status)
    VALUES ($1,$2,'T41',10000,'BYN',6000,'t41-stock','ACTIVE')`,[variant,product]);
  await pool.query("INSERT INTO inventory_items (variant_id,source_quantity,source_status,last_successful_sync_at) VALUES ($1,100,'OK',now())",[variant]);
  const legal = new LegalDocuments(pool,docs);
  admin = new AdminPartnerService(pool,legal); partners = new PartnerService(pool,legal);
  referral = new ReferralService(pool,legal,"watch_dev_bot"); checkout = new CheckoutService(pool,"BYN",docs);
  payouts = new PayoutService(pool,"BYN",docs.PARTNER_TERMS);
},30000);
beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE orders,payouts,carts,events,referral_links,attribution_touches,partner_terms_acceptances,audit_logs CASCADE");
  await pool.query("UPDATE partners SET status='ACTIVE',block_reason=NULL,blocked_at=NULL");
  await pool.query("UPDATE users SET is_blocked=false");
  await pool.query("INSERT INTO partner_terms_acceptances (partner_id,legal_document_id) VALUES ($1,$2)",[partner,docs.PARTNER_TERMS.id]);
  const link = await referral.getOrCreate(seller,null);
  await pool.query(`INSERT INTO attribution_touches (id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+interval '30 days')`,[randomUUID(),buyer,partner,link.id,createHash("sha256").update(randomUUID()).digest("hex")]);
  const cart = randomUUID(); await pool.query("INSERT INTO carts (id,buyer_user_id) VALUES ($1,$2)",[cart,buyer]);
  await pool.query("INSERT INTO cart_items (cart_id,variant_id,quantity) VALUES ($1,$2,1)",[cart,variant]);
});
afterAll(async () => { if (pool) { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); } });

// Observe real PostgreSQL wait dependencies, rather than relying on timing alone.
async function waiter(blocker: number) {
  for (let attempt=0;attempt<300;attempt++) {
    const row = (await pool!.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[blocker])).rows[0];
    if (row) return row.pid;
    await new Promise(resolve => setTimeout(resolve,10));
  }
  throw new Error(`No PostgreSQL waiter for ${blocker}`);
}
async function pid(client: PoolClient) { return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid; }
async function completeOrder() {
  const order = (await checkout.checkout(buyer,randomUUID(),input)).order;
  const orders = new AdminOrderService(pool!,0);
  for (const status of ["CONFIRMED","FULFILLING","SHIPPED","DELIVERED"] as const) await orders.transition(order.id,actor,status);
  await new OrderCompletionWorker(pool!).completeOrder(order.id);
  return order;
}

describe.skipIf(!pool)("T41 Admin Partners against fully migrated PostgreSQL", () => {
  it("filters/paginates safely and projects exact ledger balances with history", async () => {
    const order = await completeOrder();
    await referral.getOrCreate(seller,product);
    const list = await admin.list({ ...page,search: "ALICE" });
    expect(list).toMatchObject({ total: 1,items: [{ id: partner,attributedOrders: 1,completedOrders: 1,activeReferralLinks: 2,pendingAmountMinor: 0,availableAmountMinor: 6000 }] });
    expect((await admin.list({ page: 2,limit: 1 })).items).toHaveLength(1);
    expect((await admin.list({ ...page,search: "%" })).total).toBe(0);
    const detail = await admin.detail(partner,{ page: 1,limit: 1 });
    expect(detail).toMatchObject({ id: partner,availableAmountMinor: 6000,referralLinks: { total: 2,items: [expect.any(Object)] },recentOrders: [{ id: order.id,publicNumber: order.publicNumber,commissionEligible: true }] });
    expect(adminPartnerDetailSchema.parse({ ...detail,...payouts.configuration }).user.telegramUserId).toBe("3");
    expect(JSON.stringify(detail)).not.toContain("recipientName");
    await payouts.request(seller,"request");
    expect(await admin.detail(partner,page)).toMatchObject({ availableAmountMinor: 0,payouts: { requested: 1,recent: [{ status: "REQUESTED",amountMinor: 6000 }] } });
    await expect(admin.detail(randomUUID(),page)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("audits concurrent block/unblock exactly once per change and preserves all financial/history rows", async () => {
    const order = await completeOrder();
    const financial = (await pool!.query("SELECT * FROM ledger_entries ORDER BY id")).rows;
    const results = await Promise.all(Array.from({ length: 3 },() => admin.setStatus(actor,partner,"BLOCKED","review","block-request")));
    expect(results.every(r => r.status==="BLOCKED")).toBe(true);
    expect(results[1]).toEqual(results[0]);
    expect((await admin.list({ ...page,status: "BLOCKED" })).total).toBe(1);
    expect((await pool!.query("SELECT * FROM ledger_entries ORDER BY id")).rows).toEqual(financial);
    expect(await admin.detail(partner,page)).toMatchObject({ availableAmountMinor: 6000,completedOrders: 1 });
    expect((await new OrderViewService(pool!,"support").getPartnerOrder(partner,order.publicNumber)).publicNumber).toBe(order.publicNumber);
    await expect(referral.getOrCreate(seller,null)).rejects.toMatchObject({ code: "PARTNER_BLOCKED" });
    await expect(payouts.request(seller,"blocked")).rejects.toMatchObject({ code: "PARTNER_BLOCKED" });
    // BR-109 uses the existing audited settlement service, including BLOCKED Partner.
    expect(await payouts.requestSettlement(actor,partner,"settlement",{},"settlement-request")).toMatchObject({ payout: { amountMinor: 6000 } });
    await Promise.all([admin.setStatus(actor,partner,"ACTIVE","resolved","unblock-request"),admin.setStatus(actor,partner,"ACTIVE","resolved","unblock-request")]);
    expect((await pool!.query("SELECT action,metadata FROM audit_logs WHERE entity_type='Partner' ORDER BY created_at,id")).rows).toEqual([
      { action: "PARTNER_BLOCKED",metadata: { reason: "review",from: "ACTIVE",to: "BLOCKED",requestId: "block-request" } },
      { action: "PARTNER_UNBLOCKED",metadata: { reason: "resolved",from: "BLOCKED",to: "ACTIVE",requestId: "unblock-request" } }
    ]);
    expect(await admin.detail(partner,page)).toMatchObject({ status: "ACTIVE",blockedAt: null,blockReason: null });
  });
  it("unblock never bypasses required terms or global User block; disabled links are replaced normally", async () => {
    await admin.setStatus(actor,partner,"BLOCKED","review","block");
    await pool!.query("DELETE FROM partner_terms_acceptances WHERE partner_id=$1",[partner]);
    await admin.setStatus(actor,partner,"ACTIVE","resolved","unblock");
    expect((await partners.loadState(seller)).partnerTermsReacceptRequired).toBe(true);
    await expect(referral.getOrCreate(seller,null)).rejects.toMatchObject({ code: "TERMS_REACCEPT_REQUIRED" });
    await expect(payouts.request(seller,"terms")).rejects.toMatchObject({ code: "TERMS_REACCEPT_REQUIRED" });
    await partners.onboard(seller,docs.PARTNER_TERMS.id,docs.PARTNER_TERMS.version);
    const old = await referral.getOrCreate(seller,null);
    await referral.disable(actor,old.id,"compromised");
    await referral.disable(actor,old.id,"retry");
    const next = await referral.getOrCreate(seller,null);
    expect(next.id).not.toBe(old.id); expect(next.url).not.toBe(old.url);
    expect((await admin.detail(partner,page)).referralLinks).toMatchObject({ total: 2,items: expect.arrayContaining([{ id: old.id,productId: null,status: "DISABLED",createdAt: expect.any(String),disabledAt: expect.any(String),disableReason: "compromised" }]) });
    expect((await pool!.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='REFERRAL_LINK_DISABLED'")).rows[0].n).toBe(1);
    await pool!.query("UPDATE users SET is_blocked=true WHERE id=$1",[seller]);
    await admin.setStatus(actor,partner,"BLOCKED","review","block2"); await admin.setStatus(actor,partner,"ACTIVE","resolved","unblock2");
    await expect(referral.getOrCreate(seller,null)).rejects.toMatchObject({ code: "PARTNER_BLOCKED" });
  });
  it("audit failure rolls back status; invalid reason and missing Partner have no side effects", async () => {
    await expect(admin.setStatus(actor,partner,"BLOCKED"," ","bad")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(admin.setStatus(actor,randomUUID(),"BLOCKED","review","missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Missing actor violates the real AuditLog FK after the UPDATE.
    await expect(admin.setStatus(randomUUID(),partner,"BLOCKED","review","bad-actor")).rejects.toMatchObject({ code: "23503" });
    expect((await admin.detail(partner,page)).status).toBe("ACTIVE");
    expect((await pool!.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n).toBe(0);
  });
  it.each([true,false])("real Admin block vs checkout serializes (block commits first=%s)", async blockFirst => {
    const gate = await pool!.connect();
    let block: Promise<unknown> | undefined, order: ReturnType<CheckoutService["checkout"]> | undefined;
    try {
      await gate.query("BEGIN"); const gatePid = await pid(gate);
      if (blockFirst) {
        // Pause Admin's audit after its Partner update while retaining its row lock.
        await gate.query("LOCK TABLE audit_logs IN SHARE MODE");
        block = admin.setStatus(actor,partner,"BLOCKED","race","race-block");
        void block.catch(() => undefined);
        const adminPid = await waiter(gatePid);
        order = checkout.checkout(buyer,"race",input);
        void order.catch(() => undefined);
        await waiter(adminPid);
      } else {
        await gate.query("SELECT variant_id FROM inventory_items WHERE variant_id=$1 FOR UPDATE",[variant]);
        order = checkout.checkout(buyer,"race",input);
        void order.catch(() => undefined);
        const checkoutPid = await waiter(gatePid);
        block = admin.setStatus(actor,partner,"BLOCKED","race","race-block");
        void block.catch(() => undefined);
        await waiter(checkoutPid);
      }
      await gate.query("COMMIT");
      const result = await order; await block;
      const row = (await pool!.query("SELECT partner_id_snapshot,commission_eligible_snapshot FROM orders WHERE id=$1",[result.order.id])).rows[0];
      expect(row).toEqual({ partner_id_snapshot: partner,commission_eligible_snapshot: !blockFirst });
      expect((await pool!.query("SELECT count(*)::int AS n FROM commissions WHERE order_id=$1",[result.order.id])).rows[0].n).toBe(blockFirst ? 0 : 1);
      expect((await admin.detail(partner,page)).status).toBe("BLOCKED");
    } finally {
      await gate.query("ROLLBACK"); gate.release();
      await Promise.allSettled([order,block]);
    }
  },15000);
});
