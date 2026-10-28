import { expect, test } from "@playwright/test";

for (const [status, code, message] of [
  [403, "USER_BLOCKED", "Доступ к приложению ограничен"],
  [401, "SESSION_EXPIRED", "Срок входа истёк"],
  [503, "DEPENDENCY_UNAVAILABLE", "Не удалось связаться с приложением"]
] as const) test(`login distinguishes ${code} and recovers after retry`, async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ status, json: { error: { code } } }));
  await page.goto("/shop");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(message);
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Test" }, csrfToken: "test", nativeCommerce: true, partner: null } }));
  await page.route("**/api/v1/catalog/categories", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/catalog/products?*", route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.getByRole("button", { name: "Повторить вход" }).click();
  await expect(page.getByRole("heading", { name: "Каталог часов" })).toBeVisible();
});

for (const contact of ["https://shop.example/support", "Контакт магазина: уточните в том же чате Telegram", "javascript:alert(1)"]) {
  test(`buyer has an honest contact and copy fallback: ${contact}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } }); });
    await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "ОченьдлинноеимяпокупателяБезПробеловДляПроверкиПереноса" }, csrfToken: "test", nativeCommerce: true, supportContact: contact } }));
    await page.route("**/api/v1/catalog/categories", route => route.fulfill({ json: { items: [] } }));
    const product = { id: "test", slug: "long-watch", title: "Длинное название тестовой модели часов для проверки переноса", description: "", currency: "BYN", priceFromMinor: 12345678, availability: "IN_STOCK", gallery: [], variants: [{ id: "variant", sku: "LONG-TEST", priceMinor: 12345678, availability: "IN_STOCK" }] };
    await page.route("**/api/v1/catalog/products?*", route => route.fulfill({ json: { items: [product], total: 1 } }));
    await page.route("**/api/v1/catalog/products/long-watch", route => route.fulfill({ json: product }));
    await page.goto("/shop");
    await page.getByRole("button", { name: /Длинное название тестовой модели/ }).click();
    await page.getByRole("button", { name: "Скопировать запрос" }).click();
    await expect(page.getByRole("status")).toContainText("Не удалось скопировать");
    await expect(page.getByText(/Здравствуйте! Хочу уточнить покупку часов/)).toBeVisible();
    const action = page.getByRole("link", { name: "Уточнить и заказать" });
    if (contact.startsWith("https:")) await expect(action).toHaveAttribute("href", contact);
    else { await expect(action).toHaveCount(0); await expect(page.getByText(contact, { exact: false })).toBeVisible(); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
