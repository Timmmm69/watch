import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { createApp } from "../../api/src/app";
import { CartService } from "../../api/src/cart/cart";
import { CheckoutService } from "../../api/src/orders/checkout";
import { AdminOrderService } from "../../api/src/orders/admin";
import { LegalDocuments } from "../../api/src/legal/legal";
import { SessionStore, hashSessionToken } from "../../api/src/auth/session";

async function fill(page: Page) {
  await page.getByLabel("Имя получателя", { exact: true }).fill("Покупатель");
  await page.getByLabel("Телефон", { exact: true }).fill("+375 (29) 123-45-67");
  await page.getByLabel("Адрес и детали доставки", { exact: true }).fill("Минск, адрес доставки");
  await page.getByLabel("Принимаю текущие условия продажи").check();
  await page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности").check();
}
async function telegram(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
}

test.describe("Checkout with seeded PostgreSQL Session and real API", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires migrated TEST_DATABASE_URL and free API port 3001");
  const schema = `checkout_ui_${randomUUID().replaceAll("-", "")}`;
  const buyer = randomUUID(), product = randomUUID(), variant = randomUUID(), supplier = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const originalSales = { id: randomUUID(), version: randomUUID() };
  const privacy = { id: randomUUID(), version: randomUUID() };
  const docs = { SALES_TERMS: originalSales, PRIVACY: privacy };
  const currency = process.env.TEST_PLATFORM_CURRENCY ?? "BYN";
  let pool: Pool, app: ReturnType<typeof createApp>;
  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const table of ["users", "sessions", "partners", "partner_terms_acceptances", "legal_documents", "platform_settings",
      "suppliers", "products", "product_variants", "inventory_items", "inventory_sync_runs", "attribution_touches", "events", "audit_logs"]) {
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    for (const migration of ["20260930100000_cart", "20260930110000_orders"]) {
      await pool.query(await readFile(resolve(__dirname, `../../../packages/db/prisma/migrations/${migration}/migration.sql`), "utf8"));
    }
    await pool.query("INSERT INTO platform_settings (singleton_id,platform_currency) VALUES (1,$1)", [currency]);
    await pool.query("INSERT INTO users (id,telegram_user_id,first_name,is_admin) VALUES ($1,$2,'Buyer',true)", [buyer, String(BigInt(`0x${buyer.replaceAll("-", "").slice(0, 15)}`))]);
    await pool.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [randomUUID(), buyer, hashSessionToken(token)]);
    await pool.query("INSERT INTO suppliers (id,name) VALUES ($1,'Test supplier')", [supplier]);
    await pool.query("INSERT INTO products (id,supplier_id,title,slug,status) VALUES ($1,$2,'Часы для checkout',$1::uuid::text,'ACTIVE')", [product, supplier]);
    await pool.query(`INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key,status)
      VALUES ($1,$2,'CHECKOUT',1000,$3,0,$1::uuid::text,'ACTIVE')`, [variant, product, currency]);
    await pool.query("INSERT INTO inventory_items (variant_id,source_quantity,source_status,last_successful_sync_at) VALUES ($1,10,'OK',now())", [variant]);
    for (const [type, doc] of Object.entries(docs)) await pool.query(`INSERT INTO legal_documents
      (id,type,version,sha256,content_markdown,effective_at) VALUES ($1,$2,$3,$4,$5,now())`,
      [doc.id, type, doc.version, randomBytes(32).toString("hex"), type === "PRIVACY" ? "Тестовая политика конфиденциальности" : "Тестовые условия продажи"]);
    app = createApp({ logger: false, checkReadiness: async () => undefined,
      auth: { store: new SessionStore(pool, new Set([String(BigInt(`0x${buyer.replaceAll("-", "").slice(0, 15)}`))])), csrfSecret: Buffer.alloc(32, 3), appBaseUrl: "http://127.0.0.1:3000", adminIds: () => new Set([String(BigInt(`0x${buyer.replaceAll("-", "").slice(0, 15)}`))]) },
      orders: new AdminOrderService(pool),
      cart: new CartService(pool, currency), checkout: new CheckoutService(pool, currency, docs), legal: new LegalDocuments(pool, docs) });
    await app.listen({ host: "127.0.0.1", port: 3001 });
  });
  test.beforeEach(async ({ page }) => {
    docs.SALES_TERMS = originalSales;
    await pool.query("TRUNCATE carts,orders,events,audit_logs CASCADE");
    await pool.query("UPDATE products SET status='ACTIVE'");
    await pool.query("UPDATE product_variants SET price_minor=1000");
    await new CartService(pool, currency).put(buyer, variant, 1);
    await telegram(page);
    await page.context().addCookies([{ name: "watch_session", value: token, domain: "127.0.0.1", path: "/" }]);
  });
  test.afterAll(async () => { await app?.close(); if (pool) { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); } });
  for (const outcome of ["delivered","cancelled","failed"] as const) test(`Admin real Session transitions Order to ${outcome}`, async ({ page }) => {
    const order = (await new CheckoutService(pool,currency,docs).checkout(buyer,randomUUID(), {
      items: [{ variantId: variant,quantity: 1,expectedUnitPriceMinor: 1000 }],recipientName: "<script>private</script>",phone: "375291234567",address: "Минск",
      comment: "",salesTermsDocumentId: docs.SALES_TERMS.id,privacyDocumentId: docs.PRIVACY.id,salesTermsAccepted: true,privacyAcknowledged: true
    })).order;
    await page.goto("/admin/orders");
    await page.getByRole("link", { name: order.publicNumber }).click();
    await expect(page.getByText("<script>private</script>", { exact: true })).toBeVisible();
    expect(await page.locator("main script").count()).toBe(0);
    let lost = false;
    if (outcome === "delivered") await page.route(`**/api/v1/admin/orders/${order.id}/transition`, async (route) => {
      const response = await route.fetch();
      if (!lost) { lost = true; expect(response.ok()).toBe(true); await route.abort("failed"); }
      else await route.fulfill({ response });
    });
    const act = async (name: string) => {
      await page.getByRole("button", { name,exact: true }).click();
      await page.getByRole("button", { name: "Да, подтвердить",exact: true }).click();
      await expect(page.getByLabel("Подтверждение действия")).toHaveCount(0);
      await expect(page.getByLabel("Загрузка заказов")).toHaveCount(0);
    };
    if (outcome === "cancelled") await act("Отменить заказ");
    else {
      if (outcome === "delivered") {
        await page.getByRole("button", { name: "Подтвердить заказ",exact: true }).click();
        await page.getByRole("button", { name: "Да, подтвердить",exact: true }).click();
        await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      }
      await act("Подтвердить заказ"); await act("Начать сборку"); await act("Подтвердить отправку");
      await expect(page.getByRole("button", { name: "Отменить заказ",exact: true })).toHaveCount(0);
      await act(outcome === "delivered" ? "Подтвердить доставку покупателю" : "Зафиксировать недоставку");
    }
    const row = (await pool.query("SELECT * FROM orders WHERE id=$1", [order.id])).rows[0];
    expect(row.status).toBe({ delivered: "DELIVERED",cancelled: "CANCELLED",failed: "DELIVERY_FAILED" }[outcome]);
    expect((await pool.query("SELECT status FROM inventory_reservations WHERE order_id=$1", [order.id])).rows[0].status).toBe(outcome === "cancelled" ? "RELEASED" : "ACTIVE");
    await expect(page.getByRole("button", { name: /Завершить/ })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: order.publicNumber })).toBeVisible();
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs")).rows[0].count).toBe(outcome === "cancelled" ? 1 : 4);
  });
  test("Cart → checkout → lost successful response → same-key replay creates one Order", async ({ page }) => {
    await page.goto("/cart");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    await fill(page);
    const keys: string[] = [];
    await page.route("**/api/v1/orders", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      const response = await route.fetch();
      if (keys.length === 1) { expect(response.status()).toBe(201); await route.abort("failed"); }
      else { expect(response.status()).toBe(200); await route.fulfill({ response }); }
    });
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Ответ не получен");
    await expect(page.getByLabel("Имя получателя", { exact: true })).toHaveValue("Покупатель");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeEnabled();
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    await expect(page.getByRole("heading", { name: "Заказ оформлен" })).toBeVisible();
    await expect(page.getByText("Оператор подтвердит заказ.")).toBeVisible();
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    for (const table of ["orders", "order_items", "inventory_reservations", "events"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(1);
    }
    expect((await pool.query("SELECT count(*)::int AS count FROM cart_items")).rows[0].count).toBe(0);
    const order = (await pool.query("SELECT * FROM orders")).rows[0];
    await expect(page.getByText(`Заказ ${order.public_number}`, { exact: true })).toBeVisible();
    expect(order.sales_terms_accepted_at.getTime()).toBe(order.created_at.getTime());
    expect(order.privacy_acknowledged_at.getTime()).toBe(order.created_at.getTime());
  });
  test("real price change requires reconfirmation; new legal artifact clears only its control", async ({ page }) => {
    await page.goto("/checkout"); await fill(page);
    await pool.query("UPDATE product_variants SET price_minor=2000");
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Цена изменилась");
    await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeDisabled();
    await page.getByLabel("Подтверждаю новую цену и итог заказа").check();
    const next = { id: randomUUID(), version: randomUUID() };
    await pool.query(`INSERT INTO legal_documents (id,type,version,sha256,content_markdown,effective_at)
      VALUES ($1,'SALES_TERMS',$2,$3,'Новые тестовые условия',now())`, [next.id, next.version, randomBytes(32).toString("hex")]);
    docs.SALES_TERMS = next;
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Документы изменились");
    await expect(page.getByLabel("Принимаю текущие условия продажи")).not.toBeChecked();
    await expect(page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности")).toBeChecked();
    expect((await pool.query("SELECT count(*)::int AS count FROM orders")).rows[0].count).toBe(0);
    await page.getByLabel("Принимаю текущие условия продажи").check();
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    await expect(page.getByRole("heading", { name: "Заказ оформлен" })).toBeVisible();
    expect((await pool.query("SELECT total_minor,sales_terms_document_id FROM orders")).rows[0]).toEqual({ total_minor: 2000, sales_terms_document_id: next.id });
  });
  test("product archived after form load refreshes Cart, marks line and preserves fields", async ({ page }) => {
    await page.goto("/checkout"); await fill(page);
    await pool.query("UPDATE products SET status='ARCHIVED'");
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Корзина изменилась");
    await expect(page.getByText("Товар больше недоступен.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeDisabled();
    await expect(page.getByLabel("Адрес и детали доставки", { exact: true })).toHaveValue("Минск, адрес доставки");
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory_reservations")).rows[0].count).toBe(0);
  });
});

const fixtureCart = { id: "cart", currency: "BYN", items: [{ variantId: "00000000-0000-4000-8000-000000000001", title: "Часы", sku: "SKU", quantity: 1,
  priceMinor: 1000, lineTotalMinor: 1000, issues: [] }], totalMinor: 1000, canCheckout: true };
async function mockCheckout(page: Page) {
  await telegram(page);
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Buyer" }, csrfToken: "fixture" } }));
  await page.route("**/api/v1/cart", (route) => route.fulfill({ json: fixtureCart }));
  await page.route("**/api/v1/legal/*/current", (route) => route.fulfill({ json: { id: route.request().url().includes("SALES_TERMS")
    ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000003", version: "v1", contentMarkdown: "Тестовый документ" } }));
}
test("validation focuses first invalid field; canonical retry keeps key and edits rotate it", async ({ page }) => {
  await mockCheckout(page);
  const submissions: { key: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/orders", (route) => {
    submissions.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
    return route.abort("failed");
  });
  await page.goto("/checkout");
  await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeDisabled();
  await page.getByLabel("Принимаю текущие условия продажи").check();
  await page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности").check();
  await page.getByRole("button", { name: "Подтвердить заказ" }).click();
  await expect(page.getByLabel("Имя получателя", { exact: true })).toBeFocused();
  expect(submissions).toHaveLength(0);
  await fill(page);
  const send = async () => { await page.getByRole("button", { name: "Подтвердить заказ" }).click(); await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeEnabled(); };
  await send();
  await page.getByLabel("Телефон", { exact: true }).fill("375291234567"); await send();
  expect(submissions[1]!.key).toBe(submissions[0]!.key);
  await page.getByLabel("Комментарий (необязательно)").fill("Другой комментарий"); await send();
  expect(submissions[2]!.key).not.toBe(submissions[0]!.key);
});
test("one auth recovery then reopen state; submit spinner prevents duplicate requests", async ({ page }) => {
  await mockCheckout(page); let attempts = 0, sessions = 0;
  await page.route("**/api/v1/auth/session", (route) => { sessions++; return route.fulfill({ json: { user: { firstName: "Buyer" }, csrfToken: "recovered" } }); });
  await page.route("**/api/v1/orders", async (route) => {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ status: 401, json: { error: { code: "SESSION_EXPIRED" } } });
  });
  await page.goto("/checkout"); await fill(page);
  await page.getByRole("button", { name: "Подтвердить заказ" }).click();
  await expect(page.getByRole("button", { name: "Отправка…" })).toBeDisabled();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Откройте приложение заново через Telegram.");
  await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeDisabled();
  expect(attempts).toBe(2); expect(sessions).toBe(2);
});
test("empty checkout redirects to Cart", async ({ page }) => {
  await mockCheckout(page);
  await page.route("**/api/v1/cart", (route) => route.fulfill({ json: { ...fixtureCart, items: [], canCheckout: false } }));
  await page.goto("/checkout"); await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText("Корзина пуста", { exact: true })).toBeVisible();
});

for (const [code, text] of [["OUT_OF_STOCK", "Недостаточно товара"], ["INVENTORY_STALE", "Данные о наличии устарели"],
  ["INVENTORY_UNKNOWN", "Наличие пока неизвестно"], ["USER_BLOCKED", "Доступ заблокирован"]]) {
  test(`${code} preserves fields and prevents submission of unavailable lines`, async ({ page }) => {
    await mockCheckout(page);
    await page.goto("/checkout"); await fill(page);
    await page.route("**/api/v1/orders", (route) => route.fulfill({ status: code === "USER_BLOCKED" ? 403 : 409,
      json: { error: { code, details: { affectedVariantIds: [fixtureCart.items[0]!.variantId] } } } }));
    await page.route("**/api/v1/cart", (route) => route.fulfill({ json: { ...fixtureCart, canCheckout: false,
      items: [{ ...fixtureCart.items[0], issues: [code] }] } }));
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(text!);
    await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeDisabled();
    await expect(page.getByLabel("Имя получателя", { exact: true })).toHaveValue("Покупатель");
  });
}
test("Privacy change on focus clears acknowledgement independently and legal read failure blocks submit", async ({ page }) => {
  await mockCheckout(page); await page.goto("/checkout"); await fill(page);
  await page.route("**/api/v1/legal/PRIVACY/current", (route) => route.fulfill({ json: {
    id: "00000000-0000-4000-8000-000000000004", version: "v2", contentMarkdown: "Новая политика" } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности")).not.toBeChecked();
  await expect(page.getByLabel("Принимаю текущие условия продажи")).toBeChecked();
  await page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности").check();
  await page.route("**/api/v1/legal/PRIVACY/current", (route) => route.fulfill({ status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } }));
  await page.getByRole("button", { name: "Обновить оформление" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Не удалось выполнить запрос");
  await expect(page.getByRole("button", { name: "Подтвердить заказ" })).toBeDisabled();
});
