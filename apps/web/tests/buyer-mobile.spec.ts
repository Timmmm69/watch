import { expect, test } from "@playwright/test";

for (const [width, height] of [[320, 640], [390, 844], [430, 932], [844, 390]] as const) {
  test(`Telegram buyer journey respects safe areas at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: `
      window.telegramColours=[]; window.backHandlers=[];
      window.Telegram={WebApp:{initData:'',ready(){},expand(){},isVersionAtLeast(){return true},
        setHeaderColor(c){window.telegramColours.push(c)},setBackgroundColor(c){window.telegramColours.push(c)},setBottomBarColor(c){window.telegramColours.push(c)},
        BackButton:{show(){},hide(){},onClick(h){window.backHandlers.push(h)},offClick(h){window.backHandlers=window.backHandlers.filter(v=>v!==h)}}}};
      for(const [name,value] of Object.entries({'--tg-safe-area-inset-top':'20px','--tg-content-safe-area-inset-top':'12px','--tg-safe-area-inset-bottom':'16px','--tg-content-safe-area-inset-bottom':'8px','--tg-safe-area-inset-left':'8px','--tg-safe-area-inset-right':'4px'})) document.documentElement.style.setProperty(name,value);
    ` }));
    await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Покупатель" }, csrfToken: "fixture", nativeCommerce: true } }));
    const item = { variantId: "variant", productId: "watch", slug: "classic", title: "Классические часы с длинным названием модели", sku: "WATCH-CLASSIC-EXTENDED-SKU-0123456789",
      quantity: 1, priceMinor: 15000, lineTotalMinor: 15000, availability: "IN_STOCK", issues: [] as string[] };
    const cart = { id: "cart", currency: "BYN", canCheckout: true, items: [item], totalMinor: 15000 };
    const product = { id: item.productId, slug: item.slug, title: item.title, description: "Тестовое описание", brand: "Watch", gallery: [], currency: "BYN", priceFromMinor: item.priceMinor,
      availability: "IN_STOCK", variants: [{ id: item.variantId, sku: item.sku, priceMinor: item.priceMinor, availability: "IN_STOCK" }] };
    await page.route("**/api/v1/catalog/categories", route => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/v1/catalog/products?*", route => route.fulfill({ json: { items: [product], total: 1 } }));
    await page.route(`**/api/v1/catalog/products/${item.slug}`, route => route.fulfill({ json: product }));
    await page.route("**/api/v1/cart", route => route.fulfill({ json: cart }));
    await page.route("**/api/v1/cart/items/variant", route => {
      item.quantity = route.request().postDataJSON().quantity;
      item.lineTotalMinor = cart.totalMinor = item.priceMinor * item.quantity;
      return route.fulfill({ json: cart });
    });
    await page.route("**/api/v1/legal/*/current", route => route.fulfill({ json: { id: "fixture", version: "v1", contentMarkdown: "Тестовые условия покупки" } }));
    const order = { id: "order", publicNumber: "W-MOBILE-20261031", currency: "BYN", status: "PLACED", totalMinor: 15000, createdAt: "2026-10-31T09:00:00Z", itemCount: 1 };
    await page.route("**/api/v1/checkout", route => route.fulfill({ status: 201, json: { ...order, totalMinor: cart.totalMinor } }));
    await page.route("**/api/v1/orders?*", route => route.fulfill({ json: { items: [{ ...order, totalMinor: cart.totalMinor }], total: 1, page: 1, limit: 20 } }));
    await page.route(`**/api/v1/orders/${order.publicNumber}`, route => route.fulfill({ json: { ...order, totalMinor: cart.totalMinor,
      items: [{ ...item, id: "item", unitPriceMinor: item.priceMinor, attributes: { Цвет: "Чёрный" } }],
      timeline: [{ status: "PLACED", at: order.createdAt }], fulfillment: { recipientName: "Тестовый покупатель", phone: "000000000", address: "Тестовый адрес", comment: null, redactedAt: null }, supportContact: "@fixture_shop" } }));
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const screenshot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

    await page.goto("/cart");
    await expect(page.getByRole("heading", { name: "Корзина", exact: true })).toBeVisible();
    const title = (await page.getByRole("heading", { name: "Корзина", exact: true }).boundingBox())!;
    expect(title.y).toBeGreaterThanOrEqual(32);
    await noOverflow();
    const increase = page.getByRole("button", { name: `Увеличить ${item.sku}` });
    expect((await increase.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await increase.click();
    await expect(page.getByLabel(`Количество ${item.sku}`, { exact: true }).locator("[aria-live]")).toHaveText("2");
    if (width < 768) {
      const bar = page.locator(".buyer-actionbar");
      expect(Number.parseFloat(await bar.evaluate(el => getComputedStyle(el).paddingBottom))).toBeGreaterThanOrEqual(24);
      cart.canCheckout = false; item.issues = ["OUT_OF_STOCK"];
      await page.getByRole("button", { name: "Обновить корзину" }).click();
      await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeDisabled();
      const note = page.getByText("Получателя и адрес укажете на следующем шаге.");
      await expect.poll(async () => {
        const padding = await page.getByRole("main").evaluate(el => Number.parseFloat(getComputedStyle(el).paddingBottom));
        return padding - (await bar.boundingBox())!.height;
      }).toBeGreaterThanOrEqual(32);
      await note.evaluate(el => el.scrollIntoView({ block: "end" }));
      await expect.poll(async () => (await note.boundingBox())!.y + (await note.boundingBox())!.height <= (await bar.boundingBox())!.y + 1).toBe(true);
      cart.canCheckout = true; item.issues = [];
      await page.getByRole("button", { name: "Обновить корзину" }).click();
      await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeEnabled();
    }
    await screenshot("01-cart");
    await page.getByRole("button", { name: "Оформить заказ", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Оформление заказа", exact: true })).toBeVisible();
    await page.getByLabel("Имя получателя", { exact: true }).fill("Тестовый покупатель");
    await page.getByLabel("Телефон", { exact: true }).fill("375291234567");
    await page.setViewportSize({ width, height: Math.min(height, 420) });
    await page.getByLabel("Адрес и детали доставки", { exact: true }).fill("Минск, тестовый адрес");
    await expect(page.getByLabel("Телефон", { exact: true })).toHaveValue("375291234567");
    await noOverflow();
    await page.setViewportSize({ width, height });
    await page.getByLabel("Принимаю текущие условия продажи").check();
    await page.getByLabel("Ознакомлен(а) с текущей политикой конфиденциальности").check();
    await screenshot("02-checkout");
    await page.getByRole("button", { name: "Создать заказ", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Заказ создан", exact: true })).toBeVisible();
    await noOverflow(); await screenshot("03-success");
    await page.getByRole("link", { name: "Посмотреть заказ", exact: true }).click();
    await expect(page.getByRole("heading", { name: `Заказ ${order.publicNumber}`, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "История статусов", exact: true })).toBeVisible();
    await noOverflow(); await screenshot("04-order");
    await page.getByRole("link", { name: "Все заказы", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Мои заказы", exact: true })).toBeVisible();
    if (width < 768) {
      await expect(page.getByRole("navigation", { name: "Навигация покупателя", exact: true }).getByRole("link", { name: "Заказы", exact: true })).toHaveAttribute("aria-current", "page");
      await page.getByLabel("Статус", { exact: true }).selectOption("PLACED");
      await expect(page.getByRole("navigation", { name: "Навигация покупателя", exact: true })).toBeVisible();
    }
    await noOverflow(); await screenshot("05-orders");
    await page.getByRole("link", { name: "В каталог", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Каталог часов", exact: true })).toBeVisible();
    if (width < 768) {
      await page.getByLabel("Поиск товаров", { exact: true }).focus();
      await expect(page.getByRole("navigation", { name: "Навигация покупателя", exact: true })).not.toBeVisible();
      await page.getByLabel("Поиск товаров", { exact: true }).blur();
      await expect(page.getByRole("navigation", { name: "Навигация покупателя", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: new RegExp(item.title) }).click();
    await expect(page.getByRole("button", { name: "← Все товары", exact: true })).toBeVisible();
    await page.evaluate(() => (window as Window & { backHandlers: Array<() => void> }).backHandlers.at(-1)!());
    await expect(page.getByRole("heading", { name: "Каталог часов", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as Window & { backHandlers: unknown[] }).backHandlers.length)).toBe(0);
    expect(await page.evaluate(() => (window as Window & { telegramColours: string[] }).telegramColours)).toEqual(expect.arrayContaining(["#ffffff"]));
  });
}
