import { expect, test } from "@playwright/test";
import { dropshipFixture, disposableUrl } from "../../api/test/dropship-fixture";

test.describe("independent retail and partner journeys on real PostgreSQL", () => {
  test.skip(!disposableUrl(), "Requires disposable local WATCH_T48_DATABASE_URL");
  test.describe.configure({ mode: "serial" });
  let f: Awaited<ReturnType<typeof dropshipFixture>>;
  test.beforeEach(async ({ page }) => {
    f = await dropshipFixture();
    await f.pool.query("UPDATE product_variants SET price_minor=15000");
    await f.app.listen({ host: "127.0.0.1", port: 3001 });
    await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "watch_session", value: f.owners[2]!.token, domain: "127.0.0.1", path: "/" }]);
  });
  test.afterEach(async () => { await f?.close(); });

  for (const [width, colorScheme] of [[390, "light"], [320, "dark"], [1280, "light"]] as const) {
    test(`retail catalog keeps partner commercial data private at ${width} ${colorScheme}`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/shop");
      await expect(page.getByRole("heading", { name: "Каталог часов", exact: true })).toBeVisible();
      await page.screenshot({ path: `test-results/ux-buyer-catalog-${width}-${colorScheme}.png`, fullPage: true });
      await page.getByRole("button", { name: /Тестовые часы T48/ }).click();
      const action = page.getByRole("link", { name: "Задать вопрос магазину", exact: true });
      const url = new URL((await action.getAttribute("href"))!);
      expect(url.origin + url.pathname).toBe("https://t.me/test_support");
      expect(url.searchParams.get("text")).toContain("Тестовые часы T48");
      expect(url.searchParams.get("text")).toContain("TEST-T48");
      await expect(page.getByText("TEST ONLY sales material")).toHaveCount(0);
      await expect(page.getByText(/Ваша цена|Ожидаемый заработок|Комиссия/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Добавить в корзину", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Скопировать запрос", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Запрос скопирован");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url.searchParams.get("text"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/ux-buyer-detail-${width}-${colorScheme}.png`, fullPage: true });
      const denied = await page.request.get("/api/v1/partner/orders");
      expect(denied.status()).toBe(403);
    });
  }

  test("explicit acceptance activates once, then order, price correction and blocked history", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/shop");
    await page.getByRole("link", { name: "Продавать с нами", exact: true }).click();
    await expect(page.getByRole("button", { name: "Принять условия и начать" })).toBeDisabled();
    expect((await f.pool.query("SELECT 1 FROM partners WHERE user_id=$1", [f.owners[2]!.user])).rowCount).toBe(0);
    await page.screenshot({ path: "test-results/ux-onboarding-mobile.png", fullPage: true });
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Принять условия и начать" }).click();
    await expect(page.getByRole("heading", { name: "Два способа продажи" })).toBeVisible();
    const created = (await f.pool.query("SELECT id,status FROM partners WHERE user_id=$1", [f.owners[2]!.user])).rows[0];
    expect(created.status).toBe("ACTIVE");
    expect((await f.pool.query("SELECT 1 FROM partner_terms_acceptances WHERE partner_id=$1", [created.id])).rowCount).toBe(1);
    await page.screenshot({ path: "test-results/ux-first-dashboard-mobile.png", fullPage: true });
    await page.goto(`/checkout?mode=partner&product=${f.slug}&variant=${f.variant}`);
    const price = page.getByLabel("Цена для покупателя за 1 шт., BYN");
    await price.fill("90");
    await page.getByLabel("Имя получателя", { exact: true }).fill("Тестовый получатель");
    await page.getByLabel("Телефон", { exact: true }).fill("+375291234567");
    await page.getByLabel("Адрес доставки", { exact: true }).fill("TEST ONLY Минск, тестовый адрес");
    await page.getByLabel("Я ознакомился с обработкой").check();
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.locator("#retail-error")).toContainText("100.00 BYN");
    await price.fill("145");
    await expect(page.locator("#retail-error")).toHaveCount(0);
    await f.pool.query("UPDATE product_variants SET dropship_price_minor=12000 WHERE id=$1", [f.variant]);
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByText(/100.00 BYN → 120.00 BYN/)).toBeVisible();
    await expect(page.getByText(/Ожидаемый заработок теперь 25.00 BYN/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeDisabled();
    await page.screenshot({ path: "test-results/ux-price-changed-mobile.png", fullPage: true });
    await page.getByLabel("Согласен с новым расчётом").check();
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Заказ №.* создан/ })).toBeVisible();
    expect((await f.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(1);
    await page.screenshot({ path: "test-results/ux-order-created-mobile.png", fullPage: true });
    await f.pool.query("UPDATE partners SET status='BLOCKED' WHERE id=$1", [created.id]);
    await page.goto("/partner");
    await expect(page.getByText(/Новые заказы и заявки на выплату недоступны/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Два способа продажи" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/ux-blocked-partner-mobile.png", fullPage: true });
  });
});
