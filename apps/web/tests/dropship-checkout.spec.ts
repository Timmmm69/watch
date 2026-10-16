import { expect, test, type Page } from "@playwright/test";
import { dropshipFixture, disposableUrl } from "../../api/test/dropship-fixture";

test.describe("T48 native checkout with real PostgreSQL Session/API", () => {
  test.skip(!disposableUrl(), "Requires local disposable WATCH_T48_DATABASE_URL=/watch_t48");
  test.describe.configure({ mode: "serial" });
  let fixture: Awaited<ReturnType<typeof dropshipFixture>>;
  test.beforeEach(async ({ page }) => {
    fixture = await dropshipFixture(10, "800.02", true);
    await fixture.app.listen({ host: "127.0.0.1", port: 3001 });
    await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "watch_session", value: fixture.owners[0]!.token, domain: "127.0.0.1", path: "/" }]);
  });
  test.afterEach(async () => { await fixture?.close(); });
  async function form(page: Page) {
    await page.goto(`/checkout?product=${fixture.slug}&variant=${fixture.variant}`);
    await expect(page.getByLabel("Цена покупателю за штуку (R), BYN")).toBeVisible();
  }
  async function fill(page: Page, r = "145.00") {
    await page.getByLabel("Цена покупателю за штуку (R), BYN").fill(r);
    await page.getByLabel("Имя получателя", { exact: true }).fill("Тестовый получатель");
    await page.getByLabel("Телефон", { exact: true }).fill("+375 (29) 123-45-67");
    await page.getByLabel("Адрес получателя", { exact: true }).fill("TEST ONLY Минск, адрес");
    await page.getByLabel("Я ознакомился с обработкой").check();
  }

  test("catalog D, sellable SKU and existing materials lead into the only new order flow", async ({ page }) => {
    await page.goto("/shop");
    await expect(page.getByText("Цена дропу (D) от 100,00")).toBeVisible();
    await page.getByRole("button", { name: /Тестовые часы T48/ }).click();
    await expect(page.getByText("TEST ONLY sales material")).toBeVisible();
    await expect(page.getByText(/TEST-T48 · D: .* · Доступно: 10/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Скопировать ссылку/ })).toHaveCount(0);
    await page.getByRole("link", { name: "Оформить заказ", exact: true }).click();
    await fill(page);
    await page.getByLabel("Количество", { exact: true }).fill("2");
    await expect(page.getByRole("region", { name: "Предварительный расчёт" })).toContainText("Сумма покупателю: 290.00 BYN");
    await expect(page.getByRole("region", { name: "Предварительный расчёт" })).toContainText("Предполагаемая наценка: 90.00 BYN");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Оплата ещё не подтверждена");
    await page.getByRole("link", { name: "Открыть заказ" }).click();
    await expect(page.getByText("Тестовый получатель", { exact: true })).toBeVisible();
    await expect(page.getByText("D при оформлении: 100.00 BYN · R: 145.00 BYN")).toBeVisible();
    await expect(page.getByText(/закупоч|procurement/i)).toHaveCount(0);
    await page.screenshot({ path: "test-results/t48-own-order.png", fullPage: true });
  });

  test("required recipient fields, R<D, precision, quantity and money bounds have readable errors", async ({ page }) => {
    await form(page);
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByText("Укажите имя: 2–100 символов.")).toBeVisible();
    await expect(page.getByText("Укажите телефон из 8–15 цифр.")).toBeVisible();
    await expect(page.getByText("Укажите адрес: 5–500 символов.")).toBeVisible();
    await fill(page, "99.99");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByText("Цена покупателю R должна быть не ниже цены дропу D.")).toBeVisible();
    await page.getByLabel("Цена покупателю за штуку (R), BYN").fill("145.001");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByText("Укажите сумму от 0 до 20 000 000 с точностью до копейки.")).toBeVisible();
    await page.getByLabel("Цена покупателю за штуку (R), BYN").fill("20000000");
    await page.getByLabel("Количество", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByText("Сумма заказа не должна превышать 20 000 000.00 BYN.")).toBeVisible();
    await page.getByLabel("Количество", { exact: true }).fill("1.5");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByText("Количество: целое от 1 до 99.")).toBeVisible();
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0);
  });

  test("changed D requires a visible recalculation and explicit confirmation, retaining recipient and R", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await form(page); await fill(page);
    const changed = await fixture.app.inject({ method: "PATCH", url: `/api/v1/admin/variants/${fixture.variant}`, headers: fixture.owners[2]!.headers, payload: { dropshipPriceMinor: 12000 } });
    expect(changed.statusCode).toBe(200);
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Цена дропу изменилась" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Предварительный расчёт" })).toContainText("Предполагаемая наценка: 25.00 BYN");
    await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Имя получателя", { exact: true })).toHaveValue("Тестовый получатель");
    await expect(page.getByLabel("Цена покупателю за штуку (R), BYN")).toHaveValue("145.00");
    await page.screenshot({ path: "test-results/t48-mobile-recalculation.png", fullPage: true });
    await page.getByLabel("Подтверждаю новый расчёт по актуальной D").check();
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Предполагаемая наценка: 25.00 BYN");
    expect((await fixture.pool.query("SELECT dropship_unit_price_minor FROM order_items")).rows[0].dropship_unit_price_minor).toBe(12000);
  });

  test("Admin form edits D independently and reloads the persisted value", async ({ page }) => {
    await page.context().addCookies([{ name: "watch_session", value: fixture.owners[2]!.token, domain: "127.0.0.1", path: "/" }]);
    await page.goto(`/admin/products/${fixture.product}`);
    const variant = page.getByRole("form", { name: "Вариант TEST-T48", exact: true });
    await expect(variant.getByLabel("Цена для дропшиппера D (minor)")).toHaveValue("10000");
    await variant.getByLabel("Цена для дропшиппера D (minor)").fill("12000");
    await variant.getByRole("button", { name: "Сохранить вариант" }).click();
    await expect(page.getByRole("status")).toContainText("Вариант сохранён");
    await page.reload();
    await expect(variant.getByLabel("Цена для дропшиппера D (minor)")).toHaveValue("12000");
    await expect(variant.getByLabel("Legacy цена (minor)")).toHaveValue("10000");
    expect((await fixture.pool.query("SELECT price_minor,dropship_price_minor FROM product_variants")).rows[0]).toEqual({ price_minor: 10000, dropship_price_minor: 12000 });
  });

  test("a lost committed response retries with the same key without another order/reservation", async ({ page }) => {
    await form(page); await fill(page);
    let first = true;
    const keys: string[] = [];
    await page.route("**/api/v1/orders", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]!);
      if (first) { first = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
    });
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Ответ не получен" })).toBeVisible();
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("оформлен");
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(1);
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM inventory_reservations")).rows[0].n).toBe(1);
  });

  test("an exhausted SKU returns a clear server error and no order", async ({ page }) => {
    await form(page); await fill(page);
    await fixture.pool.query("UPDATE inventory_items SET safety_buffer=10");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Недостаточно товара" })).toBeVisible();
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0);
  });
});
