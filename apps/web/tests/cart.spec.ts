import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDatabasePool } from "../../../packages/db/src/index";
import { createApp } from "../../api/src/app";
import { CartService } from "../../api/src/cart/cart";
import { CatalogService, initializePlatformCurrency, seedSupplier } from "../../api/src/catalog/catalog";
import { SessionStore, hashSessionToken } from "../../api/src/auth/session";

test.describe("Cart end-to-end with a real DB Session", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires migrated TEST_DATABASE_URL and a free API port 3001");
  const buyer = randomUUID(); const product = randomUUID(); const variant = randomUUID(); const unavailable = randomUUID();
  const sessionId = randomUUID(); const token = randomBytes(32).toString("base64url");
  let pool: ReturnType<typeof createDatabasePool>;
  let app: ReturnType<typeof createApp>;
  test.beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
    const { platformCurrency } = await initializePlatformCurrency(pool, process.env.TEST_PLATFORM_CURRENCY ?? "BYN");
    const { supplierId } = await seedSupplier(pool, "Integration supplier");
    await pool.query("INSERT INTO users (id, telegram_user_id, first_name) VALUES ($1,$2,'Cart Buyer')",
      [buyer, String(BigInt(`0x${buyer.replaceAll("-", "").slice(0, 15)}`))]);
    await pool.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [sessionId,buyer,hashSessionToken(token)]);
    await pool.query("INSERT INTO products (id,supplier_id,title,slug,status) VALUES ($1,$2,'Тестовые часы',$3,'ACTIVE')", [product,supplierId,product]);
    await pool.query(`INSERT INTO product_variants (id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key,status)
      SELECT id,$2,CASE WHEN id=$4 THEN 'CART-AVAILABLE' ELSE 'CART-UNKNOWN' END,10000,$3,0,id::text,'ACTIVE' FROM unnest($1::uuid[]) id`, [[variant,unavailable],product,platformCurrency,variant]);
    await pool.query(`INSERT INTO inventory_items (variant_id,source_quantity,source_status,last_successful_sync_at)
      VALUES ($1,100,'OK',now()),($2,NULL,'UNINITIALIZED',NULL)`, [variant,unavailable]);
    // Test-only API uses the normal Session middleware; there is no test-auth route.
    app = createApp({ logger: false, checkReadiness: async () => undefined,
      auth: { store: new SessionStore(pool, new Set()), csrfSecret: Buffer.alloc(32, 3), appBaseUrl: "http://127.0.0.1:3000", adminIds: () => new Set() },
      cart: new CartService(pool, platformCurrency), catalog: { service: new CatalogService(pool, platformCurrency) } });
    await app.listen({ host: "127.0.0.1", port: 3001 });
  });
  test.afterAll(async () => {
    await app?.close();
    if (!pool) return;
    await pool.query("DELETE FROM carts WHERE buyer_user_id=$1", [buyer]);
    await pool.query("DELETE FROM sessions WHERE user_id=$1", [buyer]);
    await pool.query("DELETE FROM inventory_items WHERE variant_id=ANY($1::uuid[])", [[variant,unavailable]]);
    await pool.query("DELETE FROM product_variants WHERE product_id=$1", [product]);
    await pool.query("DELETE FROM products WHERE id=$1", [product]);
    await pool.query("DELETE FROM users WHERE id=$1", [buyer]);
    await pool.end();
  });
  test("catalog → add → persisted cart → quantity → live issues → remove and clear", async ({ page }) => {
    await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "watch_session", value: token, domain: "127.0.0.1", path: "/" }]);
    await page.goto("/shop");
    await page.getByRole("button", { name: /Тестовые часы/ }).click();
    await page.getByLabel("Вариант товара").selectOption(unavailable);
    await expect(page.getByRole("button", { name: "Добавить в корзину" })).toBeDisabled();
    await page.getByLabel("Вариант товара").selectOption(variant);
    await page.getByRole("button", { name: "Добавить в корзину" }).click();
    await expect(page.getByRole("status")).toHaveText("Товар добавлен в корзину.");
    await page.getByRole("link", { name: "Корзина (1)" }).click();
    await expect(page.getByRole("heading", { name: "Корзина", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Тестовые часы" })).toBeVisible();
    await page.getByRole("button", { name: "Увеличить CART-AVAILABLE" }).click();
    await expect(page.getByLabel("Количество CART-AVAILABLE").getByText("2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Уменьшить CART-AVAILABLE" }).click();
    await expect(page.getByLabel("Количество CART-AVAILABLE").getByText("1", { exact: true })).toBeVisible();
    await pool.query("UPDATE product_variants SET price_minor=12345 WHERE id=$1", [variant]);
    await pool.query("UPDATE inventory_items SET last_successful_sync_at=now()-interval '11 minutes' WHERE variant_id=$1", [variant]);
    await page.getByRole("button", { name: "Обновить корзину" }).click();
    await expect(page.getByText("Данные о наличии устарели. Обновите корзину.")).toBeVisible();
    await expect(page.getByText(/123,45.*за шт/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Оформить заказ" })).toBeDisabled();
    await pool.query("UPDATE products SET status='ARCHIVED' WHERE id=$1", [product]);
    await page.getByRole("button", { name: "Обновить корзину" }).click();
    await expect(page.getByText("Товар больше недоступен.")).toBeVisible();
    await page.getByRole("button", { name: "Удалить CART-AVAILABLE" }).click();
    await expect(page.getByText("Корзина пуста", { exact: true })).toBeVisible();
    await pool.query("UPDATE products SET status='ACTIVE' WHERE id=$1", [product]);
    await pool.query("UPDATE inventory_items SET last_successful_sync_at=now() WHERE variant_id=$1", [variant]);
    await page.getByRole("link", { name: "Перейти в каталог" }).click();
    await page.getByRole("button", { name: /Тестовые часы/ }).click();
    await page.getByLabel("Вариант товара").selectOption(variant);
    await page.getByRole("button", { name: "Добавить в корзину" }).click();
    await expect(page.getByRole("status")).toHaveText("Товар добавлен в корзину.");
    await page.getByRole("link", { name: "Корзина (1)" }).click();
    await page.getByRole("button", { name: "Очистить корзину" }).click();
    await expect(page.getByText("Корзина пуста", { exact: true })).toBeVisible();
  });
});

test("Cart preserves recoverable errors and performs only one session recovery", async ({ page }) => {
  let sessionRequests = 0; let cartRequests = 0;
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", (route) => {
    sessionRequests++;
    return route.fulfill({ contentType: "application/json", status: sessionRequests === 1 ? 200 : 401,
      body: JSON.stringify(sessionRequests === 1 ? { user: { firstName: "Buyer" }, csrfToken: "fixture" } : { error: { code: "SESSION_EXPIRED" } }) });
  });
  await page.route("**/api/v1/cart", (route) => {
    cartRequests++;
    return route.fulfill({ status: cartRequests === 1 ? 503 : 401, contentType: "application/json",
      body: JSON.stringify({ error: { code: cartRequests === 1 ? "DEPENDENCY_UNAVAILABLE" : "SESSION_EXPIRED" } }) });
  });
  await page.goto("/cart");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Не удалось обновить корзину");
  await page.getByRole("button", { name: "Обновить корзину" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Откройте приложение заново через Telegram.");
  expect(sessionRequests).toBe(2); expect(cartRequests).toBe(2);
});

test("retained referral launch does not override in-app Cart navigation", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: {
    user: { firstName: "Buyer" }, csrfToken: "fixture", isAdmin: false, partner: null
  } }));
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'signed-referral',ready(){},expand(){}}};" }));
  await page.route("**/api/v1/auth/telegram", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ user: { firstName: "Buyer" }, csrfToken: "fixture", launchTarget: "/shop?product=watch" }) }));
  await page.route("**/api/v1/catalog/categories", (route) => route.fulfill({ contentType: "application/json", body: '{"items":[]}' }));
  await page.route("**/api/v1/catalog/products?*", (route) => route.fulfill({ contentType: "application/json", body: '{"items":[],"total":0}' }));
  await page.route("**/api/v1/catalog/products/watch", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ id: "watch", title: "Часы по ссылке", slug: "watch", description: "", brand: null,
      currency: "BYN", priceFromMinor: 1000, availability: "UNKNOWN", gallery: [], variants: [] }) }));
  await page.route("**/api/v1/cart", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ id: "fixture", currency: "BYN", items: [], totalMinor: 0, canCheckout: false }) }));
  await page.goto("/shop");
  await expect(page.getByRole("heading", { name: "Часы по ссылке" })).toBeVisible();
  await page.getByRole("link", { name: "Корзина (0)" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText("Корзина пуста", { exact: true })).toBeVisible();
});
