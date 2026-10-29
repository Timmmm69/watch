import { expect, test, type Locator } from "@playwright/test";

async function readable(locator: Locator) {
  await expect(locator).toBeVisible();
  const ratio = await locator.evaluate(element => {
    const rgb = (color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const luminance = (color: string) => rgb(color).map(n => {
      const s = n / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    let parent: Element | null = element;
    let background = "rgba(0, 0, 0, 0)";
    while (parent && background === "rgba(0, 0, 0, 0)") {
      background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement;
    }
    const values = [luminance(getComputedStyle(element).color), luminance(background)].sort((a, b) => a - b);
    return (values[1] + 0.05) / (values[0] + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

for (const colorScheme of ["light", "dark"] as const) test(`retail feedback contrast: ${colorScheme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme });
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Test" }, csrfToken: "fixture" } }));
  const item = { variantId: "test", productId: "test", slug: "test", title: "Тестовые часы", sku: "TEST", quantity: 1, priceMinor: 1000, lineTotalMinor: 1000, availability: "IN_STOCK", issues: [] as string[] };
  const cart = { id: "cart", currency: "BYN", items: [item], totalMinor: 1000, canCheckout: true };
  await page.route("**/api/v1/cart", route => route.fulfill({ json: cart }));
  await page.route("**/api/v1/legal/*/current", route => route.fulfill({ json: { id: "test", version: "v1", contentMarkdown: "Синтетический документ" } }));
  await page.goto("/checkout");
  await page.getByLabel("Имя получателя", { exact: true }).fill("Тест");
  await page.getByLabel("Телефон", { exact: true }).fill("123");
  await page.getByLabel("Адрес и детали доставки", { exact: true }).fill("Минск");
  await page.getByLabel("Принимаю текущие условия продажи").check();
  await page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности").check();
  await page.getByRole("button", { name: "Создать заказ", exact: true }).click();
  await expect(page.getByLabel("Телефон", { exact: true })).toBeFocused();
  await readable(page.locator("#phone-error"));
  cart.canCheckout = false; item.issues = ["OUT_OF_STOCK"];
  await page.goto("/cart");
  await readable(page.getByText("Артикул: TEST"));
  await readable(page.getByText("Недостаточно товара в наличии.", { exact: false }));
  await page.route("**/api/v1/cart", route => route.fulfill({ json: { ...cart, items: [] } }));
  await page.reload();
  await readable(page.getByRole("link", { name: "Выбрать товары", exact: true }));
});
