import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve, join } from "node:path";
import { Pool } from "pg";
import { InitialInventoryImport, INVENTORY_HEADERS } from "../src/inventory/initial-import.js";
import { CatalogService } from "../src/catalog/catalog.js";
import { AssetService, type ObjectStorage } from "../src/catalog/assets.js";
import { DropshipCheckoutService } from "../src/orders/dropship-checkout.js";
import { OrderViewService } from "../src/orders/views.js";
import { LegalDocuments } from "../src/legal/legal.js";
import { PartnerService } from "../src/partner/partner.js";
import { SessionStore, hashSessionToken } from "../src/auth/session.js";
import { deriveCsrfToken } from "../src/auth/middleware.js";
import { CartService } from "../src/cart/cart.js";
import { ReferralService } from "../src/referral/referral.js";
import { createApp } from "../src/app.js";
import { AdminOrderService } from "../src/orders/admin.js";
import { AdminReturnService } from "../src/returns/returns.js";
import { OrderMoneyService } from "../src/finance/money.js";
import { PayoutService } from "../src/finance/payouts.js";
import { AnalyticsService } from "../src/analytics/analytics.js";

export function disposableUrl() {
  const url = process.env.WATCH_T48_DATABASE_URL;
  if (url) {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/watch_t48")
      throw new Error("WATCH_T48_DATABASE_URL must be disposable local /watch_t48");
  }
  return url;
}

export async function dropshipFixture(quantity = 10, cost = "800.02", adminAccess = false) {
  const url = disposableUrl();
  if (!url) throw new Error("WATCH_T48_DATABASE_URL is required");
  const schema = `t48_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, max: 12, options: `-c search_path=${schema},public` });
  // Both package test runners start in apps/api or apps/web.
  const migrations = resolve(process.cwd(), "../../packages/db/prisma/migrations");
  for (const name of (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort())
    await pool.query(await readFile(join(migrations, name, "migration.sql"), "utf8"));
  await pool.query("INSERT INTO platform_settings(singleton_id,platform_currency) VALUES(1,'BYN')");
  const owners = [];
  const csrfSecret = Buffer.alloc(32, 8);
  for (let i = 0; i < 3; i++) {
    const user = randomUUID(), partner = i < 2 ? randomUUID() : null, session = randomUUID(), token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO users(id,telegram_user_id,first_name,is_admin) VALUES($1,$2,'TEST ONLY',true)", [user, i + 1]);
    if (partner) await pool.query("INSERT INTO partners(id,user_id) VALUES($1,$2)", [partner, user]);
    await pool.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [session, user, hashSessionToken(token)]);
    owners.push({ user, partner, token, headers: { cookie: `watch_session=${token}`, origin: "http://127.0.0.1:3000", "x-csrf-token": deriveCsrfToken(csrfSecret, session) } });
  }
  const supplier = randomUUID();
  await pool.query("INSERT INTO suppliers(id,name) VALUES($1,'TEST ONLY Supplier')", [supplier]);
  const docs = { PARTNER_TERMS: { id: randomUUID(), version: "t48-partner" }, PRIVACY: { id: randomUUID(), version: "t48-privacy" } };
  for (const [type, doc] of Object.entries(docs)) await pool.query(`INSERT INTO legal_documents
    (id,type,version,sha256,content_markdown,effective_at,requires_reacceptance) VALUES($1,$2,$3,$4,$5,now(),true)`,
  [doc.id, type, doc.version, randomBytes(32).toString("hex"), `TEST ONLY ${type}`]);
  for (const owner of owners.filter((owner) => owner.partner)) await pool.query("INSERT INTO partner_terms_acceptances(partner_id,legal_document_id) VALUES($1,$2)", [owner.partner, docs.PARTNER_TERMS.id]);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXsAAAAASUVORK5CYII=", "base64");
  const storage: ObjectStorage = { put: async () => undefined, get: async () => Readable.from(image), delete: async () => undefined };
  const importer = new InitialInventoryImport(pool, storage);
  const source = [INVENTORY_HEADERS, ["TEST-T48", "Тестовые часы T48", "", String(quantity), cost, "100.00", "", "TEST ONLY description", ""]];
  const preview = await importer.preview(source);
  if (preview.errors.length) throw new Error(JSON.stringify(preview.errors));
  await importer.apply(source, preview.confirmation, { actorUserId: owners[0]!.user, operationKey: randomUUID(), reason: "TEST ONLY T48", occurredAt: new Date("2026-10-01T00:00:00Z") });
  const variant = (await pool.query<{ id: string; product_id: string }>("SELECT id,product_id FROM product_variants")).rows[0]!;
  const category = randomUUID();
  await pool.query("INSERT INTO categories(id,name,slug) VALUES($1,'TEST ONLY','test-t48')", [category]);
  await pool.query("INSERT INTO product_categories(product_id,category_id) VALUES($1,$2)", [variant.product_id, category]);
  await pool.query(`INSERT INTO product_assets(id,product_id,type,purpose,storage_key,mime_type,size_bytes)
    VALUES($1,$2,'IMAGE','STOREFRONT','test-t48.png','image/png',$3)`, [randomUUID(), variant.product_id, image.length]);
  await pool.query(`INSERT INTO product_assets(id,product_id,type,purpose,text_content)
    VALUES($1,$2,'TEXT','PARTNER_CONTENT','TEST ONLY sales material')`, [randomUUID(), variant.product_id]);
  await pool.query("UPDATE products SET status='ACTIVE'; UPDATE product_variants SET status='ACTIVE'");
  const slug = (await pool.query<{ slug: string }>("SELECT slug FROM products")).rows[0]!.slug;
  const service = new DropshipCheckoutService(pool, "BYN", docs);
  const legal = new LegalDocuments(pool, docs);
  const catalog = new CatalogService(pool, "BYN", undefined, undefined, undefined, true);
  const views = new OrderViewService(pool, "@test_support");
  const adminIds = adminAccess ? new Set(["3"]) : new Set<string>();
  const orders = new AdminOrderService(pool), returns = new AdminReturnService(pool);
  const app = createApp({ nativeCommerce: true, logger: false, checkReadiness: async () => undefined,
    auth: { store: new SessionStore(pool, adminIds), csrfSecret, appBaseUrl: "http://127.0.0.1:3000", adminIds: () => adminIds },
    ...(adminAccess ? { orders, returns, money: new OrderMoneyService(pool), payouts: new PayoutService(pool, "BYN", docs.PARTNER_TERMS, 1),
      analytics: new AnalyticsService(pool, "BYN", "Europe/Minsk", 600, 86400) } : {}),
    checkout: service, legal, partner: new PartnerService(pool, legal), orderViews: views,
    catalog: { service: catalog }, assets: { service: new AssetService(pool, storage) },
    cart: new CartService(pool, "BYN"), referral: new ReferralService(pool, legal, "test_bot") });
  const request = (r = 14500, q = 1) => ({ items: [{ variantId: variant.id, quantity: q, expectedDropshipPriceMinor: 10000, customerUnitPriceMinor: r }],
    recipientName: "Тестовый получатель", phone: "+375 (29) 123-45-67", address: "TEST ONLY Минск, адрес", comment: "",
    partnerTermsDocumentId: docs.PARTNER_TERMS.id, privacyDocumentId: docs.PRIVACY.id, privacyAcknowledged: true });
  return { pool, owners, docs, service, views, catalog, app, orders, returns, variant: variant.id, product: variant.product_id, slug, request,
    close: async () => {
      // Next dev prefetch/proxy can retain HTTP sockets after the browser page closes.
      // This API and its clients belong exclusively to this disposable fixture.
      app.server.closeAllConnections();
      await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    } };
}
