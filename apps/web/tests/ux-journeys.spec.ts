import { expect, test, type Page } from "@playwright/test";

const variantId = "00000000-0000-4000-8000-000000000001";
const partner = { id: "00000000-0000-4000-8000-000000000002", status: "ACTIVE" };
const product = { title: "Тестовые часы", slug: "test-watch", currency: "BYN", variants: [
  { id: variantId, sku: "TEST", dropshipPriceMinor: 8000, sellable: 5, availability: "IN_STOCK" }
] };
const checkout = `/checkout?mode=partner&product=test-watch&variant=${variantId}`;
const document = { id: "00000000-0000-4000-8000-000000000003", version: "v1", contentMarkdown: "Тестовые условия", effectiveAt: "2026-10-01", sha256: "a".repeat(64) };
const order = { publicNumber: "W-UX", currency: "BYN", totalMinor: 10000, remunerationTotalMinor: 2000 };
async function fixture(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Test" }, partner, nativeCommerce: true, csrfToken: "fixture" } }));
  await page.route("**/api/v1/catalog/products/test-watch*", route => route.fulfill({ json: product }));
  await page.route("**/api/v1/legal/*/current", route => route.fulfill({ json: document }));
}
async function fill(page: Page) {
  await page.getByLabel("Цена для покупателя за 1 шт., BYN").fill("100.00");
  await page.getByLabel("Имя получателя", { exact: true }).fill("Тестовый получатель");
  await page.getByLabel("Телефон", { exact: true }).fill("+375291234567");
  await page.getByLabel("Адрес доставки", { exact: true }).fill("Минск, тестовый адрес\nКвартира 10");
  await page.getByLabel("Я ознакомился с обработкой").check();
}

test("native checkout distinguishes loading, missing selection and invalid variant", async ({ page }) => {
  await fixture(page);
  await page.goto("/checkout?mode=partner");
  await expect(page.getByText("Выберите товар в каталоге, затем нажмите «Оформить заказ».")).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить загрузку", exact: true })).toHaveCount(0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/catalog/products/test-watch*", async route => { await gate; await route.fulfill({ json: product }); });
  await page.goto("/checkout?mode=partner&product=test-watch&variant=missing");
  await expect(page.getByRole("status")).toHaveText("Загрузка товара и условий…");
  release();
  await expect(page.getByText("Выберите доступный вариант товара для оформления.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeDisabled();
  await page.getByLabel("Вариант часов").selectOption(variantId);
  await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeEnabled();
});

for (const privacyChanged of [false, true]) test(`terms reacceptance preserves the form; privacy changed: ${privacyChanged}`, async ({ page }) => {
  await fixture(page);
  let submissions = 0;
  await page.route("**/api/v1/partner/orders/checkout", route => route.fulfill(++submissions === 1
    ? { status: 403, json: { error: { code: "TERMS_REACCEPT_REQUIRED" } } }
    : { status: 201, json: order }));
  await page.route("**/api/v1/partner/onboarding", route => route.fulfill({ json: {} }));
  await page.goto(checkout); await fill(page);
  await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Принять новые условия" })).toBeVisible();
  if (privacyChanged) {
    await page.route("**/api/v1/legal/PRIVACY/current", route => route.fulfill({ json: { ...document, id: "00000000-0000-4000-8000-000000000004", version: "v2" } }));
    await page.route("**/api/v1/catalog/products/test-watch*", route => route.fulfill({ json: { ...product, variants: product.variants.map(item => ({ ...item, dropshipPriceMinor: 9000 })) } }));
  }
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Принять новые условия", exact: true }).click();
  await expect(page.getByLabel("Имя получателя", { exact: true })).toHaveValue("Тестовый получатель");
  await expect(page.getByLabel("Адрес доставки", { exact: true })).toHaveValue("Минск, тестовый адрес\nКвартира 10");
  await expect(page.getByLabel("Цена для покупателя за 1 шт., BYN")).toHaveValue("100.00");
  await expect(page).toHaveURL(checkout);
  if (privacyChanged) {
    await expect(page.getByLabel("Я ознакомился с обработкой")).not.toBeChecked();
    await expect(page.getByText(/80.00 BYN → 90.00 BYN/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeDisabled();
    await page.getByLabel("Согласен с новым расчётом").check();
  }
  await page.getByLabel("Я ознакомился с обработкой").check();
  await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("№W-UX создан");
  expect(submissions).toBe(2);
});

test("document reload failure has recovery without losing the form", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/partner/orders/checkout", route => route.fulfill({ status: 409, json: { error: { code: "TERMS_VERSION_CHANGED" } } }));
  await page.goto(checkout); await fill(page);
  await page.route("**/api/v1/legal/*/current", route => route.fulfill({ status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } }));
  await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить загрузку документов" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeDisabled();
  await page.route("**/api/v1/legal/*/current", route => route.fulfill({ json: { ...document, version: "v2" } }));
  await page.getByRole("button", { name: "Повторить загрузку документов" }).click();
  await expect(page.getByText("Обработка данных · v2")).toBeVisible();
  await expect(page.getByLabel("Я ознакомился с обработкой")).not.toBeChecked();
  await expect(page.getByLabel("Имя получателя", { exact: true })).toHaveValue("Тестовый получатель");
  await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeEnabled();
});

test("native checkout refreshes stale CSRF once and keeps request identity", async ({ page }) => {
  await fixture(page);
  const attempts: { key: string; csrf: string }[] = [];
  await page.route("**/api/v1/partner/orders/checkout", route => {
    attempts.push({ key: route.request().headers()["idempotency-key"]!, csrf: route.request().headers()["x-csrf-token"]! });
    return route.fulfill(attempts.length === 1 ? { status: 403, json: { error: { code: "CSRF_INVALID" } } } : { status: 201, json: order });
  });
  await page.goto(checkout); await fill(page);
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Test" }, partner, nativeCommerce: true, csrfToken: "fresh" } }));
  await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("№W-UX создан");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual({ key: attempts[0]!.key, csrf: "fresh" });
});

test("onboarding returns to the selected checkout product", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/partner/onboarding", route => route.fulfill({ json: {} }));
  await page.goto(`/partner/onboarding?returnTo=${encodeURIComponent(checkout)}`);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Принять новые условия", exact: true }).click();
  await expect(page).toHaveURL(checkout);
  await expect(page.getByLabel("Вариант часов")).toHaveValue(variantId);
});

for (const code of ["PARTNER_BLOCKED", "USER_BLOCKED"]) test(`a new ${code} response removes order actions immediately`, async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/partner/orders/checkout", route => route.fulfill({ status: 403, json: { error: { code } } }));
  await page.goto(checkout); await fill(page);
  await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
  await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Имя получателя", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(code === "USER_BLOCKED" ? "Доступ к приложению ограничен" : "Партнёрский аккаунт заблокирован");
});
