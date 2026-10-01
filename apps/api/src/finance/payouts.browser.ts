import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { SessionStore, SESSION_COOKIE_NAME, hashSessionToken } from "../auth/session.js";
import { LegalDocuments } from "../legal/legal.js";
import { PartnerService } from "../partner/partner.js";
import { PayoutService } from "./payouts.js";
import { PartnerEarningsService } from "./earnings.js";
import { createOrderCommissions, releaseCommission } from "./commissions.js";
import { generatePublicOrderNumber } from "../orders/order-number.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const schema = `payout_browser_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
const partnerUser = randomUUID(), adminUser = randomUUID(), partner = randomUUID();
const supplier = randomUUID(), product = randomUUID(), variant = randomUUID(), touch = randomUUID();
const partnerTerms = { id: randomUUID(), version: "browser-t34" };
const sales = randomUUID(), privacy = randomUUID();
const partnerToken = randomBytes(32).toString("base64url"), adminToken = randomBytes(32).toString("base64url");
const require = createRequire(new URL("../../../web/package.json", import.meta.url));
const { chromium } = require("@playwright/test") as { chromium: { launch(options: { headless: boolean; channel?: string }): Promise<any> } };

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function seedCommission() {
  const order = randomUUID(), item = randomUUID();
  await pool.query(`INSERT INTO orders (id,public_number,buyer_user_id,supplier_id,attribution_touch_id,partner_id_snapshot,
    commission_eligible_snapshot,currency,subtotal_minor,total_minor,sales_terms_document_id,privacy_document_id,
    sales_terms_accepted_at,privacy_acknowledged_at,idempotency_key,request_fingerprint,status,completion_eligible_at)
    VALUES ($1,$2,$3,$4,$5,$6,true,'BYN',6000,6000,$7,$8,now(),now(),$10,$9,'DELIVERED',now()-interval '1 day')`,
  [order,generatePublicOrderNumber(),adminUser,supplier,touch,partner,sales,privacy,"a".repeat(64),order]);
  await pool.query(`INSERT INTO order_items (id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,
    partner_commission_unit_snapshot_minor,line_total_minor) VALUES ($1,$2,$3,'BROWSER','Watch',1,6000,6000,6000)`, [item,order,variant]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [partner]);
    await createOrderCommissions(client,order,new Date());
    const commission = (await client.query<{ id: string }>("SELECT id FROM commissions WHERE order_id=$1", [order])).rows[0]!.id;
    await client.query("UPDATE commissions SET state='HOLD',eligible_at=now()-interval '1 day' WHERE id=$1", [commission]);
    await releaseCommission(client,commission,new Date()); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function main() {
  let app: ReturnType<typeof createApp> | undefined;
  let browser: any;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL("../../../../packages/db/prisma/migrations/", import.meta.url);
    for (const migration of (await readdir(migrations,{ withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a,b) => a.name.localeCompare(b.name)))
      await pool.query(await readFile(new URL(`${migration.name}/migration.sql`,migrations),"utf8"));
    await pool.query("INSERT INTO platform_settings (singleton_id,platform_currency) VALUES (1,'BYN')");
    await pool.query("INSERT INTO users (id,telegram_user_id,first_name,is_admin) VALUES ($1,700001,'Partner',false),($2,700002,'Admin',true)", [partnerUser,adminUser]);
    await pool.query("INSERT INTO partners (id,user_id) VALUES ($1,$2)", [partner,partnerUser]);
    for (const [id,type,version] of [[partnerTerms.id,"PARTNER_TERMS",partnerTerms.version],[sales,"SALES_TERMS","browser"],[privacy,"PRIVACY","browser"]] as [string,string,string][])
      await pool.query("INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at) VALUES ($1,$2,$3,$4,'Terms',now())", [id,type,version,randomBytes(32).toString("hex")]);
    await pool.query("INSERT INTO partner_terms_acceptances (partner_id,legal_document_id) VALUES ($1,$2)", [partner,partnerTerms.id]);
    await pool.query("INSERT INTO suppliers (id,name) VALUES ($1,'Browser supplier')", [supplier]);
    await pool.query("INSERT INTO products (id,supplier_id,title,slug) VALUES ($1,$2,'Browser watch','browser-watch')", [product,supplier]);
    await pool.query("INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key) VALUES ($1,$2,'BROWSER',6000,'BYN',0,'BROWSER')", [variant,product]);
    const link = randomUUID();
    await pool.query("INSERT INTO referral_links (id,partner_id,token) VALUES ($1,$2,$3)", [link,partner,randomBytes(18).toString("base64url")]);
    await pool.query("INSERT INTO attribution_touches (id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '30 days')", [touch,adminUser,partner,link,"b".repeat(64)]);
    for (const [id,userId,token] of [[randomUUID(),partnerUser,partnerToken],[randomUUID(),adminUser,adminToken]] as [string,string,string][])
      await pool.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [id,userId,hashSessionToken(token)]);
    await seedCommission();
    const legal = new LegalDocuments(pool,{ PARTNER_TERMS: partnerTerms });
    const adminIds = new Set(["700002"]);
    app = createApp({ logger: false,checkReadiness: async () => {},auth: { store: new SessionStore(pool,adminIds),csrfSecret: Buffer.alloc(32,7),appBaseUrl: "http://127.0.0.1:3000",adminIds: () => adminIds },
      legal,partner: new PartnerService(pool,legal),earnings: new PartnerEarningsService(pool),payouts: new PayoutService(pool,"BYN",partnerTerms) });
    await app.listen({ host: "127.0.0.1",port: 3001 });
    browser = await chromium.launch({ headless: true,channel: "chrome" });
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:3000" }); const page = await context.newPage();
    const login = async (token: string) => { await context.clearCookies(); await context.addCookies([{ name: SESSION_COOKIE_NAME,value: token,domain: "127.0.0.1",path: "/" }]); };
    await page.route("https://telegram.org/js/telegram-web-app.js", (route: any) => route.fulfill({ contentType: "application/javascript",body: "" }));
    await login(partnerToken); await page.goto("/partner/payouts");
    await page.getByRole("button",{ name: "Запросить выплату" }).click(); await page.getByRole("button",{ name: "Да, запросить выплату" }).click();
    await page.getByText("Ожидает выплаты",{ exact: true }).waitFor();
    const first = (await pool.query<{ id: string }>("SELECT id FROM payouts ORDER BY requested_at DESC,id LIMIT 1")).rows[0]!.id;
    await login(adminToken); await page.goto(`/admin/payouts/${first}`); await page.getByRole("button",{ name: "Отклонить выплату" }).click();
    await page.getByLabel(/Комментарий/).fill("Transfer unavailable"); await page.getByRole("button",{ name: "Да, отклонить выплату" }).click(); await page.getByText("Отклонена",{ exact: false }).waitFor();
    await login(partnerToken); await page.goto("/partner/payouts"); await page.getByRole("button",{ name: "Запросить выплату" }).click(); await page.getByRole("button",{ name: "Да, запросить выплату" }).click();
    await page.getByText("Ожидает выплаты",{ exact: true }).waitFor();
    const second = (await pool.query<{ id: string }>("SELECT id FROM payouts WHERE id<>$1 ORDER BY requested_at DESC,id LIMIT 1", [first])).rows[0]!.id;
    await login(adminToken); await page.goto(`/admin/payouts/${second}`); await page.getByRole("button",{ name: "Отметить выплаченной" }).click();
    await page.getByLabel("Внешний идентификатор перевода").fill("browser-transfer-1"); await page.getByRole("button",{ name: "Да, отметить выплаченной" }).click(); await page.getByText("Выплачена",{ exact: false }).waitFor();
    await login(partnerToken); await page.goto("/partner/payouts"); await page.getByText("Выплачена",{ exact: true }).waitFor();
    const payouts = (await pool.query("SELECT id,status,amount_minor FROM payouts ORDER BY requested_at,id")).rows;
    assert(payouts.length === 2 && payouts[0].status === "REJECTED" && payouts[1].status === "PAID", "terminal payout states were not persisted");
    const allocation = (await pool.query<{ amount: string }>("SELECT COALESCE(SUM(amount_minor),0)::text AS amount FROM payout_allocations WHERE payout_id=$1", [second])).rows[0]!.amount;
    assert(allocation === "6000", "paid payout allocation is not exact");
    const buckets = Object.fromEntries((await pool.query<{ bucket: "AVAILABLE" | "PAYOUT_LOCKED"; amount: string }>(`SELECT bucket,COALESCE(SUM(amount_minor),0)::text AS amount
      FROM ledger_entries WHERE partner_id=$1 AND bucket IN ('AVAILABLE','PAYOUT_LOCKED') GROUP BY bucket`, [partner])).rows.map((row) => [row.bucket,row.amount]));
    assert(buckets.AVAILABLE === "0" && buckets.PAYOUT_LOCKED === "0", "final payout ledger buckets are not zero");
    assert((await pool.query("SELECT 1 FROM audit_logs WHERE entity_id=$1 AND action='admin.payout.paid'", [second])).rowCount === 1, "paid transition audit missing");
    await context.close(); console.log("payout browser acceptance passed");
  } finally { await browser?.close(); await app?.close(); await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await pool.end(); }
}
await main();
