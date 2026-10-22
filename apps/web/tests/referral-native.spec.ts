import { expect, test, type Page } from "@playwright/test";
import { disposableUrl } from "../../api/test/dropship-fixture";
import { referralFixture, telegramLaunch } from "../../api/test/referral-fixture";

test.describe("Referral buyer storefront with real native PostgreSQL/API", () => {
  test.skip(!disposableUrl(), "Requires disposable local WATCH_T48_DATABASE_URL=/watch_t48");
  test.describe.configure({ mode: "serial" });
  let f: Awaited<ReturnType<typeof referralFixture>>;
  test.beforeEach(async ({ page }) => {
    f = await referralFixture();
    await f.app.listen({ host: "127.0.0.1", port: 3001 });
    await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  });
  test.afterEach(async () => { await f?.close(); });
  async function buyer(page: Page) {
    const link = await f.referral.getOrCreate(f.owners[0]!.user, f.product);
    await page.addInitScript(initData => {
      window.Telegram = { WebApp: { initData, ready() {}, expand() {} } };
    }, telegramLaunch(link.url));
    await page.goto("/shop");
    await expect(page.getByRole("heading", { name: "Тестовые часы T48", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Добавить в корзину" })).toBeEnabled();
    await page.getByRole("button", { name: "Добавить в корзину" }).click();
    await page.getByRole("link", { name: /Корзина/ }).click();
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Оформление заказа" })).toBeVisible();
    await page.getByLabel("Имя получателя", { exact: true }).fill("Покупатель");
    await page.getByLabel("Телефон", { exact: true }).fill("375291234567");
    await page.getByLabel("Адрес и детали доставки", { exact: true }).fill("Минск, тестовый адрес");
    await page.getByLabel("Принимаю текущие условия продажи").check();
    await page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности").check();
  }
  test("buyer opens signed referral deep link, shops and checks out without partner registration or markup", async ({ page }) => {
    await buyer(page);
    await expect(page.getByLabel(/Цена покупателю/)).toHaveCount(0);
    await page.getByRole("button", { name: "Создать заказ", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Заказ создан" })).toBeVisible();
    expect((await f.pool.query("SELECT total_minor,partner_id_snapshot,inventory_mode FROM orders")).rows[0])
      .toEqual({ total_minor: 15000, partner_id_snapshot: f.owners[0]!.partner, inventory_mode: "native" });
    expect((await f.pool.query("SELECT gross_amount_minor,state FROM commissions")).rows[0]).toEqual({ gross_amount_minor: 2000, state: "PENDING" });
    expect((await f.pool.query("SELECT native_reserved_quantity FROM inventory_items")).rows[0].native_reserved_quantity).toBe(1);
  });
  test("requires explicit new-price confirmation and preserves one order on a lost successful response", async ({ page }) => {
    await buyer(page);
    await f.pool.query("UPDATE product_variants SET price_minor=16000");
    await page.getByRole("button", { name: "Создать заказ", exact: true }).click();
    await expect(page.getByLabel("Я проверил и принимаю новую сумму заказа")).toBeVisible();
    await expect(page.getByRole("button", { name: "Создать заказ", exact: true })).toBeDisabled();
    await page.getByLabel("Я проверил и принимаю новую сумму заказа").check();
    let lost = false;
    await page.route("**/api/v1/orders", async route => {
      const response = await route.fetch();
      if (!lost) { lost = true; expect(response.status()).toBe(201); await route.abort(); }
      else { expect(response.status()).toBe(200); await route.fulfill({ response }); }
    });
    await page.getByRole("button", { name: "Создать заказ", exact: true }).click();
    await expect(page.getByRole("button", { name: "Создать заказ", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Создать заказ", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Заказ создан" })).toBeVisible();
    expect((await f.pool.query("SELECT count(*)::int AS n,sum(total_minor)::int AS total FROM orders")).rows[0]).toEqual({ n: 1, total: 16000 });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM commissions")).rows[0].n).toBe(1);
  });
  test("partner sees fixed commission, promotional material and working personal links", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.context().addCookies([{ name: "watch_session", value: f.owners[0]!.token, domain: "127.0.0.1", path: "/" }]);
    await page.goto("/shop");
    await page.getByRole("button", { name: "Скопировать ссылку на магазин" }).click();
    await expect(page.getByText(/Ссылка скопирована: https:\/\/t.me\//)).toBeVisible();
    await page.getByRole("button", { name: /Тестовые часы T48/ }).click();
    await expect(page.getByRole("cell", { name: /20,00/ })).toBeVisible();
    await expect(page.getByText("TEST ONLY sales material")).toBeVisible();
    await page.getByRole("button", { name: "Скопировать ссылку на товар" }).click();
    await expect(page.getByText(/Ссылка скопирована: https:\/\/t.me\//)).toBeVisible();
    expect((await f.pool.query("SELECT count(*)::int AS n FROM referral_links")).rows[0].n).toBe(2);
  });
});
