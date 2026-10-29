import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) test(`retail journey: ${colorScheme}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme });
  const variants = [
    { id: "silver", sku: "WATCH-SILVER", priceMinor: 10000, availability: "IN_STOCK" },
    { id: "black", sku: "WATCH-BLACK", priceMinor: 12000, availability: "IN_STOCK" }
  ];
  const product = { id: "watch", slug: "watch", title: "Тестовые часы", description: "Описание тестовых часов",
    brand: "Watch", currency: "BYN", priceFromMinor: 10000, availability: "IN_STOCK", gallery: [], variants };
  let quantity = 0;
  const cart = () => ({ id: "cart", currency: "BYN", canCheckout: quantity > 0, totalMinor: quantity * 12000,
    items: quantity ? [{ variantId: "black", productId: "watch", slug: "watch", title: product.title, sku: "WATCH-BLACK",
      quantity, priceMinor: 12000, lineTotalMinor: quantity * 12000, availability: "IN_STOCK", issues: [] }] : [] });
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: {
    user: { firstName: "Покупатель" }, csrfToken: "fixture", supportContact: "@fixture_shop", nativeCommerce: true
  } }));
  await page.route("**/api/v1/catalog/categories", route => route.fulfill({ json: { items: [{ id: "watches", name: "Часы", slug: "watches" }] } }));
  await page.route("**/api/v1/catalog/products?*", route => route.fulfill({ json: { items: [product], total: 1 } }));
  await page.route("**/api/v1/catalog/products/watch*", route => route.fulfill({ json: product }));
  await page.route("**/api/v1/cart", route => route.fulfill({ json: cart() }));
  await page.route("**/api/v1/cart/items/black", route => {
    expect(route.request().method()).toBe("PUT");
    quantity = route.request().postDataJSON().quantity;
    return route.fulfill({ json: cart() });
  });
  await page.route("**/api/v1/legal/*/current", route => route.fulfill({ json: {
    id: "fixture", version: "v1", contentMarkdown: "Синтетический документ"
  } }));
  let submissions = 0;
  await page.route("**/api/v1/checkout", route => {
    const body = route.request().postDataJSON();
    expect(body.items).toEqual([{ variantId: "black", quantity: 2, expectedUnitPriceMinor: 12000 }]);
    expect(body.salesTermsAccepted).toBe(true);
    expect(body.privacyAcknowledged).toBe(true);
    submissions++;
    return route.fulfill({ status: 201, json: { publicNumber: "W-FIXTURE", status: "PLACED", currency: "BYN", totalMinor: 24000 } });
  });
  const screenshot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

  await page.goto("/shop");
  await expect(page.getByLabel("Поиск товаров")).toBeVisible();
  await page.getByRole("button", { name: "Часы", exact: true }).click();
  await page.getByLabel("Поиск товаров").fill("Тестовые");
  await page.getByRole("button", { name: "Найти товары" }).click();
  const card = page.getByRole("button", { name: /Тестовые часы/ });
  await expect(card).toBeVisible();
  await screenshot("01-catalog");
  await card.click();

  const actions = page.getByRole("group", { name: "Действия с товаром" });
  await expect(actions.getByRole("button", { name: "Добавить в корзину" })).toBeEnabled();
  expect((await actions.boundingBox())!.height).toBeLessThanOrEqual(100);
  const contact = page.getByRole("region", { name: "Связь с магазином" }).first();
  await contact.evaluate(element => element.scrollIntoView({ block: "center" }));
  const contactBox = (await contact.boundingBox())!;
  expect(contactBox.y + contactBox.height).toBeLessThanOrEqual((await actions.boundingBox())!.y);
  await expect(contact.getByText(/Здравствуйте!/)).toContainText("WATCH-SILVER");
  await expect(contact.getByRole("link", { name: "Задать вопрос магазину" })).toHaveAttribute("href", /text=.*WATCH-SILVER/);
  await screenshot("02-detail");
  await page.getByLabel("Вариант товара").scrollIntoViewIfNeeded();
  await page.getByLabel("Вариант товара").selectOption("black");
  const selectBox = (await page.getByLabel("Вариант товара").boundingBox())!;
  expect(selectBox.y + selectBox.height).toBeLessThanOrEqual((await actions.boundingBox())!.y);
  await actions.getByRole("button", { name: "Добавить в корзину" }).click();
  await expect(page.getByRole("status")).toHaveText("Добавлено в корзину.");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(actions).toHaveCSS("position", "static");
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect((await actions.boundingBox())!.height).toBeLessThanOrEqual(100);
  await page.setViewportSize({ width: 390, height: 844 });
  await actions.getByRole("link", { name: "Корзина (1)" }).click();

  await expect(page.getByText("Артикул: WATCH-BLACK")).toBeVisible();
  await page.getByRole("button", { name: "Увеличить WATCH-BLACK" }).click();
  await expect(page.getByLabel("Количество WATCH-BLACK", { exact: true }).locator("[aria-live]")).toHaveText("2");
  await expect(page.getByText(/Итого:/)).toContainText("240");
  await screenshot("03-cart");
  await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();

  const submit = page.getByRole("button", { name: "Создать заказ", exact: true });
  await expect(submit).toBeDisabled();
  await expect(page.getByRole("region", { name: "Состав заказа" })).toContainText("WATCH-BLACK · 2 шт.");
  await screenshot("04-checkout");
  await page.getByLabel("Имя получателя", { exact: true }).fill("Тестовый покупатель");
  await page.getByLabel("Телефон", { exact: true }).fill("+375291234567");
  await page.getByLabel("Адрес и детали доставки", { exact: true }).fill("Минск, тестовый адрес");
  await page.getByLabel("Принимаю текущие условия продажи").check();
  await expect(submit).toBeDisabled();
  await page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности").check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("heading", { name: "Заказ создан" })).toBeVisible();
  await expect(page.getByText("Статус: Оформлен", { exact: true })).toBeVisible();
  await expect(page.getByText(/PLACED/)).toHaveCount(0);
  expect(submissions).toBe(1);
  await screenshot("05-success");
});
